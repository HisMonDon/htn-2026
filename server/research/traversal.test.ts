import { describe, expect, it, vi } from "vitest";
import { canonicalUrl, extractDocument, type CandidateDocument } from "./extract";
import { toAuditMetadata, type PageFetcher } from "./providers";
import { traverseProvenance, type ProposedUpstreamSource, type UpstreamSourceProposer } from "./traversal";

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
  return extractDocument({
    url: page.url,
    html: html(page),
    fabricated: FABRICATED,
    claimTerms: [],
    discoveredVia: "test seed",
  });
}

function submittedSeed(url: string): CandidateDocument {
  return extractDocument({
    url,
    html: `<html><head><title>Submitted text</title></head><body><article><p>${CLAIM}</p></article></body></html>`,
    fabricated: FABRICATED,
    claimTerms: [],
    discoveredVia: "submitted-text",
  });
}

function fetcher(pages: Page[], calls: string[]): PageFetcher {
  const byUrl = new Map(pages.map((page) => [canonicalUrl(page.url), page]));
  return {
    async fetch(url) {
      calls.push(canonicalUrl(url));
      const page = byUrl.get(canonicalUrl(url));
      return page ? { url: page.url, kind: "html", html: html(page) } : null;
    },
  };
}

function proposer(
  routes: Map<string, readonly ProposedUpstreamSource[] | Error>,
  calls: string[],
): UpstreamSourceProposer {
  return {
    async analyze(document) {
      calls.push(document.url);
      const result = routes.get(document.url) ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function proposed(url: string): ProposedUpstreamSource {
  return { url };
}

function acceptedUrls(result: Awaited<ReturnType<typeof traverseProvenance>>): string[] {
  const byId = new Map(result.documents.map((document) => [document.id, document.url]));
  return result.accepted_edges.map((edge) => `${byId.get(edge.parent_id)}>${byId.get(edge.child_id)}`).sort();
}

describe("recursive provenance traversal", () => {
  it("follows a simple A <- B <- C chain only after each deterministic validation", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], fetchCalls),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(c.url)]], [c.url, []]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${b.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url]);
    expect(fetchCalls).toEqual([b.url, c.url]);
    expect(result.terminations.find((entry) => entry.url === c.url)?.reason).toBe("no-proposals");
  });

  it("makes an acquired claim candidate a root and validates only its real recursive relationship", async () => {
    const submittedUrl = "https://submitted.ariadne.invalid/claim-root";
    const candidate = { url: "https://sources.test/candidate", date: "2023-01-02", marker: "Candidate", links: ["https://sources.test/upstream"] };
    const upstream = { url: "https://sources.test/upstream", date: "2023-01-01", marker: "Upstream" };
    const submitted = submittedSeed(submittedUrl);
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: submitted, claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([candidate, upstream], []),
        proposer: proposer(new Map([
          [submittedUrl, [proposed(candidate.url)]],
          [candidate.url, [proposed(upstream.url)]],
          [upstream.url, []],
        ]), providerCalls),
      },
    );

    const byUrl = new Map(result.documents.map((document) => [document.url, document.id]));
    expect(result.candidate_matches).toEqual([{ source_id: byUrl.get(candidate.url), target_id: byUrl.get(submittedUrl) }]);
    expect(acceptedUrls(result)).toEqual([`${upstream.url}>${candidate.url}`]);
    expect(providerCalls).toEqual([submittedUrl, candidate.url, upstream.url]);
    expect(result.terminations).toContainEqual(expect.objectContaining({ url: submittedUrl, reason: "candidate-roots" }));
  });

  it("does not promote a claim candidate when acquisition fails", async () => {
    const submittedUrl = "https://submitted.ariadne.invalid/fetch-failure";
    const missing = "https://sources.test/missing-candidate";
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: submittedSeed(submittedUrl), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([], fetchCalls),
        proposer: proposer(new Map([[submittedUrl, [proposed(missing)]]]), providerCalls),
      },
    );

    expect(result.candidate_matches).toEqual([]);
    expect(result.documents.map((document) => document.url)).toEqual([submittedUrl]);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: missing, termination: "fetch-failure" }));
    expect(providerCalls).toEqual([submittedUrl]);
    expect(fetchCalls).toEqual([missing]);
  });

  it("fetches and expands a duplicate claim candidate only once", async () => {
    const submittedUrl = "https://submitted.ariadne.invalid/duplicate-candidate";
    const candidate = { url: "https://sources.test/duplicate-candidate", date: "2023-01-02", marker: "Candidate" };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: submittedSeed(submittedUrl), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([candidate], fetchCalls),
        proposer: proposer(new Map([
          [submittedUrl, [proposed(candidate.url), proposed(candidate.url)]],
          [candidate.url, []],
        ]), providerCalls),
      },
    );

    expect(result.candidate_matches).toHaveLength(1);
    expect(result.documents.map((document) => document.url).sort()).toEqual([submittedUrl, candidate.url].sort());
    expect(providerCalls).toEqual([submittedUrl, candidate.url]);
    expect(fetchCalls).toEqual([candidate.url]);
  });

  it("preserves provider-budget pauses and validated-hop depth for promoted claim candidates", async () => {
    const submittedUrl = "https://submitted.ariadne.invalid/limited-candidate";
    const candidate = { url: "https://sources.test/limited-candidate", date: "2023-01-02", marker: "Candidate", links: ["https://sources.test/upstream-limit"] };
    const upstream = { url: "https://sources.test/upstream-limit", date: "2023-01-01", marker: "Upstream" };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];
    const sourceFetcher = fetcher([candidate, upstream], fetchCalls);
    const sourceProposer = proposer(new Map([
      [submittedUrl, [proposed(candidate.url)]],
      [candidate.url, [proposed(upstream.url)]],
      [upstream.url, []],
    ]), providerCalls);
    const input = {
      seed: submittedSeed(submittedUrl),
      claim: CLAIM,
      fabricated: FABRICATED,
      maxDepth: 1,
      maxProviderRequests: 1,
    };

    const paused = await traverseProvenance(input, { fetcher: sourceFetcher, proposer: sourceProposer });
    expect(paused.status).toBe("paused");
    expect(paused.candidate_matches).toHaveLength(1);
    expect(paused.pending_jobs).toEqual([expect.objectContaining({ url: candidate.url, reason: "rate-limit", depth: 0 })]);
    expect(providerCalls).toEqual([submittedUrl]);

    const resumed = await traverseProvenance(
      { ...input, checkpoint: paused.checkpoint },
      { fetcher: sourceFetcher, proposer: sourceProposer },
    );

    expect(acceptedUrls(resumed)).toEqual([`${upstream.url}>${candidate.url}`]);
    expect(providerCalls).toEqual([submittedUrl, candidate.url]);
    expect(fetchCalls).toEqual([candidate.url, upstream.url]);
    expect(resumed.terminations).toContainEqual(expect.objectContaining({ url: upstream.url, reason: "max-depth", depth: 1 }));
  });

  it("resolves an incomplete recursive proposal before fetching it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const fetchCalls: string[] = [];
    const resolver = { kind: "test", resolve: vi.fn(async () => b.url) };

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], fetchCalls),
        resolver,
        proposer: proposer(new Map([[a.url, [{ title: "Original B filing", citation: "B v. Example" }]], [b.url, []]]), []),
      },
    );

    expect(resolver.resolve).toHaveBeenCalledWith({ title: "Original B filing", citation: "B v. Example" });
    expect(fetchCalls).toEqual([b.url]);
    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
  });

  it("branches across multiple validated upstream sources in canonical URL order", async () => {
    const a = {
      url: "https://sources.test/a",
      date: "2023-01-03",
      marker: "A",
      links: ["https://sources.test/b", "https://sources.test/c"],
    };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], []),
        // Return C first to prove the traversal controls its own order.
        proposer: proposer(new Map([[a.url, [proposed(c.url), proposed(b.url)]], [b.url, []], [c.url, []]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${a.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url]);
  });

  it("rejects a suggested edge that would close a cycle", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(a.url)]]]), []),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: a.url, termination: "cycle" }),
    );
  });

  it("identifies an exact-content mirror without treating it as a source edge", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "same artifact" };
    const mirror = { url: "https://mirror.test/copy", date: "2023-01-03", marker: "same artifact" };
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, mirror], fetchCalls),
        proposer: proposer(new Map([[a.url, [proposed(mirror.url)]]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.documents).toHaveLength(1);
    expect([result.documents[0]?.url, ...(result.documents[0]?.mirror_urls ?? [])]).toEqual(expect.arrayContaining([a.url, mirror.url]));
    expect(fetchCalls).toEqual([mirror.url]);
    expect(result.rejected_edges[0]).toMatchObject({ termination: "duplicate-source", parent_url: mirror.url });
  });

  it("keeps a rejected proposed parent for debugging and does not recurse into it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const b = {
      url: "https://sources.test/b",
      date: "2023-01-02",
      marker: "unrelated evidence",
      body: "An unrelated report about weather patterns and local conditions.",
    };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), providerCalls),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(providerCalls).toEqual([a.url]);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: b.url, termination: "validation-rejected" }));
    expect(result.terminations[0]).toMatchObject({ url: a.url, reason: "all-proposals-rejected" });
  });

  it("records a provider failure as a nonfatal source termination", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a], []),
        proposer: proposer(new Map([[a.url, new Error("provider unavailable")]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.terminations).toEqual([
      expect.objectContaining({ url: a.url, reason: "provider-failure", detail: "provider unavailable" }),
    ]);
  });

  it("records a fetch failure without interrupting the traversal", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const missing = "https://sources.test/missing";
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a], []),
        proposer: proposer(new Map([[a.url, [proposed(missing)]]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: missing, termination: "fetch-failure", reason: "not-found" }),
    );
    expect(result.terminations).toEqual([expect.objectContaining({ url: a.url, reason: "all-proposals-rejected" })]);
  });

  it("preserves earlier validated lineage as partial when a later hop cannot be acquired", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const missing = "https://sources.test/missing";
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(missing)]]]), []),
      },
    );

    expect(result.status).toBe("partial");
    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: missing, termination: "fetch-failure", category: "http-404" }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ stage: "fetch", source: missing, category: "http-404", recoverable: false }),
    );
  });

  it("keeps an empty proposed document out of accepted lineage", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const empty = "https://sources.test/empty";
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: {
          async fetch(url) {
            return url === empty ? { url, kind: "html", html: "<html><body></body></html>" } : null;
          },
        },
        proposer: proposer(new Map([[a.url, [proposed(empty)]]]), []),
      },
    );

    expect(result.status).toBe("failed");
    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: empty, termination: "fetch-failure", category: "empty-document" }),
    );
  });

  it("preserves cached bibliography provenance through traversal diagnostics", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: {
          async analyze(document) {
            if (document.url === a.url) {
              return {
                status: "completed" as const,
                proposals: [proposed(b.url)],
                fallback: { provenance: "cached_demo_fallback" as const, capturedAt: "2026-09-19T00:00:00.000Z" },
              };
            }
            return [];
          },
        },
      },
    );

    expect(result.status).toBe("complete");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ stage: "gptzero", category: "cached_demo_fallback", source: a.url }),
    );
  });

  it("pauses an asynchronous analysis job and resumes it with the durable job ID", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const calls: string[] = [];
    const asyncProposer: UpstreamSourceProposer = {
      async analyze(document, continuation) {
        calls.push(`${document.url}:${continuation?.job_id ?? "new"}`);
        if (document.url === a.url && !continuation) return { status: "pending", job_id: "analysis-a", retry_after_ms: 250 };
        if (document.url === a.url) return [proposed(b.url)];
        return [];
      },
    };
    const input = { seed: seed(a), claim: CLAIM, fabricated: FABRICATED };

    const paused = await traverseProvenance(input, { fetcher: fetcher([a, b], []), proposer: asyncProposer });
    expect(paused).toMatchObject({
      status: "paused",
      pending_jobs: [expect.objectContaining({ source_id: paused.documents[0]!.id, job_id: "analysis-a", reason: "provider-pending", retry_after_ms: 250 })],
    });
    expect(paused.accepted_edges).toEqual([]);

    const resumed = await traverseProvenance({ ...input, checkpoint: paused.checkpoint }, { fetcher: fetcher([a, b], []), proposer: asyncProposer });
    expect(resumed.status).toBe("complete");
    expect(acceptedUrls(resumed)).toEqual([`${b.url}>${a.url}`]);
    expect(calls).toEqual([`${a.url}:new`, `${a.url}:analysis-a`, `${b.url}:new`]);
  });

  it("pauses queued work at the provider request budget instead of exceeding it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const calls: string[] = [];
    const input = { seed: seed(a), claim: CLAIM, fabricated: FABRICATED, maxProviderRequests: 1 };

    const paused = await traverseProvenance(
      input,
      { fetcher: fetcher([a, b], []), proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), calls) },
    );
    expect(paused.status).toBe("paused");
    expect(paused.pending_jobs).toEqual([expect.objectContaining({ url: b.url, reason: "rate-limit", retry_after_ms: 60_000 })]);
    expect(calls).toEqual([a.url]);

    const resumed = await traverseProvenance(
      { ...input, checkpoint: paused.checkpoint },
      { fetcher: fetcher([a, b], []), proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), calls) },
    );
    expect(resumed.status).toBe("complete");
    expect(calls).toEqual([a.url, b.url]);
  });

  it("stops expanding an accepted source at the configured maximum depth", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED, maxDepth: 1 },
      {
        fetcher: fetcher([a, b, c], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(c.url)]]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
    expect(providerCalls).toEqual([a.url]);
    expect(result.terminations.find((entry) => entry.url === b.url)).toMatchObject({ reason: "max-depth", depth: 1 });
  });

  it("validates a repeated source for both branches but expands it once", async () => {
    const d = { url: "https://sources.test/d", date: "2023-01-01", marker: "D" };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: [d.url] };
    const c = { url: "https://sources.test/c", date: "2023-01-02", marker: "C", links: [d.url] };
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: [b.url, c.url] };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c, d], fetchCalls),
        proposer: proposer(
          new Map([[a.url, [proposed(b.url), proposed(c.url)]], [b.url, [proposed(d.url)]], [c.url, [proposed(d.url)]], [d.url, []]]),
          providerCalls,
        ),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${a.url}`, `${d.url}>${b.url}`, `${d.url}>${c.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url, d.url]);
    expect(fetchCalls.filter((url) => url === d.url)).toHaveLength(1);
    expect(result.accepted_edges.filter((edge) => edge.parent_id === result.documents.find((document) => document.url === d.url)?.id)).toHaveLength(2);
    expect(result.accepted_edges.filter((edge) => edge.recursed)).toHaveLength(3);
  });
});

