import type { TreeEdge } from "../../shared/tree";
import { canonicalizeDocuments } from "./canonicalize";
import { claimTerms } from "./discovery";
import { computeTimings, MIN_COVERAGE, ordering, scoreEdge, temporalEvidence as temporal, type ScoredEdge, type Timing } from "./edges";
import { canonicalUrl, type CandidateDocument } from "./extract";
import { ingestSourceReference, type IngestionFailure } from "./ingestion";
import { analyzeClaimMutations } from "./mutations";
import type { PageFetcher, SourceReference, SourceResolver } from "./providers";
import { ACCEPT_THRESHOLD } from "./tree";

/** A provider may suggest candidates, but it never decides that an edge exists. */
export interface UpstreamProposal extends SourceReference {
  /** Optional search/provider publication date; normal ingestion still ranks stronger page evidence first. */
  published?: string | null;
}

/**
 * A deliberately provider-neutral analysis boundary. Implementations can return proposals
 * immediately or hand back a durable job ID to resume later. The traversal owns scheduling,
 * fetching, normalization, and validation; this interface never authorizes an edge by itself.
 */
export interface UpstreamSourceProposer {
  analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis>;
}

/** Kept as an alias for callers that adopted the first traversal draft. */
export type ProposedUpstreamSource = UpstreamProposal;

export type UpstreamAnalysis = readonly UpstreamProposal[] | CompletedUpstreamAnalysis | PendingUpstreamAnalysis;

export interface CompletedUpstreamAnalysis {
  status: "completed";
  proposals: readonly UpstreamProposal[];
  /** Set when this result was served from a provider's offline fallback instead of a live call. */
  fallback?: { provenance: "cached_demo_fallback"; capturedAt: string } | null;
}

export interface PendingUpstreamAnalysis {
  status: "pending";
  /** Provider-owned ID suitable for durable storage and a later `analyze` continuation. */
  job_id: string;
  /** The provider's requested delay. Null leaves scheduling to the caller. */
  retry_after_ms?: number | null;
}

function isProposalList(analysis: UpstreamAnalysis): analysis is readonly UpstreamProposal[] {
  return Array.isArray(analysis);
}

function isPendingAnalysis(analysis: UpstreamAnalysis): analysis is PendingUpstreamAnalysis {
  return !isProposalList(analysis) && analysis.status === "pending";
}

export type SourceTerminationReason =
  | "no-proposals"
  | "max-depth"
  | "provider-failure"
  | "all-proposals-rejected"
  | "accepted-parents"
  /** A submitted-text query discovered real documents that now act as traversal roots. */
  | "candidate-roots";

export type ProposedEdgeTerminationReason =
  | "invalid-proposal"
  | "fetch-failure"
  | "duplicate-source"
  | "cycle"
  | "already-visited"
  | "already-accepted"
  | "validation-rejected";

export interface SourceTermination {
  source_id: string;
  url: string;
  depth: number;
  reason: SourceTerminationReason;
  detail: string | null;
}

export type TraversalPauseReason = "provider-pending" | "rate-limit";

export interface PendingAnalysisJob {
  source_id: string;
  url: string;
  depth: number;
  job_id: string | null;
  reason: TraversalPauseReason;
  retry_after_ms: number | null;
}

/** Every rejected provider suggestion is preserved independently of the legacy tree's rejected edges. */
export interface RejectedProposedEdge {
  parent_url: string;
  parent_id: string | null;
  child_id: string;
  confidence: number | null;
  reason: string;
  termination: ProposedEdgeTerminationReason;
  stage?: IngestionFailure["stage"];
  category?: string;
  recoverable?: boolean;
}

export interface TraversalDiagnostic {
  stage: "gptzero" | "resolution" | "fetch" | "extraction" | "validation" | "traversal";
  source: string | null;
  category: string;
  message: string;
  recoverable: boolean;
}

export interface AcceptedProposedEdge extends TreeEdge {
  /** True only for the first accepted route that schedules this source for expansion. */
  recursed: boolean;
}

