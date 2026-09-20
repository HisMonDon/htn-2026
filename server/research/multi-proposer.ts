import { proposalIdentity, startProviderRun } from "../gptzero/composition";
import type { CandidateDocument } from "./extract";
import type { CompletedUpstreamAnalysis, UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "./traversal";

/**
 * Runs GPTZero and an independent web proposer for every analyzed source and merges their
 * candidates into one pool. This is the only place the two discovery channels meet: traversal still
 * sees a single `UpstreamSourceProposer`, fetches and validates every candidate itself, and cannot
 * tell (or care) which channel found it. Discovery channels are recorded on each proposal
 * (`discovered_by`) purely for audit; they are never provenance evidence.
 */

export const GPTZERO_CHANNEL = "gptzero";
export const WEB_CHANNEL = "web-search";

export interface ChannelFailureEvent {
  document_id: string;
  channel: typeof GPTZERO_CHANNEL | typeof WEB_CHANNEL;
  message: string;
}

export interface MultiSourceProposerOptions {
  /** Called when one channel failed but the other's results were still used (or both failed). Diagnostics only. */
  onChannelFailure?: (event: ChannelFailureEvent) => void;
  /** Sources whose web results are kept while GPTZero is paused, so a resume does not search again. Default 200. */
  cacheLimit?: number;
}

function isPending(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "pending";
}

function proposalsOf(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  if (Array.isArray(analysis)) return analysis;
  return isPending(analysis) ? [] : (analysis as { proposals: readonly UpstreamProposal[] }).proposals;
}

function fallbackOf(analysis: UpstreamAnalysis): CompletedUpstreamAnalysis["fallback"] {
  return Array.isArray(analysis) || isPending(analysis) ? null : ((analysis as CompletedUpstreamAnalysis).fallback ?? null);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function tag(proposals: readonly UpstreamProposal[], channel: string): UpstreamProposal[] {
  return proposals.map((proposal) => ({ ...proposal, discovered_by: unique([...(proposal.discovered_by ?? []), channel]) }));
}

/**
 * Merge candidates found by several channels. Identity reuses the repository's existing URL
 * canonicalization (`proposalIdentity`), so the same document found by both channels becomes one
 * candidate that remembers every channel that found it. The first occurrence wins, keeping order
 * deterministic; gaps in its descriptive fields are filled from later duplicates.
 */
export function mergeProposals(...lists: ReadonlyArray<readonly UpstreamProposal[]>): UpstreamProposal[] {
  const merged: UpstreamProposal[] = [];
  const byIdentity = new Map<string, number>();
  for (const proposal of lists.flat()) {
    const identity = proposalIdentity(proposal);
    const at = identity === null ? undefined : byIdentity.get(identity);
    if (at === undefined) {
      if (identity !== null) byIdentity.set(identity, merged.length);
      merged.push(proposal);
      continue;
    }
    const first = merged[at]!;
    merged[at] = {
      ...first,
      title: first.title ?? proposal.title,
      author: first.author ?? proposal.author,
      citation: first.citation ?? proposal.citation,
      published: first.published ?? proposal.published,
      discovered_by: unique([...(first.discovered_by ?? []), ...(proposal.discovered_by ?? [])]),
    };
  }
  return merged;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export class MultiSourceProposer implements UpstreamSourceProposer {
  readonly kind = "gptzero+web-search" as const;

  private readonly webCache = new Map<string, readonly UpstreamProposal[]>();

  constructor(
    private readonly gptzero: UpstreamSourceProposer,
    private readonly web: UpstreamSourceProposer,
    private readonly options: MultiSourceProposerOptions = {},
  ) {}

  /** Forwarded so GPTZero's per-invocation provider request ledger keeps working. */
  startRun(limit: number): void {
    startProviderRun(this.gptzero, limit);
  }

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    const cached = continuation ? this.webCache.get(document.id) : undefined;
    const [primary, secondary] = await Promise.allSettled([
      this.gptzero.analyze(document, continuation),
      cached ? Promise.resolve(cached) : this.web.analyze(document).then(proposalsOf),
    ]);

    const webProposals = secondary.status === "fulfilled" ? tag(secondary.value, WEB_CHANNEL) : [];
    if (secondary.status === "rejected") this.report(document.id, WEB_CHANNEL, secondary.reason);

    if (primary.status === "rejected") {
      this.report(document.id, GPTZERO_CHANNEL, primary.reason);
      // GPTZero erroring is not "GPTZero found nothing": with nothing from the web either, surface
      // the failure so traversal records a provider failure exactly as it did before.
      if (webProposals.length === 0) {
        if (secondary.status === "rejected") {
          throw new Error(`${messageOf(primary.reason)}; web search also failed: ${messageOf(secondary.reason)}`);
        }
        throw primary.reason;
      }
      this.webCache.delete(document.id);
      return { status: "completed", proposals: webProposals };
    }

    if (isPending(primary.value)) {
      // Paused work resumes later; keep this run's web results (even an empty answer) so the resume
      // doesn't repeat identical searches. A failed search is not kept: the resume may retry it.
      if (secondary.status === "fulfilled") this.remember(document.id, webProposals);
      return primary.value;
    }

    this.webCache.delete(document.id);
    const proposals = mergeProposals(tag(proposalsOf(primary.value), GPTZERO_CHANNEL), webProposals);
    return { status: "completed", proposals, fallback: fallbackOf(primary.value) };
  }

  private remember(id: string, proposals: readonly UpstreamProposal[]): void {
    this.webCache.set(id, proposals);
    const limit = this.options.cacheLimit ?? 200;
    while (this.webCache.size > limit) this.webCache.delete(this.webCache.keys().next().value!);
  }

  private report(documentId: string, channel: ChannelFailureEvent["channel"], reason: unknown): void {
    this.options.onChannelFailure?.({ document_id: documentId, channel, message: messageOf(reason) });
  }
}
