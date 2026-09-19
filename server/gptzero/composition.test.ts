import { describe, expect, it, vi } from "vitest";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { readAuditMetadata, toAuditMetadata } from "../research/providers";
import type { UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../research/traversal";
import { GPTZeroHttpError, GPTZeroTimeoutError, MockBibliographyProposer } from "./bibliography";
import {
  ClaimFallbackProposer,
  createProviderRequestBudget,
  createUpstreamSourceProposer,
  dedupeProposals,
  proposalIdentity,
  startProviderRun,
  type CompositionEvent,
} from "./composition";
import { claimJobId } from "./relevant-sources";

function isPending(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "pending";
}

function proposals(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  if (Array.isArray(analysis)) return analysis;
  return isPending(analysis) ? [] : (analysis as { proposals: readonly UpstreamProposal[] }).proposals;
}

function doc(): CandidateDocument {
  return extractDocument({
    url: "https://sources.test/brief",
    html: "<html><head><title>Brief</title></head><body><article><p>The motion relies on United States v. Ortiz.</p></article></body></html>",
    fabricated: [],
    claimTerms: [],
    discoveredVia: "test",
  });
}

function stub(result: UpstreamAnalysis | (() => Promise<UpstreamAnalysis>)): UpstreamSourceProposer & { analyze: ReturnType<typeof vi.fn> } {
  const analyze = vi.fn(async () => (typeof result === "function" ? result() : result));
  return { analyze } as never;
}

function compose(
  bibliography: UpstreamSourceProposer,
  claim: UpstreamSourceProposer,
  limit = 10,
): { proposer: ClaimFallbackProposer; events: CompositionEvent[] } {
  const events: CompositionEvent[] = [];
  const proposer = new ClaimFallbackProposer(bibliography, claim, { defaultLimit: limit, onComposition: (event) => events.push(event) });
  return { proposer, events };
}

describe("proposalIdentity / dedupeProposals", () => {
  it("reuses existing URL canonicalization rather than a second normalizer", () => {
    expect(proposalIdentity({ url: "https://WWW.Example.com/a/?utm_source=x#frag" })).toBe(proposalIdentity({ url: "https://example.com/a" }));
  });

  it("drops a candidate both endpoints returned, keeping the first occurrence", () => {
    const unique = dedupeProposals([
      { url: "https://example.com/a", title: "From bibliography" },
      { url: "https://www.example.com/a/", title: "From claim endpoint" },
      { url: "https://example.com/b", title: "Other" },
    ]);
    expect(unique.map((proposal) => proposal.title)).toEqual(["From bibliography", "Other"]);
  });

  it("never merges genuinely distinct documents with similar titles", () => {
    const unique = dedupeProposals([
      { url: null, title: "United States v. Ortiz", author: "Second Circuit" },
      { url: null, title: "United States v. Ortiz (II)", author: "Second Circuit" },
      { url: "https://a.test/x", title: "United States v. Ortiz" },
    ]);
    expect(unique).toHaveLength(3);
  });

  it("merges URL-less references only on exact normalized title/author/citation equality", () => {
    const unique = dedupeProposals([
      { url: null, title: "United States v. Ortiz", author: "Second Circuit" },
      { url: null, title: "  united states v.   ORTIZ ", author: "second circuit" },
    ]);
    expect(unique).toHaveLength(1);
  });

  it("keeps unidentifiable proposals so traversal can reject them with its own reason", () => {
    expect(dedupeProposals([{ url: null }, { url: null }])).toHaveLength(2);
  });
});

describe("createProviderRequestBudget", () => {
  it("counts outbound provider requests and stops at the limit", () => {
    const budget = createProviderRequestBudget(2);
    expect([budget.tryConsume(), budget.tryConsume(), budget.tryConsume()]).toEqual([true, true, false]);
    expect(budget.used).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it("rejects a non-positive limit", () => {
    expect(() => createProviderRequestBudget(0)).toThrow(/positive integer/);
  });
});

describe("ClaimFallbackProposer", () => {
  const bibliographyProposal: UpstreamProposal = { url: "https://bibliography.test/a", title: "From bibliography" };
  const claimProposal: UpstreamProposal = { url: "https://claim.test/b", title: "From claim endpoint" };

  it("uses bibliography proposals and never issues a claim request when they exist", async () => {
    const bibliography = stub([bibliographyProposal]);
    const claim = stub([claimProposal]);
    const { proposer, events } = compose(bibliography, claim);

    const analysis = await proposer.analyze(doc());

    expect(proposals(analysis)).toEqual([bibliographyProposal]);
    expect(claim.analyze).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ strategy: "bibliography", bibliography_proposals: 1, claim_proposals: 0, provider_requests_used: 1 });
  });

  it("falls back to the claim endpoint when the bibliography scan succeeded with no proposals", async () => {
    const bibliography = stub([]);
    const claim = stub([claimProposal]);
    const { proposer, events } = compose(bibliography, claim);

    const analysis = await proposer.analyze(doc());

    expect(proposals(analysis)).toEqual([claimProposal]);
    expect(claim.analyze).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ strategy: "claim-fallback", claim_proposals: 1, provider_requests_used: 2 });
  });

  it("deduplicates candidates the two endpoints both return", async () => {
    const bibliography = stub({ status: "completed", proposals: [] });
    const claim = stub([
      { url: "https://claim.test/b", title: "First" },
      { url: "https://www.claim.test/b/", title: "Duplicate" },
    ]);
    const { proposer, events } = compose(bibliography, claim);

    const analysis = await proposer.analyze(doc());

    expect(proposals(analysis).map((proposal) => proposal.title)).toEqual(["First"]);
    expect(events[0]!.duplicates_removed).toBe(1);
  });

  it("propagates a bibliography provider failure instead of calling the claim endpoint", async () => {
    const bibliography = stub(async () => {
      throw new GPTZeroHttpError(500, "boom");
    });
    const claim = stub([claimProposal]);
    const { proposer } = compose(bibliography, claim);

    await expect(proposer.analyze(doc())).rejects.toBeInstanceOf(GPTZeroHttpError);
    expect(claim.analyze).not.toHaveBeenCalled();
  });

  it.each([
    ["401", new GPTZeroHttpError(401, "unauthorized")],
    ["timeout", new GPTZeroTimeoutError(10)],
  ])("does not treat a bibliography %s as evidence that no upstream source exists", async (_label, error) => {
    const claim = stub([claimProposal]);
    const { proposer } = compose(
      stub(async () => {
        throw error;
      }),
      claim,
    );
    await expect(proposer.analyze(doc())).rejects.toBe(error);
    expect(claim.analyze).not.toHaveBeenCalled();
  });

  it("passes a bibliography pending analysis straight through without a claim request", async () => {
    const claim = stub([claimProposal]);
    const { proposer, events } = compose(stub({ status: "pending", job_id: "job-1", retry_after_ms: 60_000 }), claim);

    const analysis = await proposer.analyze(doc());

    expect(analysis).toEqual({ status: "pending", job_id: "job-1", retry_after_ms: 60_000 });
    expect(claim.analyze).not.toHaveBeenCalled();
    expect(events[0]!.strategy).toBe("bibliography-pending");
  });

  it("resumes a bibliography job id through the bibliography endpoint", async () => {
    const bibliography = stub([bibliographyProposal]);
    const { proposer } = compose(bibliography, stub([claimProposal]));
    await proposer.analyze(doc(), { job_id: "job-1" });
    expect(bibliography.analyze).toHaveBeenCalledWith(expect.anything(), { job_id: "job-1" });
  });

  it("resumes a claim-stage job id straight into the claim endpoint, skipping the bibliography scan", async () => {
    const bibliography = stub([bibliographyProposal]);
    const claim = stub([claimProposal]);
    const { proposer, events } = compose(bibliography, claim);

    const analysis = await proposer.analyze(doc(), { job_id: claimJobId(doc()) });

    expect(bibliography.analyze).not.toHaveBeenCalled();
    expect(proposals(analysis)).toEqual([claimProposal]);
    expect(events[0]!.strategy).toBe("claim-resume");
    expect(proposer.requestBudget.used).toBe(1);
  });

  it("propagates a claim-endpoint 429 as pending rather than as 'no upstream source'", async () => {
    const { proposer } = compose(stub([]), stub({ status: "pending", job_id: claimJobId(doc()), retry_after_ms: 60_000 }));
    const analysis = await proposer.analyze(doc());
    expect(isPending(analysis)).toBe(true);
    expect((analysis as { job_id: string }).job_id).toBe(claimJobId(doc()));
  });

  it("propagates a claim-endpoint failure as a provider error", async () => {
    const { proposer } = compose(
      stub([]),
      stub(async () => {
        throw new GPTZeroHttpError(503, "unavailable");
      }),
    );
    await expect(proposer.analyze(doc())).rejects.toMatchObject({ status: 503 });
  });

  it("returns an empty completed analysis when neither endpoint proposes anything", async () => {
    const { proposer } = compose(stub([]), stub([]));
    const analysis = await proposer.analyze(doc());
    expect(isPending(analysis)).toBe(false);
    expect(proposals(analysis)).toEqual([]);
  });

  it("preserves a cached_demo_fallback marker so the existing traversal diagnostic still fires", async () => {
    const bibliography = stub({
      status: "completed",
      proposals: [bibliographyProposal],
      fallback: { provenance: "cached_demo_fallback", capturedAt: "2026-09-19T19:14:20.000Z" },
    });
    const analysis = await compose(bibliography, stub([])).proposer.analyze(doc());
    expect((analysis as { fallback: unknown }).fallback).toEqual({ provenance: "cached_demo_fallback", capturedAt: "2026-09-19T19:14:20.000Z" });
  });

  it("carries the cached fallback marker through a claim fallback too", async () => {
    const bibliography = stub({
      status: "completed",
      proposals: [],
      fallback: { provenance: "cached_demo_fallback", capturedAt: "2026-09-19T19:14:20.000Z" },
    });
    const analysis = await compose(bibliography, stub([claimProposal])).proposer.analyze(doc());
    expect((analysis as { fallback: unknown }).fallback).toEqual({ provenance: "cached_demo_fallback", capturedAt: "2026-09-19T19:14:20.000Z" });
  });

  it("keeps provider audit metadata opaque end to end", async () => {
    const proposal: UpstreamProposal = {
      url: "https://claim.test/b",
      metadata: toAuditMetadata({ provider: { relevance_score: 0.99, stance: "contradict" } }),
    };
    const analysis = await compose(stub([]), stub([proposal])).proposer.analyze(doc());
    const [only] = proposals(analysis);
    expect("confidence" in only!).toBe(false);
    expect((readAuditMetadata(only!.metadata!) as { provider: { relevance_score: number } }).provider.relevance_score).toBe(0.99);
  });
});