/**
 * A fetched source proposed for submitted text. This is a discovery relationship, never a
 * provenance verdict: its source remains eligible for ordinary recursive validation.
 *
 * Source -> target retains the graph-wide upstream -> downstream orientation.
 */
export interface CandidateMatch {
  source_id: string;
  target_id: string;
}

export interface RecursiveProvenanceTraversal {
  /** Canonical artifacts, including fetched mirrors merged by existing canonicalization. */
  documents: CandidateDocument[];
  /** A DAG: multiple independently validated upstream sources may parent the same document. */
  accepted_edges: AcceptedProposedEdge[];
  /** Claim-only bootstrap discovery; deliberately excluded from the validated provenance DAG. */
  candidate_matches: CandidateMatch[];
  /** Provider suggestions that were never accepted, with the exact terminating reason. */
  rejected_edges: RejectedProposedEdge[];
  /** One completion record for every source that was expanded. */
  terminations: SourceTermination[];
  /** Pending work is never mistaken for a rejected edge or a completed source. */
  pending_jobs: PendingAnalysisJob[];
  diagnostics: TraversalDiagnostic[];
  status: "complete" | "partial" | "failed" | "paused";
  /** Pass this opaque, serializable state to a later call to continue queued or provider-pending work. */
  checkpoint: TraversalCheckpoint | null;
  stats: {
    max_depth: number;
    sources_expanded: number;
    proposals_received: number;
    fetched: number;
    fetch_failures: number;
    analysis_requests: number;
  };
}

export interface TraverseProvenanceInput {
  /** Source A: it is already ingested by ordinary Lineage discovery. */
  seed: CandidateDocument;
  /** The claim and known citations let fetched sources use the ordinary passage/citation assembly. */
  claim: string;
  fabricated: string[];
  /** Existing discovered artifacts can be used for canonical/mirror and temporal evidence. */
  documents?: CandidateDocument[];
  /** Number of validated upstream hops to expand. Claim-only candidate roots share the seed's depth zero. */
  maxDepth?: number;
  /**
   * Per-call provider budget. Defaults to 10 so a runner can schedule invocations at the
   * bibliography service's 10 scans/minute limit without sleeping inside the request handler.
   */
  maxProviderRequests?: number;
  /** Optional prior state returned when a provider job or the local request budget paused work. */
  checkpoint?: TraversalCheckpoint | null;
}

export interface TraverseProvenanceDeps {
  proposer: UpstreamSourceProposer;
  fetcher: PageFetcher;
  resolver?: SourceResolver;
}

export interface QueuedSource {
  key: string;
  depth: number;
  job_id: string | null;
}

export interface AcceptedTraversalRecord {
  parentKey: string;
  childKey: string;
  score: ScoredEdge;
  parentTiming: Timing;
  childTiming: Timing;
  recursed: boolean;
}

interface CandidateMatchRecord {
  sourceKey: string;
  targetKey: string;
}

export interface TraversalCheckpoint {
  documents: CandidateDocument[];
  queue: QueuedSource[];
  source_states: Array<[string, "queued" | "expanded"]>;
  accepted: AcceptedTraversalRecord[];
  candidate_matches: CandidateMatchRecord[];
  rejected_edges: RejectedProposedEdge[];
  terminations: SourceTermination[];
  diagnostics: TraversalDiagnostic[];
  reference_to_key: Array<[string, string]>;
  failed_references: Array<[string, string]>;
  stats: Omit<RecursiveProvenanceTraversal["stats"], "max_depth" | "sources_expanded">;
}

function keyOf(document: CandidateDocument): string {
  return document.content_fingerprint;
}

function sourceSort(a: QueuedSource, b: QueuedSource, documents: Map<string, CandidateDocument>): number {
  const aUrl = documents.get(a.key)!.url;
  const bUrl = documents.get(b.key)!.url;
  return a.depth - b.depth || aUrl.localeCompare(bUrl) || a.key.localeCompare(b.key);
}

function proposalSort(a: ProposedUpstreamSource, b: ProposedUpstreamSource): number {
  return proposalLabel(a).localeCompare(proposalLabel(b)) || (a.published ?? "").localeCompare(b.published ?? "");
}

