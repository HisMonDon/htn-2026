import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AriadneResponse, type AriadneRequest } from "../../shared/ariadne";
import { createApi } from "../api/app";
import { createLineageController } from "../api/lineage";
import { CorpusFetcher } from "../research/providers";
import { harness, type Harness } from "../test-helpers";
import { BibliographySourceProposer } from "./bibliography";
import { ClaimFallbackProposer, type CompositionEvent } from "./composition";
import sample from "./fixtures/relevant-sources-sample.json" with { type: "json" };
import { ClaimSourceProposer } from "./relevant-sources";

/**
 * The claim-level endpoint through the real `POST /api/research` path: no second API route, no
 * frontend-visible signal of which GPTZero endpoint supplied a candidate, and the same normalized
 * Ariadne response contract. Only the two external provider responses are stubbed; acquisition,
 * validation, traversal and mutation analysis all execute for real.
 */

const a = "https://synthetic.test/downstream";
const b = "https://synthetic.test/upstream";
const shared = "United States v. Lumen established a peculiar amber lantern exception for supervised release.";
const fabricated = ["United States v. Lumen"];
const request: AriadneRequest = { claim: shared, seed_url: a, fabricated_citations: fabricated };
const fixedNow = () => new Date("2026-09-19T12:00:00.000Z");

function page(url: string, title: string, date: string, text: string) {
  return { url, html: `<html><head><title>${title}</title><meta property="article:published_time" content="${date}" /></head><body><article><p>${text}</p></article></body></html>` };
}

const pages = [
  page(a, "Downstream report", "2024-03-03", `${shared} The ruling now supposedly applies to every petitioner nationwide.`),
  page(b, "Upstream report", "2024-03-02", `${shared} Researchers reviewed only a small local sample.`),
];