describe("proposal metadata isolation", () => {
  it("produces byte-identical acceptance and confidence regardless of a proposal's audit metadata contents", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };

    const run = async (metadataPayload: Record<string, unknown>) =>
      traverseProvenance(
        { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
        {
          fetcher: fetcher([a, b], []),
          proposer: proposer(
            new Map([[a.url, [{ url: b.url, metadata: toAuditMetadata(metadataPayload) } satisfies ProposedUpstreamSource]]]),
            [],
          ),
        },
      );

    const low = await run({
      score: 0,
      hallucination_label: "supported",
      stance: "supports",
      match_confidence: 0,
      document_ai_probability: 0,
    });
    const high = await run({
      score: 1,
      hallucination_label: "hallucinated",
      stance: "contradicts",
      match_confidence: 1,
      document_ai_probability: 1,
    });

    expect(high.accepted_edges).toEqual(low.accepted_edges);
    expect(high.rejected_edges).toEqual(low.rejected_edges);
    expect(high.terminations).toEqual(low.terminations);
    expect(high.stats).toEqual(low.stats);
  });

  it("fetches one node's proposed sources concurrently (bounded) without changing what is accepted", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-09", marker: "A", links: [1, 2, 3, 4, 5, 6].map((n) => `https://sources.test/p${n}`) };
    const parents = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://sources.test/p${n}`, date: `2023-01-0${n}`, marker: `P${n}` }));
    const run = async (delayMs: number, order: (list: ProposedUpstreamSource[]) => ProposedUpstreamSource[]) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const base = fetcher([a, ...parents], []);
      const slow: PageFetcher = {
        async fetch(url) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return base.fetch(url);
        },
      };
      const proposals = order(parents.map((page) => proposed(page.url)));
      const result = await traverseProvenance(
        { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
        { fetcher: slow, proposer: proposer(new Map([[a.url, proposals]]), []) },
      );
      return { result, maxInFlight };
    };

    const concurrent = await run(15, (list) => list);
    const serialLike = await run(0, (list) => [...list].reverse());

    expect(concurrent.maxInFlight).toBeGreaterThan(1);
    expect(concurrent.maxInFlight).toBeLessThanOrEqual(4);
    expect(concurrent.result.stats.fetched).toBe(6);
    expect(acceptedUrls(concurrent.result)).toEqual(acceptedUrls(serialLike.result));
    expect(concurrent.result.rejected_edges.map((edge) => `${edge.parent_url}|${edge.termination}`)).toEqual(
      serialLike.result.rejected_edges.map((edge) => `${edge.parent_url}|${edge.termination}`),
    );
  });

  describe("provider analyses of same-depth sources", () => {
    const roots = [1, 2, 3, 4].map((n) => ({ url: `https://sources.test/root${n}`, date: `2023-01-0${n}`, marker: `Root${n}` }));
    const submitted = "https://submitted.test/claim";

    const run = async (delayMs: number, maxProviderRequests?: number) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const analyzed: string[] = [];
      const slow: UpstreamSourceProposer = {
        async analyze(document) {
          analyzed.push(document.url);
          if (document.url === submitted) return roots.map((page) => proposed(page.url));
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return [];
        },
      };
      const result = await traverseProvenance(
        { seed: submittedSeed(submitted), claim: CLAIM, fabricated: FABRICATED, maxProviderRequests },
        { fetcher: fetcher(roots, []), proposer: slow },
      );
      return { result, maxInFlight, analyzed };
    };

    it("are started together (bounded) without changing the outcome", async () => {
      const concurrent = await run(20);
      const serialLike = await run(0);

      expect(concurrent.maxInFlight).toBeGreaterThan(1);
      expect(concurrent.maxInFlight).toBeLessThanOrEqual(3);
      expect(concurrent.analyzed).toEqual([submitted, ...roots.map((page) => page.url)]);
      expect(concurrent.result.terminations).toEqual(serialLike.result.terminations);
      expect(concurrent.result.candidate_matches).toEqual(serialLike.result.candidate_matches);
      expect(concurrent.result.stats).toEqual(serialLike.result.stats);
      expect(concurrent.result.status).toBe(serialLike.result.status);
    });

    it("never start more provider analyses than the per-call budget allows, and resume the rest", async () => {
      const limited = await run(10, 3);

      expect(limited.analyzed).toHaveLength(3); // the submitted text plus two roots; no speculative overrun
      expect(limited.result.status).toBe("paused");
      expect(limited.result.pending_jobs).toHaveLength(1);
      expect(limited.result.pending_jobs[0]?.reason).toBe("rate-limit");
    });

    it("attributes a failure to its own source and still completes its peers", async () => {
      const analyzed: string[] = [];
      const flaky: UpstreamSourceProposer = {
        async analyze(document) {
          analyzed.push(document.url);
          if (document.url === submitted) return roots.map((page) => proposed(page.url));
          if (document.url === roots[1]!.url) throw new Error("scan timed out");
          return [];
        },
      };
      const result = await traverseProvenance(
        { seed: submittedSeed(submitted), claim: CLAIM, fabricated: FABRICATED },
        { fetcher: fetcher(roots, []), proposer: flaky },
      );

      expect(result.terminations.filter((entry) => entry.reason === "provider-failure").map((entry) => entry.url)).toEqual([roots[1]!.url]);
      expect(result.terminations.filter((entry) => entry.reason === "no-proposals")).toHaveLength(3);
    });
  });
});