function proposalLabel(proposal: ProposedUpstreamSource): string {
  return [proposal.url, proposal.author, proposal.title, proposal.citation].filter((value): value is string => Boolean(value?.trim())).join(" | ");
}

function proposalUrl(proposal: ProposedUpstreamSource): string | null {
  if (!proposal.url) return null;
  try {
    const url = new URL(proposal.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return canonicalUrl(url.toString());
  } catch {
    return null;
  }
}

function hasBibliographicReference(proposal: ProposedUpstreamSource): boolean {
  return Boolean(proposal.author?.trim() || proposal.title?.trim() || proposal.citation?.trim());
}

function sourceFromDocuments(key: string, documents: Map<string, CandidateDocument>): CandidateDocument {
  const document = documents.get(key);
  if (!document) throw new Error(`unknown traversal source ${key}`);
  return document;
}

function isSubmittedText(document: CandidateDocument): boolean {
  return document.discovered_via.includes("submitted-text");
}

function treeEdge(
  score: ScoredEdge,
  parent: CandidateDocument,
  child: CandidateDocument,
  parentTiming: Timing,
  childTiming: Timing,
  recursed: boolean,
): AcceptedProposedEdge {
  return {
    parent_id: parent.id,
    child_id: child.id,
    type: (score.signals.explicit_link || score.signals.coverage >= MIN_COVERAGE) && score.confidence >= 0.5 ? "propagation" : "similarity",
    confidence: score.confidence,
    basis: score.reasons.join("; "),
    shared_mutations: [...score.signals.shared_fabricated, ...score.signals.shared_variants],
    claim_mutations: analyzeClaimMutations(parent, child),
    explicit_link: score.signals.explicit_link,
    rare_shared_phrases: score.signals.unique_phrases,
    similarity: score.signals.similarity,
    temporal: temporal(parentTiming, childTiming, score.signals.ordering),
    alternatives: [],
    recursed,
  };
}

function rejectionReason(score: ScoredEdge): string {
  if (score.impossible) return score.impossible;
  if (!score.strong) return `insufficient evidence: ${score.reasons.at(-1) ?? "the deterministic scorer did not establish propagation"}`;
  return `confidence ${score.confidence} below ${ACCEPT_THRESHOLD}`;
}

/**
 * Recursively follow provider-proposed upstream sources. The traversal is breadth-first and URLs
 * are sorted before use, so provider ordering cannot change the result. A source can feed several
 * children, but is expanded at most once; accepted edges form a cycle-free DAG.
 */
export async function traverseProvenance(
  input: TraverseProvenanceInput,
  deps: TraverseProvenanceDeps,
): Promise<RecursiveProvenanceTraversal> {
  const maxDepth = input.maxDepth ?? 5;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  const maxProviderRequests = input.maxProviderRequests ?? 10;
  if (!Number.isInteger(maxProviderRequests) || maxProviderRequests < 1) {
    throw new Error("maxProviderRequests must be a positive integer");
  }
  // A run may use its whole ten-scan minute in one burst. Return a conservative full-window
  // delay instead of sleeping here or encouraging an immediate eleventh request.
  const rateLimitRetryAfterMs = 60_000;

  const checkpoint = input.checkpoint;
  const rawDocuments = checkpoint ? [...checkpoint.documents] : [...(input.documents ?? []), input.seed];
  let canonicalized = canonicalizeDocuments(rawDocuments);
  let documents = canonicalized.documents;
  const seedKey = keyOf(input.seed);
  if (checkpoint && !documents.some((document) => keyOf(document) === seedKey)) {
    throw new Error("traversal checkpoint does not contain the supplied seed artifact");
  }
  const sourceState = new Map<string, "queued" | "expanded">(
    checkpoint?.source_states ?? [[seedKey, "queued"]],
  );
  const queue: QueuedSource[] = checkpoint?.queue.map((source) => ({ ...source })) ?? [{ key: seedKey, depth: 0, job_id: null }];
  const accepted: AcceptedTraversalRecord[] = checkpoint?.accepted.map((edge) => ({ ...edge })) ?? [];
  const candidateMatches: CandidateMatchRecord[] = checkpoint?.candidate_matches.map((edge) => ({ ...edge })) ?? [];
  const rejected: RejectedProposedEdge[] = checkpoint?.rejected_edges.map((edge) => ({ ...edge })) ?? [];
  const terminations: SourceTermination[] = checkpoint?.terminations.map((entry) => ({ ...entry })) ?? [];
  const diagnostics: TraversalDiagnostic[] = checkpoint?.diagnostics.map((entry) => ({ ...entry })) ?? [];
  let proposalsReceived = checkpoint?.stats.proposals_received ?? 0;
  let fetched = checkpoint?.stats.fetched ?? 0;
  let fetchFailures = checkpoint?.stats.fetch_failures ?? 0;
  let analysisRequests = checkpoint?.stats.analysis_requests ?? 0;
  let requestsThisCall = 0;
  let paused: PendingAnalysisJob | null = null;

  const documentsByKey = () => new Map(documents.map((document) => [keyOf(document), document]));
  const urlToKey = () => {
    const sources = new Map<string, string>();
    for (const document of documents) {
      sources.set(canonicalUrl(document.url), keyOf(document));
      for (const mirror of document.mirror_urls) sources.set(canonicalUrl(mirror), keyOf(document));
    }
    return sources;
  };
  // A provider may repeat a URL through another branch (or a redirect may hide the originally
  // proposed URL). Keep successful and failed acquisition attempts keyed by the proposal itself
  // so the same external source is never fetched or resolved twice.
  const referenceToKey = new Map<string, string>(checkpoint?.reference_to_key ?? urlToKey());
  const failedReferences = new Map<string, string>(checkpoint?.failed_references ?? []);

  /** Adding P -> C would close a path C -> ... -> P. */
  const createsCycle = (parentKey: string, childKey: string) => {
    const children = new Map<string, string[]>();
    for (const edge of accepted) {
      const list = children.get(edge.parentKey) ?? [];
      list.push(edge.childKey);
      children.set(edge.parentKey, list);
    }
    const pending = [childKey];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === parentKey) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(children.get(current) ?? []));
    }
    return false;
  };

  while (queue.length) {
    const byKey = documentsByKey();
    queue.sort((a, b) => sourceSort(a, b, byKey));
    const current = queue.shift()!;
    if (sourceState.get(current.key) === "expanded") continue;
    const child = sourceFromDocuments(current.key, byKey);

    if (current.depth >= maxDepth) {
      sourceState.set(current.key, "expanded");
      terminations.push({ source_id: child.id, url: child.url, depth: current.depth, reason: "max-depth", detail: null });
      continue;
    }

    if (requestsThisCall >= maxProviderRequests) {
      queue.unshift(current);
      paused = {
        source_id: child.id,
        url: child.url,
        depth: current.depth,
        job_id: current.job_id,
        reason: "rate-limit",
        retry_after_ms: rateLimitRetryAfterMs,
      };
      break;
    }

    sourceState.set(current.key, "expanded");

    let analysis: UpstreamAnalysis;
    try {
      requestsThisCall += 1;
      analysisRequests += 1;
      analysis = await deps.proposer.analyze(child, current.job_id ? { job_id: current.job_id } : undefined);
    } catch (error) {
      terminations.push({
        source_id: child.id,
        url: child.url,
        depth: current.depth,
        reason: "provider-failure",
        detail: error instanceof Error ? error.message : "provider failed",
      });
      diagnostics.push({
        stage: "gptzero",
        source: child.url,
        category: "provider-failure",
        message: "upstream proposal analysis failed",
        recoverable: true,
      });
      continue;
    }
    if (isPendingAnalysis(analysis)) {
      sourceState.set(current.key, "queued");
      queue.push({ key: current.key, depth: current.depth, job_id: analysis.job_id });
      paused = {
        source_id: child.id,
        url: child.url,
        depth: current.depth,
        job_id: analysis.job_id,
        reason: "provider-pending",
        retry_after_ms: analysis.retry_after_ms ?? null,
      };
      break;
    }
    const proposals = isProposalList(analysis) ? analysis : analysis.proposals;
    if (!isProposalList(analysis) && analysis.fallback) {
      diagnostics.push({
        stage: "gptzero",
        source: child.url,
        category: analysis.fallback.provenance,
        message: `using cached bibliography fallback captured ${analysis.fallback.capturedAt}`,
        recoverable: true,
      });
    }
    proposalsReceived += proposals.length;
    if (proposals.length === 0) {
      terminations.push({ source_id: child.id, url: child.url, depth: current.depth, reason: "no-proposals", detail: null });
      continue;
    }

    let acceptedForSource = 0;
    let candidateRootsForSource = 0;
    for (const proposal of [...proposals].sort(proposalSort)) {
      const requestedUrl = proposalUrl(proposal);
      const reference = proposalLabel(proposal) || "unidentified upstream source";
      if (proposal.url && !requestedUrl && !hasBibliographicReference(proposal)) {
        rejected.push({
          parent_url: reference,
          parent_id: null,
          child_id: child.id,
          confidence: null,
          reason: "provider returned an invalid URL",
          termination: "invalid-proposal",
        });
        continue;
      }

      let byUrl = urlToKey();
      const referenceKey = requestedUrl ?? reference;
      let parentKey = referenceToKey.get(referenceKey) ?? (requestedUrl ? byUrl.get(requestedUrl) : undefined);
      if (!parentKey) {
        const priorFailure = failedReferences.get(referenceKey);
        if (priorFailure) {
          rejected.push({
            parent_url: reference,
            parent_id: null,
            child_id: child.id,
            confidence: null,
            reason: `previous acquisition failed: ${priorFailure}`,
            termination: "fetch-failure",
          });
          continue;
        }
        const ingested = await ingestSourceReference(proposal, { fetcher: deps.fetcher, resolver: deps.resolver }, {
          fabricated: input.fabricated,
          claimTerms: claimTerms(input.claim, input.fabricated),
          discoveredVia: `upstream proposal from ${child.id}`,
          published: proposal.published,
        });
        if (!ingested.ok) {
          fetchFailures += 1;
          const failure = `${ingested.reason}${ingested.detail ? `: ${ingested.detail}` : ""}`;
          failedReferences.set(referenceKey, failure);
          rejected.push({
            parent_url: reference,
            parent_id: null,
            child_id: child.id,
            confidence: null,
            reason: failure,
            termination: "fetch-failure",
            stage: ingested.stage,
            category: ingested.category,
            recoverable: ingested.recoverable,
          });
          diagnostics.push({
            stage: ingested.stage,
            source: requestedUrl,
            category: ingested.category,
            message: ingested.detail ?? ingested.reason,
            recoverable: ingested.recoverable,
          });
          continue;
        }
        fetched += 1;
        rawDocuments.push(ingested.document);
        canonicalized = canonicalizeDocuments(rawDocuments);
        documents = canonicalized.documents;
        byUrl = urlToKey();
        parentKey = byUrl.get(canonicalUrl(ingested.document.url));
        if (!parentKey) throw new Error(`ingested source ${ingested.document.url} was not canonicalized`);
        referenceToKey.set(referenceKey, parentKey);
      }

      const currentDocuments = documentsByKey();
      const parent = sourceFromDocuments(parentKey, currentDocuments);
      const currentChild = sourceFromDocuments(current.key, currentDocuments);
      if (parentKey === current.key) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: null,
          reason: "proposed source is the same canonical artifact as its child (duplicate or mirror)",
          termination: "duplicate-source",
        });
        continue;
      }

      if (isSubmittedText(currentChild)) {
        if (!candidateMatches.some((edge) => edge.sourceKey === parentKey && edge.targetKey === current.key)) {
          candidateMatches.push({ sourceKey: parentKey, targetKey: current.key });
          candidateRootsForSource += 1;
        }
        // The proposal and successful acquisition establish an investigation root, not a
        // provenance edge. It therefore consumes no accepted-hop depth and is expanded under the
        // ordinary validator path just like an explicit real seed would be.
        if (!sourceState.has(parentKey)) {
          sourceState.set(parentKey, "queued");
          queue.push({ key: parentKey, depth: current.depth, job_id: null });
        }
        continue;
      }

      if (createsCycle(parentKey, current.key)) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: null,
          reason: "accepting this proposed edge would create a provenance cycle",
          termination: "cycle",
        });
        continue;
      }
      if (accepted.some((edge) => edge.parentKey === parentKey && edge.childKey === current.key)) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: null,
          reason: "this proposed edge was already accepted",
          termination: "already-accepted",
        });
        continue;
      }

      const timings = computeTimings(documents);
      const eligibleParents = documents.filter(
        (candidate) => candidate.id !== currentChild.id && ordering(candidate, currentChild, timings) !== "impossible",
      );
      const score = scoreEdge(parent, currentChild, { timings, eligibleParents });
      if (score.impossible || !score.strong || score.confidence < ACCEPT_THRESHOLD) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: score.confidence,
          reason: rejectionReason(score),
          termination: "validation-rejected",
        });
        continue;
      }

      const existingState = sourceState.get(parentKey);
      const recursed = !existingState;
      accepted.push({
        parentKey,
        childKey: current.key,
        score,
        parentTiming: timings.get(parent.id)!,
        childTiming: timings.get(currentChild.id)!,
        recursed,
      });
      acceptedForSource += 1;
      if (recursed) {
        sourceState.set(parentKey, "queued");
        queue.push({ key: parentKey, depth: current.depth + 1, job_id: null });
      }
    }
    const terminalChild = sourceFromDocuments(current.key, documentsByKey());
    terminations.push({
      source_id: terminalChild.id,
      url: terminalChild.url,
      depth: current.depth,
      reason: acceptedForSource > 0 ? "accepted-parents" : candidateRootsForSource > 0 ? "candidate-roots" : "all-proposals-rejected",
      detail: null,
    });
  }

  const finalByKey = documentsByKey();
  const stats = {
    max_depth: maxDepth,
    sources_expanded: terminations.length,
    proposals_received: proposalsReceived,
    fetched,
    fetch_failures: fetchFailures,
    analysis_requests: analysisRequests,
  };
  const checkpointResult: TraversalCheckpoint | null = paused
    ? {
        documents,
        queue,
        source_states: [...sourceState.entries()],
        accepted,
        candidate_matches: candidateMatches,
        rejected_edges: rejected,
        terminations,
        diagnostics,
        reference_to_key: [...referenceToKey.entries()],
        failed_references: [...failedReferences.entries()],
        stats: {
          proposals_received: proposalsReceived,
          fetched,
          fetch_failures: fetchFailures,
          analysis_requests: analysisRequests,
        },
      }
    : null;
  const interrupted = fetchFailures > 0 || terminations.some((entry) => entry.reason === "provider-failure");
  const status: RecursiveProvenanceTraversal["status"] = paused
    ? "paused"
      : interrupted
        ? accepted.length > 0 || candidateMatches.length > 0
        ? "partial"
        : "failed"
      : "complete";
  return {
    documents,
    accepted_edges: accepted.map((edge) =>
      treeEdge(
        edge.score,
        sourceFromDocuments(edge.parentKey, finalByKey),
        sourceFromDocuments(edge.childKey, finalByKey),
        edge.parentTiming,
        edge.childTiming,
        edge.recursed,
      ),
    ),
    candidate_matches: candidateMatches.map((edge) => ({
      source_id: sourceFromDocuments(edge.sourceKey, finalByKey).id,
      target_id: sourceFromDocuments(edge.targetKey, finalByKey).id,
    })),
    rejected_edges: rejected,
    terminations,
    pending_jobs: paused ? [paused] : [],
    diagnostics,
    status,
    checkpoint: checkpointResult,
    stats,
  };
}
