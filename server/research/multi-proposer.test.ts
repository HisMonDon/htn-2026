import { describe, expect, it, vi } from "vitest";
import { canonicalUrl, extractDocument, type CandidateDocument } from "./extract";
import { MultiSourceProposer, mergeProposals, type ChannelFailureEvent } from "./multi-proposer";
import { readAuditMetadata, toAuditMetadata, type PageFetcher } from "./providers";
import { traverseProvenance, type UpstreamAnalysis, type UpstreamProposal, type UpstreamSourceProposer } from "./traversal";

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM = `The filing cites ${FABRICATED.join(", ")}.`;

interface Page {
  url: string;
  date: string;
  marker: string;
  links?: string[];
  body?: string;
}

function html(page: Page): string {
  const links = (page.links ?? []).map((url) => `<a href="${url}">source</a>`).join(" ");
  const body = page.body ?? `${FABRICATED.join(". ")}. ${page.marker}.`;
  return `<html><head><title>${page.marker}</title><meta property="article:published_time" content="${page.date}T00:00:00Z"></head><body><article><p>${body}</p>${links}</article></body></html>`;
}

function seed(page: Page): CandidateDocument {
  return extractDocument({ url: page.url, html: html(page), fabricated: FABRICATED, claimTerms: [], discoveredVia: "test seed" });
}

function fetcher(pages: Page[], calls: string[] = []): PageFetcher {
  const byUrl = new Map(pages.map((page) => [canonicalUrl(page.url), page]));
  return {
    async fetch(url) {
      calls.push(canonicalUrl(url));
      const page = byUrl.get(canonicalUrl(url));
      return page ? { url: page.url, kind: "html", html: html(page) } : null;
    },
  };
}

