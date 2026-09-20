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
export const SEMANTIC_SCHOLAR_CHANNEL = "semantic-scholar";
export const DOCUMENT_NATIVE_CHANNEL = "document-native";

export interface ChannelFailureEvent {
  document_id: string;
  channel: typeof GPTZERO_CHANNEL | typeof WEB_CHANNEL | typeof SEMANTIC_SCHOLAR_CHANNEL | typeof DOCUMENT_NATIVE_CHANNEL;
  message: string;
}

export interface MultiSourceProposerOptions {
  /** Called when one channel failed but the other's results were still used (or both failed). Diagnostics only. */
  onChannelFailure?: (event: ChannelFailureEvent) => void;
  /** Sources whose web results are kept while GPTZero is paused, so a resume does not search again. Default 200. */
  cacheLimit?: number;
  /**
   * Deterministic document-native discovery (outbound links, DOI/arXiv/docket/case-name text
   * extraction). Unlike the web and Semantic Scholar channels this never calls out to a provider,
   * so it always runs, including on a resumed/paused analysis, and never gates the cached-search
   * short-circuit below.
   */
  native?: UpstreamSourceProposer;
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

function isProposer(value: UpstreamSourceProposer | MultiSourceProposerOptions | null): value is UpstreamSourceProposer {
  return value !== null && typeof (value as Partial<UpstreamSourceProposer>).analyze === "function";
}

export class MultiSourceProposer implements UpstreamSourceProposer {
  readonly kind = "gptzero+web-search+semantic-scholar" as const;

  private readonly supplementalCache = new Map<string, readonly UpstreamProposal[]>();
  private readonly semanticScholar: UpstreamSourceProposer | null;
  private readonly options: MultiSourceProposerOptions;

  constructor(
    private readonly gptzero: UpstreamSourceProposer,
    private readonly web: UpstreamSourceProposer | null,
    semanticScholarOrOptions: UpstreamSourceProposer | MultiSourceProposerOptions | null = null,
    options: MultiSourceProposerOptions = {},
  ) {
    // Keep the original `(gptzero, web, options)` call shape while allowing the newer optional
    // citation channel as `(gptzero, web, semanticScholar, options)`.
    if (isProposer(semanticScholarOrOptions)) {
      this.semanticScholar = semanticScholarOrOptions;
      this.options = options;
    } else {
      this.semanticScholar = null;
      this.options = (semanticScholarOrOptions as MultiSourceProposerOptions | null) ?? options;
    }
  }

  /** Forwarded so GPTZero's per-invocation provider request ledger keeps working. */
  startRun(limit: number): void {
    startProviderRun(this.gptzero, limit);
  }

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    // Citation metadata nodes deliberately have no full text. Their recursive work is a citation
    // graph lookup only; sending their empty body to GPTZero/web would neither help nor be a real
    // document analysis.
    if (document.academic_metadata?.metadata_only) {
      if (!this.semanticScholar) return [];
      return this.semanticScholar.analyze(document, continuation);
    }
    const cached = continuation ? this.supplementalCache.get(document.id) : undefined;
    const [primary, webResult, semanticResult, nativeResult] = await Promise.allSettled([
      this.gptzero.analyze(document, continuation),
      cached ? Promise.resolve([] as readonly UpstreamProposal[]) : this.web ? this.web.analyze(document).then(proposalsOf) : Promise.resolve([] as readonly UpstreamProposal[]),
      cached ? Promise.resolve(cached) : this.semanticScholar ? this.semanticScholar.analyze(document).then(proposalsOf) : Promise.resolve([] as readonly UpstreamProposal[]),
      this.options.native ? this.options.native.analyze(document).then(proposalsOf) : Promise.resolve([] as readonly UpstreamProposal[]),
    ]);

    const webProposals = webResult.status === "fulfilled" ? tag(webResult.value, WEB_CHANNEL) : [];
    const semanticProposals = semanticResult.status === "fulfilled" ? tag(semanticResult.value, SEMANTIC_SCHOLAR_CHANNEL) : [];
    const nativeProposals = nativeResult.status === "fulfilled" ? tag(nativeResult.value, DOCUMENT_NATIVE_CHANNEL) : [];
    const supplemental = mergeProposals(cached ?? mergeProposals(webProposals, semanticProposals), nativeProposals);
    if (webResult.status === "rejected") this.report(document.id, WEB_CHANNEL, webResult.reason);
    if (semanticResult.status === "rejected") this.report(document.id, SEMANTIC_SCHOLAR_CHANNEL, semanticResult.reason);
    if (nativeResult.status === "rejected") this.report(document.id, DOCUMENT_NATIVE_CHANNEL, nativeResult.reason);

    if (primary.status === "rejected") {
      this.report(document.id, GPTZERO_CHANNEL, primary.reason);
      // GPTZero erroring is not "GPTZero found nothing": with no supplemental candidates either, surface
      // the failure so traversal records a provider failure exactly as it did before.
      if (supplemental.length === 0) {
        if (webResult.status === "rejected" || semanticResult.status === "rejected") {
          const failures = [
            webResult.status === "rejected" ? `web search also failed: ${messageOf(webResult.reason)}` : null,
            semanticResult.status === "rejected" ? `Semantic Scholar also failed: ${messageOf(semanticResult.reason)}` : null,
          ].filter(Boolean).join("; ");
          throw new Error(`${messageOf(primary.reason)}; ${failures}`);
        }
        throw primary.reason;
      }
      this.supplementalCache.delete(document.id);
      return { status: "completed", proposals: supplemental };
    }

    if (isPending(primary.value)) {
      // Paused work resumes later; keep successful supplemental results (even an empty answer) so
      // the resume doesn't repeat identical searches/graph calls. Failed channels may retry.
      if (webResult.status === "fulfilled" && semanticResult.status === "fulfilled") this.remember(document.id, supplemental);
      return primary.value;
    }

    this.supplementalCache.delete(document.id);
    const proposals = mergeProposals(tag(proposalsOf(primary.value), GPTZERO_CHANNEL), supplemental);
    return { status: "completed", proposals, fallback: fallbackOf(primary.value) };
  }

  private remember(id: string, proposals: readonly UpstreamProposal[]): void {
    this.supplementalCache.set(id, proposals);
    const limit = this.options.cacheLimit ?? 200;
    while (this.supplementalCache.size > limit) this.supplementalCache.delete(this.supplementalCache.keys().next().value!);
  }

  private report(documentId: string, channel: ChannelFailureEvent["channel"], reason: unknown): void {
    this.options.onChannelFailure?.({ document_id: documentId, channel, message: messageOf(reason) });
  }
}
