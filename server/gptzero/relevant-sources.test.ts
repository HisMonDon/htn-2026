import { describe, expect, it, vi } from "vitest";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { readAuditMetadata } from "../research/providers";
import type { UpstreamAnalysis, UpstreamProposal } from "../research/traversal";
import { GPTZeroHttpError, GPTZeroTimeoutError } from "./bibliography";
import sample from "./fixtures/relevant-sources-sample.json" with { type: "json" };
import {
  buildClaimProposal,
  ClaimSourceProposer,
  claimJobId,
  MockClaimSourceProposer,
  parseRelevantSourcesResponse,
  type ClaimSourceDebugEvent,
} from "./relevant-sources";

function isPendingAnalysis(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "pending";
}

function proposals(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  if (Array.isArray(analysis)) return analysis;
  return isPendingAnalysis(analysis) ? [] : (analysis as { proposals: readonly UpstreamProposal[] }).proposals;
}

function doc(): CandidateDocument {
  return extractDocument({
    url: "https://sources.test/brief",
    html: "<html><head><title>Brief</title></head><body><article><p>The motion relies on United States v. Ortiz, a Second Circuit decision on supervised release.</p></article></body></html>",
    fabricated: [],
    claimTerms: ["supervised release"],
    discoveredVia: "test",
  });
}