/** A proposer that answers per document URL, and records what it was asked. */
function routed(routes: Record<string, readonly UpstreamProposal[] | Error>, calls: string[] = []): UpstreamSourceProposer {
  return {
    async analyze(document) {
      calls.push(document.url);
      const result = routes[document.url] ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const someDoc = () => seed({ url: "https://sources.test/a", date: "2023-01-03", marker: "A" });

function stub(result: UpstreamAnalysis | Error): UpstreamSourceProposer & { analyze: ReturnType<typeof vi.fn> } {
  return { analyze: vi.fn(async () => { if (result instanceof Error) throw result; return result; }) } as never;
}

function proposalsOf(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  if (Array.isArray(analysis)) return analysis;
  return "proposals" in (analysis as object) ? (analysis as { proposals: readonly UpstreamProposal[] }).proposals : [];
}

describe("MultiSourceProposer", () => {
  it("merges GPTZero and web proposals into one candidate pool", async () => {
    const proposer = new MultiSourceProposer(stub([{ url: "https://g.test/1" }]), stub([{ url: "https://w.test/1", discovered_by: ["web-search"] }]));
    const result = proposalsOf(await proposer.analyze(someDoc()));

    expect(result.map((proposal) => proposal.url)).toEqual(["https://g.test/1", "https://w.test/1"]);
  });

  it("collapses a URL both channels found (canonical variants included) and keeps both discovery channels", async () => {
    const proposer = new MultiSourceProposer(
      stub([{ url: "https://example.com/opinion", title: null }]),
      stub([{ url: "https://www.Example.com/opinion/?utm_source=q", title: "Opinion of the Court", published: "2023-01-01" }]),
    );
    const result = proposalsOf(await proposer.analyze(someDoc()));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ url: "https://example.com/opinion", title: "Opinion of the Court", published: "2023-01-01" });
    expect(result[0]!.discovered_by).toEqual(["gptzero", "web-search"]);
  });

  it("tags each candidate with the channel that found it, and keeps GPTZero's audit metadata", async () => {
    const metadata = toAuditMetadata({ claimId: 3 });
    const proposer = new MultiSourceProposer(stub([{ url: "https://g.test/1", metadata }]), stub([{ url: "https://w.test/1" }]));
    const result = proposalsOf(await proposer.analyze(someDoc()));

    expect(result.map((proposal) => proposal.discovered_by)).toEqual([["gptzero"], ["web-search"]]);
    expect(readAuditMetadata(result[0]!.metadata!)).toEqual({ claimId: 3 });
  });

  it("keeps GPTZero's candidates when web search fails, and reports the failure", async () => {
    const failures: ChannelFailureEvent[] = [];
    const proposer = new MultiSourceProposer(stub([{ url: "https://g.test/1" }]), stub(new Error("search API down")), { onChannelFailure: (event) => failures.push(event) });
    const result = proposalsOf(await proposer.analyze(someDoc()));

    expect(result.map((proposal) => proposal.url)).toEqual(["https://g.test/1"]);
    expect(failures).toEqual([expect.objectContaining({ channel: "web-search", message: "search API down" })]);
  });

  it("keeps the cached-demo fallback marker when GPTZero served one and web search also ran", async () => {
    const fallback = { provenance: "cached_demo_fallback" as const, capturedAt: "2026-09-19T00:00:00Z" };
    const proposer = new MultiSourceProposer(stub({ status: "completed", proposals: [{ url: "https://g.test/1" }], fallback }), stub([{ url: "https://w.test/1" }]));
    const result = await proposer.analyze(someDoc());

    expect((result as { fallback?: unknown }).fallback).toEqual(fallback);
  });

  it("keeps the web candidates when GPTZero errors (e.g. times out), and reports the failure", async () => {
    const failures: ChannelFailureEvent[] = [];
    const proposer = new MultiSourceProposer(stub(new Error("GPTZero bibliography scan failed (timeout)")), stub([{ url: "https://w.test/1" }]), { onChannelFailure: (event) => failures.push(event) });
    const result = proposalsOf(await proposer.analyze(someDoc()));

    expect(result.map((proposal) => proposal.url)).toEqual(["https://w.test/1"]);
    expect(failures).toEqual([expect.objectContaining({ channel: "gptzero" })]);
  });

  it("still reports a provider failure, not 'no proposals', when GPTZero errors and the web found nothing", async () => {
    const proposer = new MultiSourceProposer(stub(new Error("GPTZero timed out")), stub([]));
    await expect(proposer.analyze(someDoc())).rejects.toThrow("GPTZero timed out");
  });

  it("fails gracefully with both causes when both channels fail", async () => {
    const proposer = new MultiSourceProposer(stub(new Error("GPTZero timed out")), stub(new Error("search API down")));
    await expect(proposer.analyze(someDoc())).rejects.toThrow(/GPTZero timed out.*search API down/);
  });

  it("treats an empty GPTZero result plus a failed web search as no proposals (the pre-existing behavior)", async () => {
    const proposer = new MultiSourceProposer(stub([]), stub(new Error("search API down")));
    expect(proposalsOf(await proposer.analyze(someDoc()))).toEqual([]);
  });

  it("runs both channels concurrently", async () => {
    const started: string[] = [];
    const slow = (name: string): UpstreamSourceProposer => ({
      async analyze() {
        started.push(name);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    });
    const pending = new MultiSourceProposer(slow("gptzero"), slow("web")).analyze(someDoc());
    await Promise.resolve();
    expect(started.sort()).toEqual(["gptzero", "web"]);
    await pending;
  });

  it("preserves GPTZero's pause semantics, and resumes without searching the web a second time", async () => {
    const web = stub([{ url: "https://w.test/1" }]);
    const gptzero = { analyze: vi.fn() };
    gptzero.analyze.mockResolvedValueOnce({ status: "pending", job_id: "job-1", retry_after_ms: 60_000 }).mockResolvedValueOnce([{ url: "https://g.test/1" }]);
    const proposer = new MultiSourceProposer(gptzero, web);
    const document = someDoc();

    expect(await proposer.analyze(document)).toEqual({ status: "pending", job_id: "job-1", retry_after_ms: 60_000 });
    const resumed = proposalsOf(await proposer.analyze(document, { job_id: "job-1" }));

    expect(resumed.map((proposal) => proposal.url)).toEqual(["https://g.test/1", "https://w.test/1"]);
    expect(web.analyze).toHaveBeenCalledTimes(1);
    expect(gptzero.analyze).toHaveBeenLastCalledWith(document, { job_id: "job-1" });
  });

  it("forwards the per-run provider budget to GPTZero", () => {
    const startRun = vi.fn();
    new MultiSourceProposer({ analyze: vi.fn(), startRun } as never, stub([])).startRun(7);
    expect(startRun).toHaveBeenCalledWith(7);
  });
});

describe("mergeProposals", () => {
  it("keeps distinct URL-less references apart and de-duplicates exact ones", () => {
    const merged = mergeProposals([{ title: "United States v. Ortiz" }, { title: "United States v. Ortiz" }, { title: "United States v. Ortiz (II)" }]);
    expect(merged).toHaveLength(2);
  });
});

describe("web proposals inside real recursive traversal", () => {
  const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
  const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
  const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
  const unrelated: Page = {
    url: "https://sources.test/unrelated",
    date: "2023-01-01",
    marker: "Unrelated",
    body: "Spring flowers bloom beside vegetable gardens where gardeners compost leaves, water tomatoes, and prune roses every single weekend.",
  };

  const urlOf = (result: Awaited<ReturnType<typeof traverseProvenance>>, id: string) => result.documents.find((document) => document.id === id)!.url;
  const accepted = (result: Awaited<ReturnType<typeof traverseProvenance>>) =>
    result.accepted_edges.map((edge) => `${urlOf(result, edge.parent_id)}>${urlOf(result, edge.child_id)}`).sort();

  it("lets web-only candidates enter the same validated, recursive path GPTZero candidates do", async () => {
    const web = (url: string): UpstreamProposal => ({ url, discovered_by: ["web-search"] });
    const analyzed: string[] = [];
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c]),
        proposer: new MultiSourceProposer(
          routed({}, analyzed),
          routed({ [a.url]: [web(b.url)], [b.url]: [web(c.url)] }),
        ),
      },
    );

    expect(accepted(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${b.url}`]);
    // b was expanded because validation accepted it, and that expansion found c.
    expect(analyzed).toEqual([a.url, b.url, c.url]);
    expect(result.documents.find((document) => document.url === b.url)!.discovered_via).toContain("web-search");
  });

  it("does not let a web hit become an edge just because it was proposed", async () => {
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, unrelated]),
        proposer: new MultiSourceProposer(
          routed({}),
          // A top-ranked, highly "relevant"-looking hit whose page shares nothing with the seed.
          routed({ [a.url]: [{ url: unrelated.url, title: FABRICATED.join(" "), discovered_by: ["web-search"] }] }),
        ),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toEqual([expect.objectContaining({ termination: "validation-rejected", parent_url: unrelated.url })]);
  });

  it("fetches a source found by both channels once, and records both discovery channels on it", async () => {
    const fetchCalls: string[] = [];
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], fetchCalls),
        proposer: new MultiSourceProposer(
          routed({ [a.url]: [{ url: b.url }] }),
          routed({ [a.url]: [{ url: "https://www.sources.test/b/?utm_source=search", discovered_by: ["web-search"] }] }),
        ),
      },
    );

    expect(fetchCalls.filter((url) => url === canonicalUrl(b.url))).toHaveLength(1);
    expect(result.documents.filter((document) => document.url === b.url)).toHaveLength(1);
    expect(result.documents.find((document) => document.url === b.url)!.discovered_via).toEqual(expect.arrayContaining(["gptzero", "web-search"]));
    expect(accepted(result)).toEqual([`${b.url}>${a.url}`]);
  });

  it("continues with the web's candidates when GPTZero fails on a source", async () => {
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c]),
        proposer: new MultiSourceProposer(routed({ [a.url]: new Error("GPTZero timed out") }), routed({ [a.url]: [{ url: b.url }] })),
      },
    );

    expect(accepted(result)).toEqual([`${b.url}>${a.url}`]);
    expect(result.terminations.some((entry) => entry.reason === "provider-failure")).toBe(false);
  });

  it("records an ordinary provider failure, without crashing, when both channels fail", async () => {
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a]),
        proposer: new MultiSourceProposer(routed({ [a.url]: new Error("GPTZero timed out") }), routed({ [a.url]: new Error("search API down") })),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.terminations).toEqual([expect.objectContaining({ reason: "provider-failure", detail: expect.stringContaining("search API down") })]);
  });
});
