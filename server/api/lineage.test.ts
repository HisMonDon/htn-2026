import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AriadneEdge, AriadneResponse, type AriadneRequest } from "../../shared/ariadne";
import { BibliographySourceProposer } from "../gptzero/bibliography";
import { extractDocument } from "../research/extract";
import { CorpusFetcher, toAuditMetadata, type PageFetcher } from "../research/providers";
import { traverseProvenance, type TraverseProvenanceDeps, type UpstreamSourceProposer } from "../research/traversal";
import { harness, type Harness } from "../test-helpers";
import { createApi } from "./app";
import { createLineageController, type LineageController } from "./lineage";
import { compatibilityTree, serializeTraversal } from "./lineage-response";

const a = "https://synthetic.test/downstream";
const b = "https://synthetic.test/upstream";
const c = "https://synthetic.test/original";
const unrelated = "https://synthetic.test/unrelated";
const missing = "https://synthetic.test/missing";
const shared = "United States v. Lumen established a peculiar amber lantern exception for supervised release.";
const fabricated = ["United States v. Lumen"];
const request: AriadneRequest = { claim: shared, seed_url: a, fabricated_citations: fabricated };
const fixedNow = () => new Date("2026-09-19T12:00:00.000Z");
const secret = "sk-private-api-key-do-not-expose";

function page(url: string, title: string, date: string, text: string, links: string[] = []) {
  return { url, html: `<html><head><title>${title}</title><meta property="article:published_time" content="${date}" /></head><body><article><p>${text}</p>${links.map((x) => `<a href="${x}">Source document</a>`).join("")}</article></body></html>` };
}

const pages = [
  page(a, "Downstream report", "2024-03-03", `${shared} The ruling now supposedly applies to every petitioner nationwide.`, [b]),
  page(b, "Upstream report", "2024-03-02", `${shared} Researchers reviewed only a small local sample.`, [c]),
  page(c, "Original report", "2024-03-01", `${shared} The analysis concerned a single petitioner.`),
  page(unrelated, "Unrelated gardening report", "2024-02-01", "Spring flowers bloom beside vegetable gardens where gardeners compost leaves and water tomatoes."),
];

function proposer(routes = new Map([[a, [b]], [b, [c]]])): UpstreamSourceProposer {
  return { analyze: vi.fn(async (document) => (routes.get(document.url) ?? []).map((x) => ({ url: x }))) };
}

let h: Harness;
let servers: Server[];

beforeEach(async () => {
  h = await harness();
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((x) => new Promise<void>((resolve) => x.close(() => resolve()))));
  await h.close();
});

