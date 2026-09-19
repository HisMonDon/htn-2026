import { canonicalUrl, type CandidateDocument } from "../research/extract";
import type { UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../research/traversal";
import { createBibliographyProposer } from "./bibliography";
import { ClaimSourceProposer, CLAIM_JOB_PREFIX, claimJobId } from "./relevant-sources";

/**
 * Composes GPTZero's two candidate-source endpoints behind the single `UpstreamSourceProposer`
 * boundary `traverseProvenance` consumes. Traversal stays unaware that there are two endpoints:
 * it still calls `analyze()` once per source and still receives ordinary `UpstreamProposal`s that
 * it fetches, canonicalizes and scores itself.
 *
 * Strategy: bibliography-first with a claim-level fallback (strategy A). The claim endpoint runs
 * only when the bibliography scan *succeeded and proposed nothing* for this source — the exact
 * case where traversal would otherwise terminate `no-proposals` because GPTZero's own
 * check-worthiness filter declined the claim, rather than because no upstream source exists.
 */

function isProposalList(analysis: UpstreamAnalysis): analysis is readonly UpstreamProposal[] {
  return Array.isArray(analysis);
}

function isPendingAnalysis(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  return !isProposalList(analysis) && (analysis as { status?: string }).status === "pending";
}

function proposalsOf(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  if (isProposalList(analysis)) return analysis;
  return isPendingAnalysis(analysis) ? [] : analysis.proposals;
}

function fallbackOf(analysis: UpstreamAnalysis): { provenance: "cached_demo_fallback"; capturedAt: string } | null {
  if (isProposalList(analysis) || isPendingAnalysis(analysis)) return null;
  return analysis.fallback ?? null;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Identity for duplicate-candidate suppression, reusing the repository's existing URL
 * canonicalization (`research/extract.ts`) rather than introducing a second normalizer.
 *
 * A proposal with a usable URL is keyed by that canonical URL alone. A URL-less proposal is keyed
 * by *exact* normalized title + author + citation — case and whitespace only. Similar titles are
 * deliberately never merged: two distinct opinions with near-identical captions must both reach
 * acquisition, where canonicalization by content fingerprint settles real duplicates.
 */
export function proposalIdentity(proposal: UpstreamProposal): string | null {
  if (proposal.url?.trim()) {
    try {
      const url = new URL(proposal.url);
      if (url.protocol === "http:" || url.protocol === "https:") return `url:${canonicalUrl(url.toString())}`;
    } catch {
      // Not a usable URL; fall through to the bibliographic key.
    }
  }
  const reference = [normalize(proposal.title), normalize(proposal.author), normalize(proposal.citation)];
  return reference.some(Boolean) ? `ref:${reference.join("|")}` : null;
}

/**
 * Drop repeated candidates before traversal spends a fetch on them, keeping the first occurrence
 * so ordering stays deterministic. Proposals with no identifying field at all are kept: traversal
 * rejects them itself, with its own `invalid-proposal` reason.
 */
export function dedupeProposals(proposals: readonly UpstreamProposal[]): UpstreamProposal[] {
  const seen = new Set<string>();
  const unique: UpstreamProposal[] = [];
  for (const proposal of proposals) {
    const identity = proposalIdentity(proposal);
    if (identity !== null) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    unique.push(proposal);
  }
  return unique;
}

/**
 * A per-traversal-call ledger of *provider HTTP requests*, not of `analyze()` calls.
 *
 * `traverseProvenance` caps `analyze()` invocations with `maxProviderRequests`. A bibliography ->
 * claim fallback issues two outbound GPTZero requests inside one invocation, so without this the
 * run could quietly double its real provider usage. Every outbound request consumes a slot here;
 * when the ledger is empty the composed proposer hands traversal a pending analysis instead of
 * exceeding the budget, so the remaining work resumes on the next invocation.
 */
export interface ProviderRequestBudget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  tryConsume(): boolean;
}

export function createProviderRequestBudget(limit: number): ProviderRequestBudget {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("provider request budget must be a positive integer");
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    tryConsume() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

export type CompositionStrategy =
  /** The bibliography scan proposed candidates; the claim endpoint was not called. */
  | "bibliography"
  /** The bibliography scan proposed nothing and the claim endpoint was called as a fallback. */
  | "claim-fallback"
  /** Resumed directly into the claim endpoint from a deferred or rate-limited fallback. */
  | "claim-resume"
  /** The bibliography scan proposed nothing and the request budget had no room for the fallback. */
  | "claim-deferred"
  /** The bibliography scan paused (rate limit / provider job); the claim endpoint was not called. */
  | "bibliography-pending";

export interface CompositionEvent {
  document_id: string;
  strategy: CompositionStrategy;
  bibliography_proposals: number;
  claim_proposals: number;
  /** Candidates dropped because another endpoint (or the same one) already proposed them. */
  duplicates_removed: number;
  provider_requests_used: number;
  provider_request_limit: number;
}

export interface ClaimFallbackProposerOptions {
  /** Budget used until {@link ClaimFallbackProposer.startRun} is called. Default 10. */
  defaultLimit?: number;
  /** Structured diagnostics for which endpoint supplied this source's candidates. Debug only. */
  onComposition?: (event: CompositionEvent) => void;
  /** Delay reported when the fallback is deferred for budget reasons. Default 0 (resume at once). */
  deferredRetryAfterMs?: number;
}

const DEFAULT_LIMIT = 10;

export class ClaimFallbackProposer implements UpstreamSourceProposer {
  readonly kind = "gptzero-bibliography+claim" as const;

  private budget: ProviderRequestBudget;

  constructor(
    private readonly bibliography: UpstreamSourceProposer,
    private readonly claim: UpstreamSourceProposer,
    private readonly options: ClaimFallbackProposerOptions = {},
  ) {
    this.budget = createProviderRequestBudget(options.defaultLimit ?? DEFAULT_LIMIT);
  }

  /** Start a fresh provider-request budget for one `traverseProvenance` invocation. */
  startRun(limit: number): void {
    this.budget = createProviderRequestBudget(limit);
  }

  /** Current provider HTTP request usage, for diagnostics and tests. */
  get requestBudget(): ProviderRequestBudget {
    return this.budget;
  }

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    if (continuation?.job_id.startsWith(CLAIM_JOB_PREFIX)) {
      if (!this.budget.tryConsume()) return this.defer(document, 0, 0, "claim-resume");
      return this.runClaim(document, [], null, continuation, "claim-resume");
    }

    if (!this.budget.tryConsume()) {
      // The ledger is spent even before the bibliography call. Pause rather than overspend; the
      // original continuation (if any) is preserved so the resume behaves identically.
      return { status: "pending", job_id: continuation?.job_id ?? claimJobId(document), retry_after_ms: this.options.deferredRetryAfterMs ?? 0 };
    }

    // A provider failure propagates untouched. "The scan errored" and "the scan found nothing" are
    // different facts, and only the second one licenses the claim-level fallback.
    const analysis = await this.bibliography.analyze(document, continuation);
    if (isPendingAnalysis(analysis)) {
      this.emit(document, "bibliography-pending", 0, 0, 0);
      return analysis;
    }

    const bibliographyProposals = proposalsOf(analysis);
    if (bibliographyProposals.length > 0) {
      this.emit(document, "bibliography", bibliographyProposals.length, 0, 0);
      // Returned unchanged so an existing `cached_demo_fallback` marker still reaches traversal.
      return analysis;
    }

    if (!this.budget.tryConsume()) return this.defer(document, 0, 0, "claim-deferred");
    return this.runClaim(document, bibliographyProposals, fallbackOf(analysis), undefined, "claim-fallback");
  }

  private async runClaim(
    document: CandidateDocument,
    bibliographyProposals: readonly UpstreamProposal[],
    fallback: { provenance: "cached_demo_fallback"; capturedAt: string } | null,
    continuation: { job_id: string } | undefined,
    strategy: CompositionStrategy,
  ): Promise<UpstreamAnalysis> {
    const analysis = await this.claim.analyze(document, continuation);
    if (isPendingAnalysis(analysis)) {
      this.emit(document, strategy, bibliographyProposals.length, 0, 0);
      return analysis;
    }
    const claimProposals = proposalsOf(analysis);
    const combined = [...bibliographyProposals, ...claimProposals];
    const proposals = dedupeProposals(combined);
    this.emit(document, strategy, bibliographyProposals.length, claimProposals.length, combined.length - proposals.length);
    return { status: "completed", proposals, fallback };
  }

  private defer(
    document: CandidateDocument,
    bibliographyProposals: number,
    claimProposals: number,
    strategy: CompositionStrategy,
  ): UpstreamAnalysis {
    this.emit(document, strategy, bibliographyProposals, claimProposals, 0);
    return { status: "pending", job_id: claimJobId(document), retry_after_ms: this.options.deferredRetryAfterMs ?? 0 };
  }

  private emit(
    document: CandidateDocument,
    strategy: CompositionStrategy,
    bibliographyProposals: number,
    claimProposals: number,
    duplicatesRemoved: number,
  ): void {
    this.options.onComposition?.({
      document_id: document.id,
      strategy,
      bibliography_proposals: bibliographyProposals,
      claim_proposals: claimProposals,
      duplicates_removed: duplicatesRemoved,
      provider_requests_used: this.budget.used,
      provider_request_limit: this.budget.limit,
    });
  }
}

/** Optional run-scoped budget hook, so callers need not know which proposer they were given. */
export interface RunScopedProposer extends UpstreamSourceProposer {
  startRun(limit: number): void;
}

function isRunScoped(proposer: UpstreamSourceProposer): proposer is RunScopedProposer {
  return typeof (proposer as Partial<RunScopedProposer>).startRun === "function";
}

/** Reset the provider request ledger for one traversal invocation. A no-op for plain proposers. */
export function startProviderRun(proposer: UpstreamSourceProposer, limit: number): void {
  if (isRunScoped(proposer)) proposer.startRun(limit);
}

/**
 * The upstream proposer the live API uses. Mock and unconfigured modes are unchanged: they keep
 * returning exactly what `createBibliographyProposer` returned before the claim endpoint existed,
 * so the offline Cohen demo and every mocked test behave identically.
 */
export function createUpstreamSourceProposer(
  config: { useMocks: boolean; gptzeroApiKey: string | null },
  options: ClaimFallbackProposerOptions = {},
): UpstreamSourceProposer {
  const bibliography = createBibliographyProposer(config);
  if (config.useMocks || !config.gptzeroApiKey) return bibliography;
  return new ClaimFallbackProposer(bibliography, new ClaimSourceProposer(config.gptzeroApiKey), options);
}
