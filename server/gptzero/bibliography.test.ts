import { describe, expect, it, vi } from "vitest";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { readAuditMetadata } from "../research/providers";
import type { UpstreamAnalysis } from "../research/traversal";
import demoCacheFixture from "./fixtures/demo-cache.json" with { type: "json" };
import {
  BibliographySourceProposer,
  CachedFallbackBibliographyProposer,
  GPTZeroHttpError,
  GPTZeroTimeoutError,
  MockBibliographyProposer,
  parseBibliographyScanResponse,
  createBibliographyProposer,
  type BibliographyDebugEvent,
  type FallbackEvent,
} from "./bibliography";

function isPendingAnalysis(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  // `readonly T[]` isn't excluded by `!Array.isArray` at the type level (it isn't assignable to
  // the mutable `any[]` the lib type guard narrows to), so the property read is asserted here;
  // `Array.isArray` itself is still an accurate runtime check.
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "pending";
}

function isCompletedAnalysis(
  analysis: UpstreamAnalysis,
): analysis is Extract<UpstreamAnalysis, { status: "completed" }> {
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "completed";
}

function doc(): CandidateDocument {
  return extractDocument({
    url: "https://sources.test/brief",
    html: "<html><head><title>Brief</title></head><body><article><p>See United States v. Ortiz for supervised release terms.</p></article></body></html>",
    fabricated: [],
    claimTerms: [],
    discoveredVia: "test",
  });
}

/** Text hashed by the seeded demo-cache fixture (`fixtures/demo-cache.json`), so lookups hit. */
const CACHED_DEMO_TEXT = demoCacheFixture.response.inputText;

function cachedDoc(): CandidateDocument {
  return {
    id: "cohen-demo",
    canonical_id: "cohen-demo",
    content_fingerprint: "cohen-demo",
    url: "https://demo.test/cohen",
    mirror_urls: [],
    publisher: "demo",
    title: "Cohen/Bard demo claim",
    timestamp: null,
    timestamp_source: "none",
    timestamp_confidence: "none",
    timestamp_conflict: null,
    text: CACHED_DEMO_TEXT,
    passage: CACHED_DEMO_TEXT,
    outbound_links: [],
    case_names: [],
    fabricated_citations: [],
    citation_variants: [],
    discovered_via: [],
  };
}

function fakeFetch(status: number, body: unknown, isJson = true) {
  return vi.fn(async () => {
    if (!isJson) return new Response(String(body), { status });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function claim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 0,
    bibliographic_citation_ids: [0],
    text: "the panel affirmed supervised release conditions",
    claim_type: "factual",
    indices: { start: 0, end: 45 },
    agree_with_citation: { stance: "supports", justification: "provider-only assessment" },
    is_cited_in_bibliography: { score: 1, check_worthy: true, is_cited: true, justification: "provider-only assessment" },
    ...overrides,
  };
}

function bibliographicCitation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 0,
    indices: { start: 0, end: 43 },
    text: "United States v. Ortiz, 89 F.4th 120 (2024)",
    citation_type: "legal",
    citation_exists: { score: 0.93, status: "found", justification: "provider-only assessment" },
    relevant_to_topic: { score: 1, justification: null, is_relevant: true },
    ai_scan: { predicted_class: "human", score: 0.1 },
    claim_reference: { has_reference: true },
    citation_object: { raw_text: "United States v. Ortiz, 89 F.4th 120 (2024)", title: "Ortiz", url: null },
    ...overrides,
  };
}

function source(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 0,
    citation_id: 0,
    claim_id: 0,
    sourcerer_name: "production-source",
    citation_object: { title: "Ortiz opinion", url: "https://real-court.test/ortiz" },
    authors: ["A. Judge"],
    url: "https://real-court.test/ortiz",
    relevance_score: 0.93,
    citations: {
      apa: "A. Judge (2024). Ortiz opinion.",
      bibtex: "@misc{ortiz}",
      chicago: "A. Judge, Ortiz opinion.",
      ieee: "[1] A. Judge, Ortiz opinion.",
      mla: "A. Judge. Ortiz opinion.",
    },
    title: "Ortiz opinion",
    citation_match: { score: 0.93, confidence: 93, stance: "supports" },
    content: "Resolved source content from GPTZero.",
    date: "2024-01-01",
    justification: "provider-only assessment",
    relevance_justification: null,
    relevant_chunk: "the panel held that supervised release...",
    stance: "supports",
    ...overrides,
  };
}

function scanResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "scan_abc123",
    version: 2,
    inputText: "See United States v. Ortiz for supervised release terms.",
    claims: [claim()],
    bibliographic_citations: [bibliographicCitation()],
    sources: [source()],
    raw: { reference_map: { bibliographic_citations: [], intext_citations: [] }, uncited_claims: [] },
    ...overrides,
  };
}

describe("BibliographySourceProposer", () => {
  it("sends the confirmed request shape (endpoint, header, body)", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify(scanResponse({ sources: [] })), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    await proposer.analyze(doc());

    expect(captured!.url).toBe("https://api.gptzero.me/v2/bibliography-scan/text");
    expect((captured!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(captured!.init.body))).toEqual({ document: expect.stringContaining("United States v. Ortiz") });
  });

  it("maps a source into a proposal, resolving claim_id/citation_id and preserving audit metadata", async () => {
    const response = scanResponse();
    const fetchImpl = fakeFetch(200, response);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    const analysis = await proposer.analyze(doc());

    if (!Array.isArray(analysis)) throw new Error("expected proposals");
    expect(analysis).toHaveLength(1);
    const [proposal] = analysis;
    expect(proposal).toMatchObject({
      url: "https://real-court.test/ortiz",
      title: "Ortiz opinion",
      citation: null,
      author: "A. Judge",
    });
    const metadata = readAuditMetadata(proposal!.metadata!);
    expect(metadata).toMatchObject({
      asCited: "United States v. Ortiz, 89 F.4th 120 (2024)",
      claimId: 0,
      citationId: 0,
      relevantChunk: "the panel held that supervised release...",
      sourceContent: "Resolved source content from GPTZero.",
      claim: response.claims[0],
      bibliographicCitation: response.bibliographic_citations[0],
      source: response.sources[0],
    });
  });

  it("joins multiple authors and resolves multiple candidate sources independently", async () => {
    const response = scanResponse({
      claims: [
        claim({ id: 0, text: "claim one" }),
        claim({ id: 1, bibliographic_citation_ids: [], text: "claim two" }),
      ],
      bibliographic_citations: [bibliographicCitation({ id: 0, text: "citation one" })],
      sources: [
        source({ authors: ["A. Judge", { name: "B. Clerk" }], claim_id: 0, citation_id: 0 }),
        source({
          id: 1,
          url: "https://real-court.test/amato",
          title: "Amato opinion",
          authors: [],
          claim_id: 1,
          citation_id: null,
        }),
      ],
    });
    const fetchImpl = fakeFetch(200, response);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    const analysis = await proposer.analyze(doc());

    if (!Array.isArray(analysis)) throw new Error("expected proposals");
    expect(analysis).toHaveLength(2);
    expect(analysis[0]!.author).toBe("A. Judge, B. Clerk");
    expect(readAuditMetadata(analysis[0]!.metadata!).bibliographicCitation).toEqual(response.bibliographic_citations[0]);
    expect(analysis[1]!.title).toBe("Amato opinion");
    expect(readAuditMetadata(analysis[1]!.metadata!).claim).toEqual(response.claims[1]);
    expect(readAuditMetadata(analysis[1]!.metadata!).bibliographicCitation).toBeNull();
  });

  it("returns no proposals when sources[] is empty", async () => {
    const fetchImpl = fakeFetch(200, scanResponse({ sources: [] }));
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    expect(await proposer.analyze(doc())).toEqual([]);
  });

  it("tolerates extra top-level and nested fields without changing mapped proposals", async () => {
    const response = scanResponse({
      provider_future_field: { enabled: true },
      sources: [source({ provider_future_field: { enabled: true } })],
    });
    const fetchImpl = fakeFetch(200, response);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    expect(await proposer.analyze(doc())).toHaveLength(1);
  });

  it("degrades a malformed result to no proposals instead of throwing", async () => {
    const fetchImpl = fakeFetch(200, "not json", false);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    await expect(proposer.analyze(doc())).resolves.toEqual([]);
  });

  it("rejects malformed required populated structures", async () => {
    const malformed = scanResponse({
      claims: [claim({ id: "claim_1" })],
      sources: [source({ authors: "not-an-array" })],
    });
    expect(parseBibliographyScanResponse(malformed)).toBeNull();
    const fetchImpl = fakeFetch(200, malformed);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    expect(await proposer.analyze(doc())).toEqual([]);
  });

  it("parses populated claims, bibliography entries, sources, and the raw block", () => {
    const response = scanResponse();
    const parsed = parseBibliographyScanResponse(response);

    expect(parsed).not.toBeNull();
    expect(parsed?.claims[0]).toMatchObject({ id: 0, bibliographic_citation_ids: [0], text: expect.any(String) });
    expect(parsed?.bibliographic_citations[0]).toMatchObject({ id: 0, text: expect.any(String) });
    expect(parsed?.sources[0]).toMatchObject({ id: 0, claim_id: 0, citation_id: 0, url: expect.any(String) });
    expect(parsed?.raw).toMatchObject({ reference_map: expect.any(Object), uncited_claims: expect.any(Array) });
  });

  it("throws on 401", async () => {
    const fetchImpl = fakeFetch(401, "unauthorized", false);
    const proposer = new BibliographySourceProposer("bad-key", { fetchImpl });
    await expect(proposer.analyze(doc())).rejects.toThrow(/401/);
  });

  it("throws on 403", async () => {
    const fetchImpl = fakeFetch(403, "forbidden", false);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    await expect(proposer.analyze(doc())).rejects.toThrow(/403/);
  });

  it("maps 429 to a pending analysis instead of throwing or retrying inline", async () => {
    const fetchImpl = fakeFetch(429, "rate limited", false);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    const analysis = await proposer.analyze(doc());
    expect(isPendingAnalysis(analysis)).toBe(true);
    if (isPendingAnalysis(analysis)) {
      expect(analysis.retry_after_ms).toBe(60_000);
      expect(analysis.job_id).toContain("rate-limit");
    }
  });

  it("preserves a prior job id across a 429 on a continued call", async () => {
    const fetchImpl = fakeFetch(429, "rate limited", false);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    const analysis = await proposer.analyze(doc(), { job_id: "scan_1" });
    if (isPendingAnalysis(analysis)) expect(analysis.job_id).toBe("scan_1");
    else throw new Error("expected pending analysis");
  });

  it("reports raw request/response through onDebug without affecting the mapped result", async () => {
    const events: BibliographyDebugEvent[] = [];
    const response = scanResponse();
    const fetchImpl = fakeFetch(200, response);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl, onDebug: (event) => events.push(event) });
    await proposer.analyze(doc());

    expect(events).toHaveLength(1);
    expect(events[0]!.response_status).toBe(200);
    expect(events[0]!.proposals_returned).toBe(1);
    expect(events[0]!.raw_response).toMatchObject({ id: "scan_abc123", sources: expect.any(Array) });
  });

  it("never lets GPTZero's own score/stance/confidence fields reach the mapped proposal's structured fields", async () => {
    const response = scanResponse();
    const fetchImpl = fakeFetch(200, response);
    const proposer = new BibliographySourceProposer("test-key", { fetchImpl });
    const analysis = await proposer.analyze(doc());
    if (!Array.isArray(analysis)) throw new Error("expected proposals");
    const [proposal] = analysis;

    expect(Object.keys(proposal)).toEqual(["url", "title", "citation", "author", "metadata"]);
    const metadata = readAuditMetadata(proposal!.metadata!);
    expect((metadata.source as { citation_match: { score: number } }).citation_match.score).toBe(0.93);
    expect((metadata.bibliographicCitation as { citation_exists: { score: number } }).citation_exists.score).toBe(0.93);
  });
});