async function start(deps: TraverseProvenanceDeps, mode: "live" | "mock" = "mock", clock = fixedNow, override?: LineageController) {
  const lineage = override ?? createLineageController(deps, mode, clock);
  const handle = createApi(h.service, { mocks: mode === "mock", operator: "offline-heuristic", detector: "mock", controlled_target_url: h.target.url }, { lineage });
  const server = createServer((req, res) => void handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    lineage,
    async post(body: unknown = request, path = "/api/research") {
      return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    async get(id: string) {
      return fetch(`${base}/api/research/${id}`);
    },
  };
}

async function parsed(response: Response) {
  expect(response.status).toBe(200);
  return AriadneResponse.parse(await response.json());
}

describe("recursive research HTTP contract", () => {
  it("runs the same traversal and retains validated edges, mutations and inspectable evidence", async () => {
    const deps = { proposer: proposer(), fetcher: new CorpusFetcher(pages) };
    const api = await start(deps);
    const body = await parsed(await api.post());
    const seed = extractDocument({ ...pages[0]!, fabricated, claimTerms: [], discoveredVia: "api-seed" });
    const direct = await traverseProvenance({ seed, claim: shared, fabricated }, deps);
    expect(body.status).toBe("complete");
    expect(body.execution).toEqual({ proposer: "mock", fallbacks: [], provenance_mode: "strict" });
    expect(body.edges).toHaveLength(2);
    expect(body.tree.edges).toHaveLength(direct.accepted_edges.length);
    for (const [index, x] of body.edges.entries()) {
      expect(x.status).toBe("validated");
      if (x.status !== "validated") throw new Error("expected a validated edge");
      expect(x.ariadne_score).toBe(direct.accepted_edges[index]!.confidence);
      expect(x.claim_mutations).toEqual(direct.accepted_edges[index]!.claim_mutations);
      expect(x.claim_mutations.length).toBeGreaterThan(0);
      expect(x.evidence.temporal).toEqual(direct.accepted_edges[index]!.temporal);
      expect(x.evidence.shared_mutations).toEqual(fabricated);
      expect(x.inspection?.signals.map((x) => x.id)).toEqual(expect.arrayContaining(["explicit_link", "shared_fabrications", "shared_phrasing", "passage_overlap", "chronology", "canonical_metadata", "distinct_artifact"]));
      expect(x.inspection?.evidence.matched_links.length).toBeGreaterThan(0);
      expect(x.inspection?.evidence.parent.passage).toBeTruthy();
      expect(x.inspection?.evidence.child.passage).toBeTruthy();
      expect(x).not.toHaveProperty("confidence");
    }
    expect(await parsed(await api.get(body.id))).toEqual(body);
  });

  it("runs the actual GPTZero bibliography mapping over deterministic production-shaped responses", async () => {
    const scans: string[] = [];
    const build = (relevance: number) => new BibliographySourceProposer(secret, {
      fetchImpl: async (_url, init) => {
        const text = JSON.parse(String(init?.body)).document as string;
        scans.push(text);
        const urls = text.includes("nationwide") ? [b, unrelated] : text.includes("local sample") ? [c] : [];
        return Response.json({
          id: "synthetic-scan", version: 2, bibliographic_citations: [], claims: [], raw: {}, inputText: text,
          sources: urls.map((x, index) => ({
            id: index, citation_id: null, claim_id: null, sourcerer_name: "synthetic", citation_object: {}, authors: [], url: x,
            relevance_score: relevance, citations: { apa: "", bibtex: "", chicago: "", ieee: "", mla: "" }, title: "Synthetic source",
            citation_match: null, content: "AUDIT_ONLY", date: "", justification: secret, relevance_justification: null,
            relevant_chunk: "AUDIT_ONLY", stance: "AUDIT_ONLY", confidence: relevance,
          })),
        });
      },
    });
    const first = await start({ proposer: build(0.999), fetcher: new CorpusFetcher(pages) }, "live");
    const second = await start({ proposer: build(0.001), fetcher: new CorpusFetcher(pages) }, "live");
    const high = await parsed(await first.post());
    const low = await parsed(await second.post());
    expect(high.execution.proposer).toBe("live");
    expect(scans.length).toBeGreaterThanOrEqual(6);
    expect(high.edges).toEqual(low.edges);
    expect(high.edges.filter((x) => x.status === "validated")).toHaveLength(2);
    expect(high.edges.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect(JSON.stringify(high)).not.toMatch(/AUDIT_ONLY|relevance_score|proposer_confidence|sk-private-api-key/);
  });

  it("keeps rejected proposals rejected even with high opaque provider scores", async () => {
    const api = await start({
      fetcher: new CorpusFetcher(pages),
      proposer: { analyze: async () => [{ url: unrelated, metadata: toAuditMetadata({ confidence: 1, relevance_score: 1 }) }] },
    });
    const body = await parsed(await api.post());
    expect(body.status).toBe("complete");
    expect(body.edges).toEqual([expect.objectContaining({ status: "rejected", termination: "validation-rejected" })]);
    expect(body.tree.edges).toEqual([]);
    expect(body.tree.nodes).toHaveLength(1);
  });

  it("preserves candidates as candidates and excludes them from the accepted compatibility graph", async () => {
    const deps = { proposer: proposer(new Map()), fetcher: new CorpusFetcher(pages) };
    const controller = createLineageController(deps, "mock", fixedNow);
    const body = await controller.create(request);
    body.edges.push(AriadneEdge.parse({ id: "pending-edge", source: null, target: body.root.id, reference_url: b, status: "candidate", reason: "Awaiting acquisition", confidence: 1, ariadne_score: 1 }));
    body.tree = compatibilityTree(body, request, body.tree.stats, fixedNow().toISOString());
    const api = await start(deps, "mock", fixedNow, { ...controller, create: async () => body });
    const result = await parsed(await api.post());
    expect(result.edges[0]).toEqual({ id: "pending-edge", source: null, target: body.root.id, reference_url: b, status: "candidate", reason: "Awaiting acquisition" });
    expect(result.tree.edges).toEqual([]);
  });

  it("returns a partial graph when continuation acquisition fails", async () => {
    const api = await start({ proposer: proposer(new Map([[a, [b]], [b, [c]], [c, [missing]]])), fetcher: new CorpusFetcher(pages) });
    const body = await parsed(await api.post());
    expect(body.status).toBe("partial");
    expect(body.tree.status).toBe("partial");
    expect(body.tree.edges).toHaveLength(2);
    expect(body.edges).toContainEqual(expect.objectContaining({ status: "rejected", source: null, termination: "fetch-failure" }));
    expect(body.warnings).toContainEqual(expect.objectContaining({ stage: "fetch", source: missing, category: "http-404" }));
    expect(body.errors).toEqual([]);
  });

  it("returns a normalized failed result for seed acquisition failures", async () => {
    const analyze = vi.fn(async () => []);
    const api = await start({ proposer: { analyze }, fetcher: new CorpusFetcher(pages) });
    const body = await parsed(await api.post({ claim: shared, seed_url: missing }));
    expect(body.status).toBe("failed");
    expect(body.root.url).toBe(missing);
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.errors).toContainEqual(expect.objectContaining({ stage: "fetch", category: "http-404" }));
    expect(analyze).not.toHaveBeenCalled();
  });

  it("does not expose provider error bodies, stacks or authorization details", async () => {
    const api = await start({
      proposer: { analyze: async () => { throw new Error(`Authorization: Bearer ${secret}\n at private.ts:42`); } },
      fetcher: new CorpusFetcher(pages),
    }, "live");
    const body = await parsed(await api.post());
    expect(body.status).toBe("failed");
    expect(body.nodes).toHaveLength(1);
    expect(body.errors[0]?.category).toBe("provider-failure");
    expect(body.terminations[0]?.detail).toBe("Upstream proposal analysis failed.");
    expect(JSON.stringify(body)).not.toMatch(/Bearer|Authorization|private\.ts|sk-private-api-key|stack/);
  });

  it("sanitizes acquisition diagnostics and source URLs", async () => {
    const fetcher: PageFetcher = {
      fetch: async () => null,
      fetchDetailed: async (url) => ({ ok: false, failure: { stage: "fetch", category: "http-error", message: `Authorization ${secret}`, recoverable: false, status: 418, url } }),
    };
    const api = await start({ proposer: proposer(), fetcher });
    const body = await parsed(await api.post({ claim: shared, seed_url: `${missing}?api_key=${secret}` }));
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.errors[0]?.source).toBe(missing);
  });

  it("keeps a failed proposal's URL separate from its bibliographic label", async () => {
    const api = await start({
      proposer: {
        analyze: async (document) => document.url === a
          ? [{ url: missing, title: "UNITED STATES DISTRICT COURT - Justia News" }]
          : [],
      },
      fetcher: new CorpusFetcher(pages),
    });

    const body = await parsed(await api.post());
    const rejected = body.edges.find((edge) => edge.status === "rejected" && edge.termination === "fetch-failure");

    expect(rejected?.reference_url).toBe(missing);
    expect(body.errors).toContainEqual(expect.objectContaining({ stage: "fetch", source: missing, category: "http-404" }));
  });

  it("retains specific PDF extraction failure categories", async () => {
    const api = await start({
      proposer: proposer(),
      fetcher: { fetch: async (url) => ({ url, kind: "pdf", bytes: new TextEncoder().encode("invalid PDF") }) },
    });
    const body = await parsed(await api.post());
    expect(body.status).toBe("failed");
    expect(body.errors[0]).toMatchObject({ stage: "extraction", category: "pdf-invalid", message: "The source is not a valid PDF." });
  });

  it("retains cached fallback provenance and capture time across partial results and resume", async () => {
    let pending = true;
    const capturedAt = "2026-09-18T00:00:00.000Z";
    const api = await start({
      fetcher: new CorpusFetcher(pages),
      proposer: { analyze: async (document) => {
        if (document.url === a) return { status: "completed", proposals: [{ url: b }], fallback: { provenance: "cached_demo_fallback", capturedAt } };
        if (document.url === b && pending) { pending = false; return { status: "pending", job_id: secret, retry_after_ms: 0 }; }
        return document.url === b ? [{ url: c }] : [];
      } },
    }, "live");
    const paused = await parsed(await api.post());
    expect(paused.status).toBe("partial");
    expect(paused.execution.proposer).toBe("cached_demo_fallback");
    expect(paused.execution.fallbacks).toEqual([{ source_id: paused.root.id, captured_at: capturedAt }]);
    expect(paused.tree.edges).toHaveLength(1);
    expect(paused.warnings.some((x) => x.category === "cached_demo_fallback")).toBe(true);
    expect(JSON.stringify(paused)).not.toContain(secret);
    const resumed = await parsed(await api.post({}, paused.resume_url!));
    expect(resumed.status).toBe("complete");
    expect(resumed.id).toBe(paused.id);
    expect(resumed.tree.edges).toHaveLength(2);
    expect(resumed.execution).toEqual(paused.execution);
    expect(resumed.resume_url).toBeNull();
  });

  it("preserves a valid chain if a later proposer fails", async () => {
    const api = await start({ fetcher: new CorpusFetcher(pages), proposer: { analyze: async (document) => {
      if (document.url === a) return [{ url: b }];
      throw new Error(secret);
    } } });
    const body = await parsed(await api.post());
    expect(body.status).toBe("partial");
    expect(body.tree.edges).toHaveLength(1);
    expect(body.warnings[0]?.category).toBe("provider-failure");
  });

  it("enforces request-budget pauses and the advertised resume delay", async () => {
    let time = fixedNow().getTime();
    const api = await start({ proposer: proposer(), fetcher: new CorpusFetcher(pages) }, "mock", () => new Date(time));
    const paused = await parsed(await api.post({ ...request, max_provider_requests: 1 }));
    expect(paused.status).toBe("partial");
    expect(paused.pending[0]?.reason).toBe("rate-limit");
    expect((await api.post({}, paused.resume_url!)).status).toBe(429);
    time += 60000;
    const resumed = await parsed(await api.post({}, paused.resume_url!));
    expect(resumed.tree.edges).toHaveLength(2);
  });

  it("accepts claim-only and explicit text submissions without inventing dates or links", async () => {
    const analyze = vi.fn(async () => []);
    const api = await start({ proposer: { analyze }, fetcher: new CorpusFetcher(pages) });
    for (const x of [{ claim: shared }, { claim: shared, seed_text: "Some longer submitted source text." }]) {
      const body = await parsed(await api.post(x));
      expect(body.root.date).toBeNull();
      expect(body.root.url).toBeNull();
      expect(body.root.text).toBe(x.seed_text ?? x.claim);
      expect(body.nodes[0]?.source_kind).toBe("submitted");
      expect(body.nodes[0]?.outbound_links).toEqual([]);
    }
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("uses an acquired claim candidate as a traversal root without validating the discovery relationship", async () => {
    const analyze = vi.fn(async (document) => {
      if (document.discovered_via.includes("submitted-text")) return [{ url: b }];
      return document.url === b ? [{ url: c }] : [];
    });
    const api = await start({ proposer: { analyze }, fetcher: new CorpusFetcher(pages) });

    const body = await parsed(await api.post({ claim: shared }));
    const candidate = body.edges.find((edge) => edge.status === "candidate");
    const validated = body.edges.filter((edge) => edge.status === "validated");

    expect(candidate).toEqual(expect.objectContaining({
      status: "candidate",
      source: expect.any(String),
      target: body.root.id,
      reference_url: b,
      reason: expect.stringContaining("not validated provenance"),
    }));
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({ reference_url: c, target: candidate?.source });
    expect(validated.every((edge) => edge.target !== body.root.id)).toBe(true);
    expect(analyze.mock.calls.map(([document]) => document.url)).toEqual(expect.arrayContaining([b, c]));
    expect(body.terminations).toContainEqual(expect.objectContaining({ reason: "candidate-roots", source_id: body.root.id }));
    expect(body.tree.edges).toHaveLength(1);
    expect(body.tree.edges[0]).toMatchObject({ parent_id: validated[0]?.source, child_id: candidate?.source });
  });

  it("recurses from both mocked Cohen candidates while preserving their claim links as discovery only", async () => {
    const claim = "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.";
    const reason = "https://reason.test/volokh/cohen-bard";
    const filing = "https://business.cch.test/cohen/order-to-show-cause";
    const motion = "https://sdny.test/cohen/motion";
    const cohenPages = [
      page(reason, "Reason / Volokh: Cohen and Bard", "2023-12-13", "The article discusses the Cohen motion and links to the court filing.", [filing]),
      page(filing, "SDNY order to show cause", "2023-12-12", "The court filing identifies the three authorities in the motion.", [motion]),
      page(motion, "Cohen motion", "2023-11-29", "The motion cites the disputed cases."),
    ];
    const analyze = vi.fn(async (document) => {
      if (document.discovered_via.includes("submitted-text")) return [{ url: reason }, { url: filing }];
      if (document.url === reason) return [{ url: filing }];
      if (document.url === filing) return [{ url: motion }];
      return [];
    });
    const api = await start({ proposer: { analyze }, fetcher: new CorpusFetcher(cohenPages) });

    const body = await parsed(await api.post({ claim }));
    const candidates = body.edges.filter((edge) => edge.status === "candidate");
    const validated = body.edges.filter((edge) => edge.status === "validated");

    expect(candidates.map((edge) => edge.reference_url).sort()).toEqual([filing, reason].sort());
    expect(validated).toHaveLength(2);
    expect(validated.every((edge) => edge.target !== body.root.id)).toBe(true);
    expect(body.nodes.map((node) => node.url)).toEqual(expect.arrayContaining([reason, filing, motion]));
    expect(analyze.mock.calls.map(([document]) => document.url)).toEqual(expect.arrayContaining([reason, filing, motion]));
    expect(body.terminations).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: reason, reason: "accepted-parents" }),
      expect.objectContaining({ url: filing, reason: "accepted-parents" }),
    ]));
    expect(body.warnings).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.pending).toEqual([]);
  });

  it("validates requests and keeps execution mode server-owned", async () => {
    const api = await start({ proposer: proposer(), fetcher: new CorpusFetcher(pages) });
    for (const x of [{}, { claim: " " }, { ...request, seed_text: "extra" }, { claim: shared, seed_url: "file:///secret" }, { ...request, max_depth: 11 }, { ...request, max_provider_requests: 11 }, { ...request, proposer: "mock" }, { claim: shared, seed_source: {} }]) {
      expect((await api.post(x)).status).toBe(400);
    }
    expect((await api.get("unknown")).status).toBe(404);
  });

  it("retains the traversal score even when supplementary inspection differs", async () => {
    const seed = extractDocument({ ...pages[0]!, fabricated, claimTerms: [], discoveredVia: "api-seed" });
    const direct = await traverseProvenance({ seed, claim: shared, fabricated }, { proposer: proposer(), fetcher: new CorpusFetcher(pages) });
    direct.accepted_edges[0]!.confidence = 0.456;
    const body = serializeTraversal(direct, { id: "synthetic", input: request, seed, execution: { proposer: "mock", fallbacks: [], provenance_mode: "strict" }, generatedAt: fixedNow().toISOString() });
    expect(body.edges[0]).toMatchObject({ status: "validated", ariadne_score: 0.456, score_method: "traversal-scoreEdge" });
    expect(body.tree.edges[0]?.confidence).toBe(0.456);
  });
});