/** A production-shaped bibliography scan that proposed nothing: GPTZero filtered the claim. */
const emptyScan = {
  id: "scan_empty",
  version: 2,
  inputText: shared,
  claims: [],
  bibliographic_citations: [],
  sources: [],
  raw: { reference_map: { bibliographic_citations: [], intext_citations: [] }, uncited_claims: [] },
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

function composedProposer(events: CompositionEvent[], calls: { bibliography: number; claim: number }) {
  const bibliography = new BibliographySourceProposer("test-key", {
    fetchImpl: (async () => {
      calls.bibliography += 1;
      return json(emptyScan);
    }) as unknown as typeof fetch,
  });
  const claim = new ClaimSourceProposer("test-key", {
    fetchImpl: (async () => {
      calls.claim += 1;
      // Only the first claim-level request proposes the upstream page; later hops find nothing.
      if (calls.claim > 1) return json({ sources: [] });
      return json({
        sources: [
          { ...sample.response.sources[0], url: b, title: "Upstream report", citation_object: { ...sample.response.sources[0]!.citation_object, url: b } },
          // The same candidate again, exactly as a live response can repeat one.
          { ...sample.response.sources[1], url: `${b}/`, title: "Upstream report" },
        ],
      });
    }) as unknown as typeof fetch,
  });
  return new ClaimFallbackProposer(bibliography, claim, { defaultLimit: 10, onComposition: (event) => events.push(event) });
}

async function start(proposer: ClaimFallbackProposer) {
  const lineage = createLineageController({ proposer, fetcher: new CorpusFetcher(pages) }, "live", fixedNow);
  const handle = createApi(h.service, { mocks: false, operator: "offline-heuristic", detector: "mock", controlled_target_url: h.target.url }, { lineage });
  const server = createServer((req, res) => void handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (body: unknown = request) =>
    fetch(`${base}/api/research`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/research with the claim-level endpoint behind the proposer abstraction", () => {
  it("recovers an upstream source the bibliography scan filtered out, through the unchanged contract", async () => {
    const events: CompositionEvent[] = [];
    const calls = { bibliography: 0, claim: 0 };
    const post = await start(composedProposer(events, calls));

    const response = await post();
    expect(response.status).toBe(200);
    const body = AriadneResponse.parse(await response.json());

    expect(body.status).toBe("complete");
    expect(body.edges).toHaveLength(1);
    const [edge] = body.edges;
    expect(edge!.status).toBe("validated");
    expect(body.nodes.map((node) => node.url)).toContain(b);
    // The edge's score is the deterministic traversal's, never the provider's 0.98 relevance.
    if (edge!.status !== "validated") throw new Error("expected a validated edge");
    expect(edge!.ariadne_score).not.toBe(0.98);
    expect(edge!.ariadne_score).toBeGreaterThan(0);

    // Both endpoints were consulted for the seed, and only because the first proposed nothing.
    expect(events[0]).toMatchObject({ strategy: "claim-fallback", bibliography_proposals: 0, claim_proposals: 2, duplicates_removed: 1 });
    expect(calls).toEqual({ bibliography: 2, claim: 2 });
  });

  it("leaks no provider-side assessment into the serialized response", async () => {
    const post = await start(composedProposer([], { bibliography: 0, claim: 0 }));
    const text = await (await post()).text();
    expect(text).not.toMatch(/relevance_score|relevance_justification|reliability_score|opensearch_rank|sourcerer_name|synthetic_serp|contradict|Provider-only assessment/);
    expect(text).not.toMatch(/0\.98|proposer_confidence/);
  });

  it("keeps the execution block stable and says nothing about which GPTZero endpoint was used", async () => {
    const post = await start(composedProposer([], { bibliography: 0, claim: 0 }));
    const body = AriadneResponse.parse(await (await post()).json());
    expect(body.execution).toEqual({ proposer: "live", fallbacks: [], provenance_mode: "strict" });
  });

  it("does not issue a claim-level request when the bibliography scan already proposed candidates", async () => {
    const calls = { bibliography: 0, claim: 0 };
    const bibliography = new BibliographySourceProposer("test-key", {
      fetchImpl: (async () => {
        calls.bibliography += 1;
        return json({
          ...emptyScan,
          sources: calls.bibliography > 1
            ? []
            : [
                {
                  id: 0, citation_id: null, claim_id: null, sourcerer_name: "production-source",
                  citation_object: { title: "Upstream report", url: b }, authors: [], url: b,
                  relevance_score: 0.9,
                  citations: { apa: "", bibtex: "", chicago: "", ieee: "", mla: "" },
                  title: "Upstream report", citation_match: null, content: "", date: "2024-03-02",
                  justification: null, relevance_justification: null, relevant_chunk: null, stance: "supports",
                },
              ],
        });
      }) as unknown as typeof fetch,
    });
    const claim = new ClaimSourceProposer("test-key", {
      fetchImpl: (async () => {
        calls.claim += 1;
        return json({ sources: [] });
      }) as unknown as typeof fetch,
    });
    const events: CompositionEvent[] = [];
    const post = await start(new ClaimFallbackProposer(bibliography, claim, { defaultLimit: 10, onComposition: (event) => events.push(event) }));

    const body = AriadneResponse.parse(await (await post()).json());

    expect(body.edges).toHaveLength(1);
    expect(events[0]).toMatchObject({ strategy: "bibliography", claim_proposals: 0 });
    // One claim request total: for the second hop, whose bibliography scan proposed nothing.
    expect(calls).toEqual({ bibliography: 2, claim: 1 });
  });

  it("honours max_provider_requests across both endpoints instead of doubling provider usage", async () => {
    const calls = { bibliography: 0, claim: 0 };
    const events: CompositionEvent[] = [];
    const proposer = composedProposer(events, calls);
    const post = await start(proposer);

    const body = AriadneResponse.parse(await (await post({ ...request, max_provider_requests: 1 })).json());

    expect(calls.bibliography + calls.claim).toBe(1);
    expect(events.at(-1)!.strategy).toBe("claim-deferred");
    expect(body.status).toBe("partial");
    expect(body.pending).toHaveLength(1);
  });
});