describe("CachedFallbackBibliographyProposer", () => {
  function innerThatThrows(error: unknown) {
    return { analyze: vi.fn(async () => { throw error; }) };
  }
  function innerThatResolves(result: UpstreamAnalysis) {
    return { analyze: vi.fn(async () => result) };
  }

  it("serves the cached demo response, marked, on a 429 that persists past the job-id continuation", async () => {
    const inner = innerThatResolves({ status: "pending", job_id: "scan_1", retry_after_ms: 60_000 });
    const events: FallbackEvent[] = [];
    const wrapped = new CachedFallbackBibliographyProposer(inner, { onFallback: (event) => events.push(event) });

    const result = await wrapped.analyze(cachedDoc(), { job_id: "scan_1" });

    expect(Array.isArray(result)).toBe(false);
    if (!isCompletedAnalysis(result)) throw new Error("expected a completed analysis");
    expect(result.status).toBe("completed");
    expect(result.fallback).toEqual({ provenance: "cached_demo_fallback", capturedAt: demoCacheFixture.capturedAt });
    expect(result.proposals).toMatchObject([
      {
        url: "https://www.law.cornell.edu/uscode/text/18/3583",
        title: "Synthetic supervised-release authority",
        citation: null,
      },
    ]);
    expect(events).toEqual([{ document_id: "cohen-demo", reason: "rate-limited", cached: true, captured_at: demoCacheFixture.capturedAt }]);
  });

  it("does not fall back on the first 429 (no continuation yet): ordinary pending behavior is preserved", async () => {
    const inner = innerThatResolves({ status: "pending", job_id: "rate-limit:cohen-demo", retry_after_ms: 60_000 });
    const wrapped = new CachedFallbackBibliographyProposer(inner);

    const result = await wrapped.analyze(cachedDoc());

    expect(isPendingAnalysis(result)).toBe(true);
  });

  it("returns the underlying pending result (no cache, no crash) when a continued 429 matches no cached input", async () => {
    const inner = innerThatResolves({ status: "pending", job_id: "scan_1", retry_after_ms: 60_000 });
    const wrapped = new CachedFallbackBibliographyProposer(inner);

    await expect(wrapped.analyze(doc(), { job_id: "scan_1" })).rejects.toThrow(/no cached demo fallback/);
  });

  it("serves the cached demo response, marked, on a network error", async () => {
    const inner = innerThatThrows(new TypeError("fetch failed"));
    const events: FallbackEvent[] = [];
    const wrapped = new CachedFallbackBibliographyProposer(inner, { onFallback: (event) => events.push(event) });

    const result = await wrapped.analyze(cachedDoc());

    if (!isCompletedAnalysis(result)) throw new Error("expected a completed analysis");
    expect(result.fallback).toEqual({ provenance: "cached_demo_fallback", capturedAt: demoCacheFixture.capturedAt });
    expect(events[0]!.reason).toBe("network-error");
  });

  it("serves the cached demo response, marked, on a timeout", async () => {
    const inner = innerThatThrows(new GPTZeroTimeoutError(20_000));
    const wrapped = new CachedFallbackBibliographyProposer(inner);

    const result = await wrapped.analyze(cachedDoc());

    if (!isCompletedAnalysis(result)) throw new Error("expected a completed analysis");
    expect(result.fallback?.provenance).toBe("cached_demo_fallback");
  });

  it("serves the cached demo response, marked, on a 5xx", async () => {
    const inner = innerThatThrows(new GPTZeroHttpError(503, "GPTZero bibliography scan returned 503"));
    const wrapped = new CachedFallbackBibliographyProposer(inner);

    const result = await wrapped.analyze(cachedDoc());

    if (!isCompletedAnalysis(result)) throw new Error("expected a completed analysis");
    expect(result.fallback?.provenance).toBe("cached_demo_fallback");
  });

  it("fails loudly on 401/403 instead of falling back", async () => {
    const wrapped401 = new CachedFallbackBibliographyProposer(innerThatThrows(new GPTZeroHttpError(401, "unauthorized")));
    const wrapped403 = new CachedFallbackBibliographyProposer(innerThatThrows(new GPTZeroHttpError(403, "forbidden")));

    await expect(wrapped401.analyze(cachedDoc())).rejects.toThrow(GPTZeroHttpError);
    await expect(wrapped403.analyze(cachedDoc())).rejects.toThrow(GPTZeroHttpError);
  });

  it("never marks a live success as cached", async () => {
    const liveProposals = [{ url: "https://real-court.test/live", title: "Live opinion", citation: null, author: null, metadata: null }];
    const inner = innerThatResolves(liveProposals);
    const wrapped = new CachedFallbackBibliographyProposer(inner);

    const result = await wrapped.analyze(cachedDoc());

    expect(result).toEqual(liveProposals);
    expect(Array.isArray(result) ? undefined : (result as { fallback?: unknown }).fallback).toBeUndefined();
  });

  it("respects the live-only env switch: no cached fallback is served when disabled", async () => {
    const inner = innerThatThrows(new TypeError("fetch failed"));
    const wrapped = new CachedFallbackBibliographyProposer(inner, { disabled: true });

    await expect(wrapped.analyze(cachedDoc())).rejects.toThrow(/fallback is disabled/);
  });
});

describe("MockBibliographyProposer", () => {
  it("proposes nothing", async () => {
    expect(await new MockBibliographyProposer().analyze(doc())).toEqual([]);
  });
});

describe("createBibliographyProposer", () => {
  it("uses the mock when USE_MOCKS is on and the fallback-wrapped real client otherwise", async () => {
    expect(createBibliographyProposer({ useMocks: true, gptzeroApiKey: null })).toBeInstanceOf(MockBibliographyProposer);
    expect(createBibliographyProposer({ useMocks: false, gptzeroApiKey: "k" })).toBeInstanceOf(CachedFallbackBibliographyProposer);
    await expect(createBibliographyProposer({ useMocks: false, gptzeroApiKey: null }).analyze(doc())).rejects.toThrow(/GPTZERO_API_KEY/);
  });
});