describe("provider request accounting", () => {
  it("counts both endpoints against one budget, not one per analyze() call", async () => {
    const { proposer, events } = compose(stub([]), stub([{ url: "https://claim.test/b" }]), 10);
    await proposer.analyze(doc());
    expect(proposer.requestBudget.used).toBe(2);
    expect(events[0]!.provider_requests_used).toBe(2);
  });

  it("defers the fallback instead of overspending the budget", async () => {
    const claim = stub([{ url: "https://claim.test/b" }]);
    const { proposer, events } = compose(stub([]), claim, 1);

    const analysis = await proposer.analyze(doc());

    expect(claim.analyze).not.toHaveBeenCalled();
    expect(isPending(analysis)).toBe(true);
    expect((analysis as { job_id: string }).job_id).toBe(claimJobId(doc()));
    expect(events[0]!.strategy).toBe("claim-deferred");
    expect(proposer.requestBudget.used).toBe(1);
  });

  it("pauses before the bibliography call once the budget is spent", async () => {
    const bibliography = stub([{ url: "https://bibliography.test/a" }]);
    const { proposer } = compose(bibliography, stub([]), 1);
    await proposer.analyze(doc());
    const second = await proposer.analyze({ ...doc(), id: "other" });
    expect(bibliography.analyze).toHaveBeenCalledTimes(1);
    expect(isPending(second)).toBe(true);
  });

  it("startRun resets the ledger for the next traversal invocation", async () => {
    const { proposer } = compose(stub([]), stub([{ url: "https://claim.test/b" }]), 2);
    await proposer.analyze(doc());
    expect(proposer.requestBudget.used).toBe(2);
    startProviderRun(proposer, 4);
    expect(proposer.requestBudget.used).toBe(0);
    expect(proposer.requestBudget.limit).toBe(4);
  });

  it("startProviderRun is a no-op for a proposer without a ledger", () => {
    expect(() => startProviderRun(new MockBibliographyProposer(), 3)).not.toThrow();
  });
});

describe("createUpstreamSourceProposer", () => {
  it("leaves mock mode exactly as it was, with no claim endpoint attached", async () => {
    const proposer = createUpstreamSourceProposer({ useMocks: true, gptzeroApiKey: "k" });
    expect(proposer).toBeInstanceOf(MockBibliographyProposer);
    expect(await proposer.analyze(doc())).toEqual([]);
  });

  it("leaves the unconfigured-credential path failing loudly", async () => {
    const proposer = createUpstreamSourceProposer({ useMocks: false, gptzeroApiKey: null });
    await expect(proposer.analyze(doc())).rejects.toThrow(/GPTZERO_API_KEY is not set/);
  });

  it("composes both endpoints when a live credential is configured", () => {
    expect(createUpstreamSourceProposer({ useMocks: false, gptzeroApiKey: "k" })).toBeInstanceOf(ClaimFallbackProposer);
  });
});