describe("exploratory provenance mode", () => {
  /**
   * A long filler sentence, shared verbatim between a child and one candidate parent and nowhere
   * else, so it contributes several rare/unique 6-word shingles (evidence), not just generic
   * similarity. Parameterized so each candidate in the branch-cap test gets its own unique phrase.
   */
  const distinctivePhrase = (tag: string) =>
    `extended analysis follows the committee reviewed several confidential internal memoranda ${tag} before reaching a quiet determination`;

  /** Child cites both fabricated cases; a weak candidate parent shares only one (coverage 0.5, below MIN_COVERAGE). */
  function weakChild(url: string, date: string, links: string[] = []): Page {
    return { url, date, marker: "Child", links, body: `${FABRICATED[0]}. ${FABRICATED[1]}. ${distinctivePhrase("shared")}.` };
  }
  function weakParent(url: string, date: string, tag = "shared"): Page {
    return { url, date, marker: "Parent", body: `${FABRICATED[0]}. ${distinctivePhrase(tag)}.` };
  }

  it("keeps a below-threshold-but-evidenced edge rejected in strict mode (default)", async () => {
    const child = weakChild("https://sources.test/weak-child", "2023-01-03");
    const parent = weakParent("https://sources.test/weak-parent", "2023-01-02");
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(child), claim: CLAIM, fabricated: FABRICATED },
      { fetcher: fetcher([parent], []), proposer: proposer(new Map([[child.url, [proposed(parent.url)]]]), providerCalls) },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: parent.url, termination: "validation-rejected" }));
    // Strict mode never recurses into a rejected candidate.
    expect(providerCalls).toEqual([child.url]);
  });

  it("promotes the same edge to probable and recurses into it in exploratory mode", async () => {
    const child = weakChild("https://sources.test/weak-child-2", "2023-01-03");
    const parent = weakParent("https://sources.test/weak-parent-2", "2023-01-02");
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(child), claim: CLAIM, fabricated: FABRICATED, provenanceMode: "exploratory" },
      { fetcher: fetcher([parent], []), proposer: proposer(new Map([[child.url, [proposed(parent.url)]], [parent.url, []]]), providerCalls) },
    );

    expect(result.rejected_edges).toEqual([]);
    expect(result.accepted_edges).toHaveLength(1);
    const edge = result.accepted_edges[0]!;
    expect(edge.provenance_status).toBe("probable");
    expect(edge.recursed).toBe(true);
    // Only exploratory mode recurses into a probable parent.
    expect(providerCalls).toEqual([child.url, parent.url]);
  });

  it("never classifies the submitted-text bootstrap match as probable or validated", async () => {
    const submittedUrl = "https://submitted.ariadne.invalid/exploratory-bootstrap";
    const candidate = { url: "https://sources.test/exploratory-candidate", date: "2023-01-02", marker: "Candidate" };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: submittedSeed(submittedUrl), claim: CLAIM, fabricated: FABRICATED, provenanceMode: "exploratory" },
      {
        fetcher: fetcher([candidate], []),
        proposer: proposer(new Map([[submittedUrl, [proposed(candidate.url)]], [candidate.url, []]]), providerCalls),
      },
    );

    const byUrl = new Map(result.documents.map((document) => [document.url, document.id]));
    expect(result.candidate_matches).toEqual([{ source_id: byUrl.get(candidate.url), target_id: byUrl.get(submittedUrl) }]);
    expect(result.accepted_edges.some((edge) => edge.child_id === byUrl.get(submittedUrl))).toBe(false);
  });

  describe("hard-invalid conditions stay rejected regardless of mode", () => {
    it.each(["strict", "exploratory"] as const)("rejects an impossible-chronology candidate in %s mode", async (provenanceMode) => {
      const child = { url: "https://sources.test/order-child", date: "2023-01-01", marker: "Child" };
      // Links to the child, so it was necessarily written after it: an impossible parent regardless of claimed date.
      const linkedParent = { url: "https://sources.test/order-parent", date: "2023-01-05", marker: "Parent", links: [child.url] };
      const providerCalls: string[] = [];

      const result = await traverseProvenance(
        { seed: seed(child), claim: CLAIM, fabricated: FABRICATED, provenanceMode },
        { fetcher: fetcher([linkedParent], []), proposer: proposer(new Map([[child.url, [proposed(linkedParent.url)]]]), providerCalls) },
      );

      expect(result.accepted_edges).toEqual([]);
      expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: linkedParent.url, termination: "validation-rejected" }));
    });

    it.each(["strict", "exploratory"] as const)("rejects a failed fetch in %s mode", async (provenanceMode) => {
      const submittedUrl = "https://submitted.ariadne.invalid/hard-reject-fetch";
      const missing = "https://sources.test/hard-reject-missing";
      const result = await traverseProvenance(
        { seed: submittedSeed(submittedUrl), claim: CLAIM, fabricated: FABRICATED, provenanceMode },
        { fetcher: fetcher([], []), proposer: proposer(new Map([[submittedUrl, [proposed(missing)]]]), []) },
      );
      expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: missing, termination: "fetch-failure" }));
    });

    it.each(["strict", "exploratory"] as const)("rejects a same-artifact duplicate in %s mode", async (provenanceMode) => {
      const a = { url: "https://sources.test/dup-a", date: "2023-01-03", marker: "A", links: ["https://sources.test/dup-a-mirror"] };
      const mirror = { url: "https://sources.test/dup-a-mirror", date: "2023-01-03", marker: "A" }; // same content/marker, canonicalizes with `a`
      const result = await traverseProvenance(
        { seed: seed(a), claim: CLAIM, fabricated: FABRICATED, provenanceMode },
        { fetcher: fetcher([mirror], []), proposer: proposer(new Map([[a.url, [proposed(mirror.url)]]]), []) },
      );
      expect(result.accepted_edges).toEqual([]);
    });
  });

  it("does not let discovered_by or other provider metadata change acceptance in exploratory mode", async () => {
    const child = weakChild("https://sources.test/meta-child", "2023-01-03");
    const parent = weakParent("https://sources.test/meta-parent", "2023-01-02");

    const run = async (discovered_by: readonly string[]) =>
      traverseProvenance(
        { seed: seed(child), claim: CLAIM, fabricated: FABRICATED, provenanceMode: "exploratory" },
        {
          fetcher: fetcher([parent], []),
          proposer: proposer(new Map([[child.url, [{ url: parent.url, discovered_by }]], [parent.url, []]]), []),
        },
      );

    const low = await run(["web-search"]);
    const high = await run(["gptzero", "web-search"]);

    expect(low.accepted_edges).toEqual(high.accepted_edges);
    expect(low.rejected_edges).toEqual(high.rejected_edges);
    expect(low.accepted_edges[0]?.provenance_status).toBe("probable");
  });

  it("caps how many probable parents a single node accepts (exploratory branch cap)", async () => {
    const tags = ["one", "two", "three", "four"];
    const child: Page = {
      url: "https://sources.test/cap-child",
      date: "2023-01-09",
      marker: "Child",
      body: `${FABRICATED[0]}. ${FABRICATED[1]}. ${tags.map((tag) => distinctivePhrase(tag)).join(". ")}.`,
    };
    const parents = tags.map((tag, index) => weakParent(`https://sources.test/cap-parent-${index}`, "2023-01-01", tag));
    const providerCalls: string[] = [];
    const routes = new Map<string, ProposedUpstreamSource[]>([[child.url, parents.map((page) => proposed(page.url))]]);
    for (const page of parents) routes.set(page.url, []);

    const result = await traverseProvenance(
      { seed: seed(child), claim: CLAIM, fabricated: FABRICATED, provenanceMode: "exploratory" },
      { fetcher: fetcher(parents, []), proposer: proposer(routes, providerCalls) },
    );

    const probable = result.accepted_edges.filter((edge) => edge.provenance_status === "probable");
    expect(probable).toHaveLength(3);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ termination: "exploratory-branch-cap" }));
  });
});