function fakeFetch(status: number, body: unknown, isJson = true) {
  return vi.fn(async () => {
    if (!isJson) return new Response(String(body), { status });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("parseRelevantSourcesResponse", () => {
  it("parses the production-shaped sample fixture and preserves unknown provider fields", () => {
    const parsed = parseRelevantSourcesResponse(sample.response);
    expect(parsed).not.toBeNull();
    expect(parsed!.sources).toHaveLength(2);
    expect((parsed!.sources[0] as Record<string, unknown>).extra_provider_field).toEqual({ preserved: true });
  });

  it("tolerates null-valued optional provider fields", () => {
    const parsed = parseRelevantSourcesResponse({
      sources: [{ url: "https://a.test/x", title: null, relevance_score: null, stance: null, citation_object: null }],
    });
    expect(parsed!.sources[0]!.url).toBe("https://a.test/x");
  });

  it("rejects a malformed body instead of inventing sources", () => {
    expect(parseRelevantSourcesResponse({ sources: "not-an-array" })).toBeNull();
    expect(parseRelevantSourcesResponse({})).toBeNull();
    expect(parseRelevantSourcesResponse(null)).toBeNull();
    expect(parseRelevantSourcesResponse("<html>gateway error</html>")).toBeNull();
  });
});

describe("buildClaimProposal", () => {
  it("maps only URL/title/author into resolver-facing fields", () => {
    const proposal = buildClaimProposal(parseRelevantSourcesResponse(sample.response)!.sources[0]!)!;
    expect(proposal.url).toBe("https://sources.example/opinion");
    expect(proposal.title).toBe("Synthetic opinion summary");
    expect(proposal.author).toBe("R. Reporter, S. Second");
    expect(proposal.citation).toBeNull();
    expect(proposal.published).toBe("2025-11-04");
  });

  it("keeps every provider assessment inside opaque audit metadata, not an Ariadne field", () => {
    const proposal = buildClaimProposal(parseRelevantSourcesResponse(sample.response)!.sources[0]!)!;
    // The structured proposal has no generic score-shaped field of its own.
    expect(Object.keys(proposal).sort()).toEqual(["author", "citation", "metadata", "published", "title", "url"]);
    for (const key of ["confidence", "score", "probability", "relevance_score", "stance", "ariadne_score"]) {
      expect(key in proposal).toBe(false);
    }
    const audit = readAuditMetadata(proposal.metadata!) as { provider: Record<string, unknown> };
    expect(audit.provider.relevance_score).toBe(0.98);
    expect(audit.provider.stance).toBe("support");
    expect(audit.provider.reliability_score).toBe(0.77);
    expect(audit.provider.opensearch_rank).toBe(1);
    expect(audit.provider.justification).toContain("Provider-only assessment");
  });

  it("falls back to citation_object for URL and title", () => {
    const proposal = buildClaimProposal({ citation_object: { url: "https://fallback.test/a", title: "Fallback title" } } as never)!;
    expect(proposal.url).toBe("https://fallback.test/a");
    expect(proposal.title).toBe("Fallback title");
  });

  it("drops a source with no identifying field at all", () => {
    expect(buildClaimProposal({ url: "  ", title: "", citation_object: { authors: [] } } as never)).toBeNull();
  });
});

describe("ClaimSourceProposer", () => {
  it("sends the confirmed request shape (endpoint, header, body)", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ sources: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await new ClaimSourceProposer("test-key", { fetchImpl }).analyze(doc());

    expect(captured!.url).toBe("https://api.gptzero.me/v2/relevant_sources/");
    expect((captured!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(captured!.init.body))).toEqual({ text: expect.stringContaining("United States v. Ortiz") });
  });

  it("sends the claim-bearing passage rather than the whole document, truncated to a sentence budget", async () => {
    let body: { text: string } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ sources: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const document = { ...doc(), passage: "A".repeat(5_000), text: "unused document body" };
    await new ClaimSourceProposer("test-key", { fetchImpl, maxTextLength: 100 }).analyze(document);
    expect(body!.text).toBe("A".repeat(100));
  });

  it("maps a response into proposals and reports them through the debug hook", async () => {
    const events: ClaimSourceDebugEvent[] = [];
    const proposer = new ClaimSourceProposer("k", { fetchImpl: fakeFetch(200, sample.response), onDebug: (event) => events.push(event) });
    const analysis = await proposer.analyze(doc());
    expect(proposals(analysis).map((proposal) => proposal.url)).toEqual([
      "https://sources.example/opinion",
      "https://coverage.example/story",
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.proposals_returned).toBe(2);
    expect(events[0]!.response_status).toBe(200);
  });

  it("returns an empty proposal list for an empty source set", async () => {
    const analysis = await new ClaimSourceProposer("k", { fetchImpl: fakeFetch(200, { sources: [] }) }).analyze(doc());
    expect(proposals(analysis)).toEqual([]);
    expect(isPendingAnalysis(analysis)).toBe(false);
  });

  it("returns no proposals for a malformed body rather than throwing", async () => {
    expect(proposals(await new ClaimSourceProposer("k", { fetchImpl: fakeFetch(200, { sources: "nope" }) }).analyze(doc()))).toEqual([]);
    expect(proposals(await new ClaimSourceProposer("k", { fetchImpl: fakeFetch(200, "<html/>", false) }).analyze(doc()))).toEqual([]);
  });

  it("maps 429 to a pending analysis keyed to the claim endpoint, not to 'no upstream source'", async () => {
    const analysis = await new ClaimSourceProposer("k", { fetchImpl: fakeFetch(429, { error: "rate limited" }) }).analyze(doc());
    expect(isPendingAnalysis(analysis)).toBe(true);
    expect((analysis as { job_id: string }).job_id).toBe(claimJobId(doc()));
    expect((analysis as { retry_after_ms: number }).retry_after_ms).toBe(60_000);
  });

  it("reuses an existing continuation job id on a repeated 429", async () => {
    const analysis = await new ClaimSourceProposer("k", { fetchImpl: fakeFetch(429, {}) }).analyze(doc(), { job_id: "claim-sources:prior" });
    expect((analysis as { job_id: string }).job_id).toBe("claim-sources:prior");
  });

  it.each([401, 403])("throws a typed HTTP error on %i so a bad credential fails loudly", async (status) => {
    const proposer = new ClaimSourceProposer("k", { fetchImpl: fakeFetch(status, { error: "denied" }) });
    await expect(proposer.analyze(doc())).rejects.toBeInstanceOf(GPTZeroHttpError);
    await expect(proposer.analyze(doc())).rejects.toMatchObject({ status });
  });

  it("throws a typed HTTP error on 5xx", async () => {
    const proposer = new ClaimSourceProposer("k", { fetchImpl: fakeFetch(503, { error: "unavailable" }) });
    await expect(proposer.analyze(doc())).rejects.toMatchObject({ name: "GPTZeroHttpError", status: 503 });
  });

  it("throws a timeout error when the request is aborted", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const proposer = new ClaimSourceProposer("k", { fetchImpl, timeoutMs: 5 });
    await expect(proposer.analyze(doc())).rejects.toBeInstanceOf(GPTZeroTimeoutError);
    await expect(proposer.analyze(doc())).rejects.toThrow(/claim source search timed out/);
  });

  it("propagates a network error unchanged", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new ClaimSourceProposer("k", { fetchImpl }).analyze(doc())).rejects.toThrow("fetch failed");
  });

  it("never issues a request for an empty claim", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const analysis = await new ClaimSourceProposer("k", { fetchImpl }).analyze({ ...doc(), passage: "  ", text: "" });
    expect(proposals(analysis)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("MockClaimSourceProposer", () => {
  it("proposes nothing, so mocked runs supply their own fixtures", async () => {
    expect(await new MockClaimSourceProposer().analyze(doc())).toEqual([]);
  });
});
