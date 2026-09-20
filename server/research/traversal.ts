import type { TreeEdge } from "../../shared/tree";
import { canonicalizeDocuments } from "./canonicalize";
import { claimTerms } from "./discovery";
import {
  computeTimings,
  EXPLORATORY_THRESHOLD,
  MIN_COVERAGE,
  ordering,
  RELATED_THRESHOLD,
  scoreEdge,
  temporalEvidence as temporal,
  type ScoredEdge,
  type Timing,
} from "./edges";
import { assembleCitationMetadataDocument, canonicalUrl, type CandidateDocument } from "./extract";
import type { AcademicPaperMetadata } from "./academic";
import { ingestSourceReference, type IngestionFailure, type IngestionResult } from "./ingestion";
import { analyzeClaimMutations } from "./mutations";
import type { PageFetcher, SourceReference, SourceResolver } from "./providers";
import { ACCEPT_THRESHOLD } from "./tree";

/** A provider may suggest candidates, but it never decides that an edge exists. */
export interface UpstreamProposal extends SourceReference {
  /** Optional search/provider publication date; normal ingestion still ranks stronger page evidence first. */
  published?: string | null;
  /**
   * Which discovery channels proposed this source (e.g. "gptzero", "web-search"). Recorded on the
   * fetched document's `discovered_via` for display and audit only; scoring never reads it, and it
   * is not evidence that a provenance edge exists.
   */
  discovered_by?: readonly string[];
  /**
   * Semantic Scholar citation proposals are structural facts, handled in a dedicated traversal
   * branch. They never enter provenance scoring or validation.
   */
  relationship_kind?: "citation";
  citation_direction?: CitationDirection;
  citation_metadata?: CitationProviderMetadata;
}

export type CitationDirection = "references" | "cited_by";

/** Audit/display fields returned by Semantic Scholar for one structural citation relation. */
export interface CitationProviderMetadata {
  provider: "semantic-scholar";
  /** The paper expanded to discover this relation. */
  resolved_paper_id: string;
  resolved_by: "doi" | "semantic_scholar_paper_id" | "arxiv" | "scholarly_url" | "title_author";
  /** The other endpoint in the citation relation. */
  paper: AcademicPaperMetadata;
  contexts: string[];
  intents: string[];
  is_influential: boolean | null;
}

export function isCitationProposal(proposal: UpstreamProposal): proposal is UpstreamProposal & {
  relationship_kind: "citation";
  citation_direction: CitationDirection;
  citation_metadata: CitationProviderMetadata;
} {
  return proposal.relationship_kind === "citation" &&
    (proposal.citation_direction === "references" || proposal.citation_direction === "cited_by") &&
    proposal.citation_metadata?.provider === "semantic-scholar";
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

/**
 * "strict" (default): only edges that pass the existing validated threshold are accepted, exactly
 * as before this mode existed. "exploratory": edges that fail that threshold but carry meaningful,
 * non-similarity evidence and clear a lower floor are accepted as "probable" and still recursed
 * into, bounded by MAX_PROBABLE_CHILDREN_PER_NODE. "deep": exploratory's probable tier, plus a wider
 * investigative "related" tier (thinner evidence, still never pure similarity) bounded by
 * MAX_RELATED_CHILDREN_PER_NODE/MAX_CHILDREN_PER_NODE, meant to build a much deeper crosslink graph
 * for demo/investigation purposes. Never "exploratory" or "deep" unless the caller opts in.
 */
export type ProvenanceMode = "strict" | "exploratory" | "deep";

export type SourceTerminationReason =
  | "no-proposals"
  | "max-depth"
  | "provider-failure"
  | "all-proposals-rejected"
  | "accepted-parents"
  /** This source supplied one or more structural citation edges. */
  | "citation-edges"
  /** A submitted-text query discovered real documents that now act as traversal roots. */
  | "candidate-roots"
  /** The run's MAX_EXPANDED_NODES safety budget was reached; this source was never expanded. */
  | "node-budget-exhausted";

export type ProposedEdgeTerminationReason =
  | "invalid-proposal"
  | "fetch-failure"
  | "duplicate-source"
  | "cycle"
  | "already-visited"
  | "already-accepted"
  | "validation-rejected"
  /** Exploratory mode only: this node already has MAX_PROBABLE_CHILDREN_PER_NODE probable parents. */
  | "exploratory-branch-cap"
  /** Deep mode only: this node already has MAX_RELATED_CHILDREN_PER_NODE/MAX_CHILDREN_PER_NODE related parents. */
  | "related-branch-cap"
  /** This source already reached MAX_CHILDREN_PER_NODE accepted investigation links. */
  | "children-per-node-cap"
  /** The run's MAX_EDGES safety budget was reached; this proposal was never scored. */
  | "edge-budget-exhausted";

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
  /**
   * "validated": passes the strict deterministic threshold in every mode.
   * "probable": exploratory/deep acceptance below that threshold, on meaningful evidence.
   * "related": deep-mode-only acceptance on thinner but still non-similarity evidence; an
   * investigative crosslink, not a provenance claim.
   * Never conflate any of these when serializing: only "validated" is validated provenance.
   */
  provenance_status: "validated" | "probable" | "related";
  /** "unknown" when the underlying evidence cannot support a claimed upstream->downstream order. */
  directionality: "upstream_downstream" | "unknown";
  /** Why this edge exists, derived only from scoring signals — never from provider/search metadata. */
  evidence_tags: EvidenceTag[];
}

/** A verified citation-graph fact. It is never a provenance or mutation-validation result. */
export interface CitationTraversalEdge {
  source_id: string;
  target_id: string;
  /** `references`: expanded paper -> cited paper. `cited_by`: citing paper -> expanded paper. */
  direction: CitationDirection;
  relationship_kind: "citation";
  recursed: boolean;
  provider_metadata: CitationProviderMetadata;
}

export type EvidenceTag =
  | "explicit_reference"
  | "shared_fabricated_citation"
  | "shared_named_entities"
  | "rare_phrase_overlap"
  | "semantic_overlap";

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
  /** Citation-network facts, isolated from provenance validation and scoring. */
  citation_edges: CitationTraversalEdge[];
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
    citation_edges: number;
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
  /** Defaults to "strict". Set to "exploratory"/"deep" only for the demo profile; never in production. */
  provenanceMode?: ProvenanceMode;
  /** Safety budget: stop expanding new sources once this many have been terminated. Default 25. */
  maxExpandedNodes?: number;
  /** Safety budget: stop accepting new edges once this many have been accepted. Default 60. */
  maxEdges?: number;
  /** Safety budget: accepted investigation links from one expanded document. Default 6. */
  maxChildrenPerNode?: number;
  /** Deep-mode safety budget: `related` links from one expanded document. Default 4. */
  maxRelatedChildrenPerNode?: number;
  /** Exploratory/deep safety budget: `probable` links from one expanded document. Default 3. */
  maxProbableChildrenPerNode?: number;
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
  status: "validated" | "probable" | "related";
}

interface CitationTraversalRecord {
  sourceKey: string;
  targetKey: string;
  direction: CitationDirection;
  recursed: boolean;
  provider_metadata: CitationProviderMetadata;
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
  citation_edges: CitationTraversalRecord[];
  candidate_matches: CandidateMatchRecord[];
  rejected_edges: RejectedProposedEdge[];
  terminations: SourceTermination[];
  diagnostics: TraversalDiagnostic[];
  reference_to_key: Array<[string, string]>;
  failed_references: Array<[string, string]>;
  stats: Omit<RecursiveProvenanceTraversal["stats"], "max_depth" | "sources_expanded" | "citation_edges">;
}

/** How many of one node's proposed sources are fetched at once. */
const ACQUISITION_CONCURRENCY = 4;
/** How many same-depth sources have a provider analysis in flight at once (GPTZero allows ~10 scans/min). */
const ANALYSIS_CONCURRENCY = 3;
/**
 * Exploratory mode only: how many probable (non-strict) parents a single child may recurse into.
 * Kept small so a richer investigative tree doesn't turn into unbounded branching from every weak
 * candidate; validated parents are never subject to this cap.
 */
export const DEFAULT_MAX_PROBABLE_CHILDREN_PER_NODE = 3;
/** Deep mode only: how many related (thinnest-tier) links one expanded document may accept. */
export const DEFAULT_MAX_RELATED_CHILDREN_PER_NODE = 4;
/** All modes: total accepted investigation links one expanded document may accept. */
export const DEFAULT_MAX_CHILDREN_PER_NODE = 6;
/** Safety default: stop expanding new sources once this many have been terminated. */
export const DEFAULT_MAX_EXPANDED_NODES = 25;
/** Safety default: stop accepting new edges once this many have been accepted. */
export const DEFAULT_MAX_EDGES = 60;

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

function evidenceTags(score: ScoredEdge): EvidenceTag[] {
  const tags: EvidenceTag[] = [];
  if (score.signals.explicit_link) tags.push("explicit_reference");
  if (score.signals.shared_fabricated.length) tags.push("shared_fabricated_citation");
  if (score.signals.shared_variants.length) tags.push("shared_named_entities");
  if (score.signals.unique_phrases > 0) tags.push("rare_phrase_overlap");
  // Similarity is never evidence on its own; only surfaced alongside a real signal.
  if (tags.length && score.signals.similarity > 0) tags.push("semantic_overlap");
  return tags;
}

function directionality(status: AcceptedProposedEdge["provenance_status"], score: ScoredEdge): "upstream_downstream" | "unknown" {
  // A related edge is an investigative discovery, never a claim that one document propagated into
  // the other. Its endpoint order is only the order in which traversal encountered the documents.
  if (status === "related") return "unknown";
  const order = score.signals.ordering;
  if (order === "unknown") return "unknown";
  if (order === "same-time" && !score.signals.explicit_link) return "unknown";
  return "upstream_downstream";
}

function treeEdge(
  score: ScoredEdge,
  parent: CandidateDocument,
  child: CandidateDocument,
  parentTiming: Timing,
  childTiming: Timing,
  recursed: boolean,
  status: "validated" | "probable" | "related",
): AcceptedProposedEdge {
  const confidence = status === "validated" ? score.confidence : score.exploratory_confidence;
  return {
    parent_id: parent.id,
    child_id: child.id,
    type: (score.signals.explicit_link || score.signals.coverage >= MIN_COVERAGE) && confidence >= 0.5 ? "propagation" : "similarity",
    confidence,
    basis: score.reasons.join("; "),
    shared_mutations: [...score.signals.shared_fabricated, ...score.signals.shared_variants],
    // Related edges are investigative crosslinks, not proven propagation: mutation/propagation
    // analysis stays scoped to validated + probable.
    claim_mutations: status === "related" ? [] : analyzeClaimMutations(parent, child),
    explicit_link: score.signals.explicit_link,
    rare_shared_phrases: score.signals.unique_phrases,
    similarity: score.signals.similarity,
    temporal: temporal(parentTiming, childTiming, status === "related" ? "unknown" : score.signals.ordering),
    alternatives: [],
    recursed,
    provenance_status: status,
    directionality: directionality(status, score),
    evidence_tags: evidenceTags(score),
  };
}

function rejectionReason(score: ScoredEdge, mode: ProvenanceMode): string {
  if (score.impossible) return score.impossible;
  if (mode === "deep") {
    if (!score.has_meaningful_evidence) return "no meaningful provenance signal (link, shared citation, or rare shared phrasing); similarity alone is not evidence";
    return `related confidence ${score.exploratory_confidence} below ${RELATED_THRESHOLD}`;
  }
  if (mode === "exploratory") {
    if (!score.has_meaningful_evidence) return "no meaningful provenance signal (link, shared citation, or rare shared phrasing); similarity alone is not evidence";
    return `exploratory confidence ${score.exploratory_confidence} below ${EXPLORATORY_THRESHOLD}`;
  }
  if (!score.strong) return `insufficient evidence: ${score.reasons.at(-1) ?? "the deterministic scorer did not establish propagation"}`;
  return `confidence ${score.confidence} below ${ACCEPT_THRESHOLD}`;
}

/**
 * Recursively follow provider-proposed upstream sources. The traversal is breadth-first and URLs
 * are sorted before use, so provider ordering cannot change the result. A source can feed several
 * children, but is expanded at most once. The validated/probable provenance graph stays acyclic;
 * a related edge may close an investigation-graph cycle but never schedules another expansion.
 */
export async function traverseProvenance(
  input: TraverseProvenanceInput,
  deps: TraverseProvenanceDeps,
): Promise<RecursiveProvenanceTraversal> {
  const mode: ProvenanceMode = input.provenanceMode ?? "strict";
  const maxDepth = input.maxDepth ?? 5;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  const maxProviderRequests = input.maxProviderRequests ?? 10;
  if (!Number.isInteger(maxProviderRequests) || maxProviderRequests < 1) {
    throw new Error("maxProviderRequests must be a positive integer");
  }
  const maxExpandedNodes = input.maxExpandedNodes ?? DEFAULT_MAX_EXPANDED_NODES;
  if (!Number.isInteger(maxExpandedNodes) || maxExpandedNodes < 1) {
    throw new Error("maxExpandedNodes must be a positive integer");
  }
  const maxEdges = input.maxEdges ?? DEFAULT_MAX_EDGES;
  if (!Number.isInteger(maxEdges) || maxEdges < 1) {
    throw new Error("maxEdges must be a positive integer");
  }
  const maxChildrenPerNode = input.maxChildrenPerNode ?? DEFAULT_MAX_CHILDREN_PER_NODE;
  if (!Number.isInteger(maxChildrenPerNode) || maxChildrenPerNode < 1) {
    throw new Error("maxChildrenPerNode must be a positive integer");
  }
  const maxRelatedChildrenPerNode = input.maxRelatedChildrenPerNode ?? DEFAULT_MAX_RELATED_CHILDREN_PER_NODE;
  if (!Number.isInteger(maxRelatedChildrenPerNode) || maxRelatedChildrenPerNode < 0) {
    throw new Error("maxRelatedChildrenPerNode must be a non-negative integer");
  }
  const maxProbableChildrenPerNode = input.maxProbableChildrenPerNode ?? DEFAULT_MAX_PROBABLE_CHILDREN_PER_NODE;
  if (!Number.isInteger(maxProbableChildrenPerNode) || maxProbableChildrenPerNode < 0) {
    throw new Error("maxProbableChildrenPerNode must be a non-negative integer");
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
  const citationEdges: CitationTraversalRecord[] = checkpoint?.citation_edges.map((edge) => ({ ...edge, provider_metadata: { ...edge.provider_metadata } })) ?? [];
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
  let expandedCount = [...sourceState.values()].filter((state) => state === "expanded").length;

  const documentsByKey = () => new Map(documents.map((document) => [keyOf(document), document]));
  const urlToKey = () => {
    const sources = new Map<string, string>();
    for (const document of documents) {
      sources.set(canonicalUrl(document.url), keyOf(document));
      for (const mirror of document.mirror_urls) sources.set(canonicalUrl(mirror), keyOf(document));
    }
    return sources;
  };
  const paperIdToKey = () => {
    const papers = new Map<string, string>();
    for (const document of documents) {
      const paperId = document.academic_metadata?.semantic_scholar_paper_id?.trim();
      if (paperId) papers.set(paperId, keyOf(document));
    }
    return papers;
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

  /** Citation edges have their own orientation and cycle guard; provenance orientation is opposite. */
  const createsCitationCycle = (sourceKey: string, targetKey: string) => {
    const children = new Map<string, string[]>();
    for (const edge of citationEdges) {
      const list = children.get(edge.sourceKey) ?? [];
      list.push(edge.targetKey);
      children.set(edge.sourceKey, list);
    }
    const pending = [targetKey];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === sourceKey) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(children.get(current) ?? []));
    }
    return false;
  };

  // Provider analyses already started for a queued source, consumed when the loop reaches it.
  const analyses = new Map<string, Promise<UpstreamAnalysis>>();
  const startAnalysis = (source: QueuedSource, document: CandidateDocument): Promise<UpstreamAnalysis> => {
    let started: Promise<UpstreamAnalysis>;
    try {
      started = Promise.resolve(deps.proposer.analyze(document, source.job_id ? { job_id: source.job_id } : undefined));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.catch(() => undefined); // surfaced when consumed; never an unhandled rejection if the run pauses first
    analyses.set(source.key, started);
    return started;
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

    if (expandedCount >= maxExpandedNodes) {
      sourceState.set(current.key, "expanded");
      terminations.push({ source_id: child.id, url: child.url, depth: current.depth, reason: "node-budget-exhausted", detail: null });
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
    expandedCount += 1;

    let analysis: UpstreamAnalysis;
    try {
      requestsThisCall += 1;
      analysisRequests += 1;
      const own = analyses.get(current.key) ?? startAnalysis(current, child);
      // A provider scan takes 10-40s and is independent per source, so this source's same-depth peers
      // (e.g. every candidate root of a claim) are started now instead of waiting their turn. Each is
      // still consumed in its normal turn below, so what is accepted, and in what order, is unchanged.
      // Started scans count against the same per-call budget, so none can exceed it. The submitted text
      // itself always runs alone: it is what creates its peers.
      if (!isSubmittedText(child)) {
        for (const peer of queue) {
          if (analyses.size >= ANALYSIS_CONCURRENCY || requestsThisCall + analyses.size > maxProviderRequests) break;
          if (peer.depth !== current.depth) break;
          const peerDocument = byKey.get(peer.key);
          if (!peerDocument || analyses.has(peer.key) || sourceState.get(peer.key) === "expanded" || isSubmittedText(peerDocument)) continue;
          startAnalysis(peer, peerDocument);
        }
      }
      analysis = await own;
      analyses.delete(current.key);
    } catch (error) {
      analyses.delete(current.key);
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

    const acquire = (proposal: ProposedUpstreamSource) =>
      ingestSourceReference(proposal, { fetcher: deps.fetcher, resolver: deps.resolver }, {
        fabricated: input.fabricated,
        claimTerms: claimTerms(input.claim, input.fabricated),
        discoveredVia: `upstream proposal from ${child.id}`,
        published: proposal.published,
      });
    const sortedProposals = [...proposals].sort(proposalSort);
    // Acquisition is network-bound and independent per source, so this node's fetches run together
    // (bounded). Results are still consumed below in the sorted order, one at a time, so which
    // documents are accepted, and in what order, is exactly what a serial run would produce.
    const acquisitions = new Map<string, Promise<IngestionResult>>();
    let activeAcquisitions = 0;
    const waitingAcquisitions: Array<() => void> = [];
    const knownUrls = urlToKey();
    for (const proposal of sortedProposals) {
      if (isCitationProposal(proposal)) continue;
      const requestedUrl = proposalUrl(proposal);
      if (proposal.url && !requestedUrl && !hasBibliographicReference(proposal)) continue;
      const referenceKey = requestedUrl ?? (proposalLabel(proposal) || "unidentified upstream source");
      if (acquisitions.has(referenceKey) || referenceToKey.has(referenceKey) || failedReferences.has(referenceKey)) continue;
      if (requestedUrl && knownUrls.has(requestedUrl)) continue;
      const started = (async () => {
        if (activeAcquisitions >= ACQUISITION_CONCURRENCY) await new Promise<void>((resolve) => waitingAcquisitions.push(resolve));
        activeAcquisitions += 1;
        try {
          return await acquire(proposal);
        } finally {
          activeAcquisitions -= 1;
          waitingAcquisitions.shift()?.();
        }
      })();
      started.catch(() => undefined); // surfaced when consumed; never an unhandled rejection if the node exits early
      acquisitions.set(referenceKey, started);
    }

    let acceptedForSource = 0;
    let candidateRootsForSource = 0;
    let citationEdgesForSource = 0;
    let probableForSource = 0;
    let relatedForSource = 0;
    for (const proposal of sortedProposals) {
      if (isCitationProposal(proposal)) {
        const paper = proposal.citation_metadata.paper;
        const paperId = paper.semantic_scholar_paper_id?.trim();
        const canonicalPaperUrl = paper.canonical_url?.trim();
        if (!paperId || !canonicalPaperUrl) {
          rejected.push({
            parent_url: proposalLabel(proposal) || "unidentified citation paper",
            parent_id: null,
            child_id: child.id,
            confidence: null,
            reason: "Semantic Scholar returned a citation without a paper ID or canonical URL",
            termination: "invalid-proposal",
          });
          continue;
        }
        let otherKey = paperIdToKey().get(paperId) ?? urlToKey().get(canonicalUrl(canonicalPaperUrl));
        if (!otherKey) {
          // Citation graph records can create an explicitly metadata-only node. No abstract or
          // provider text is made to look like acquired source content, and no fetch is required.
          rawDocuments.push(assembleCitationMetadataDocument(paper, "semantic-scholar-citation-metadata"));
          canonicalized = canonicalizeDocuments(rawDocuments);
          documents = canonicalized.documents;
          otherKey = paperIdToKey().get(paperId) ?? urlToKey().get(canonicalUrl(canonicalPaperUrl));
          if (!otherKey) throw new Error(`citation paper ${paperId} was not canonicalized`);
          referenceToKey.set(canonicalUrl(canonicalPaperUrl), otherKey);
        }
        const currentDocuments = documentsByKey();
        const currentPaper = sourceFromDocuments(current.key, currentDocuments);
        const otherPaper = sourceFromDocuments(otherKey, currentDocuments);
        const sourceKey = proposal.citation_direction === "references" ? current.key : otherKey;
        const targetKey = proposal.citation_direction === "references" ? otherKey : current.key;
        if (sourceKey === targetKey) {
          rejected.push({
            parent_url: otherPaper.url,
            parent_id: otherPaper.id,
            child_id: currentPaper.id,
            confidence: null,
            reason: "Semantic Scholar returned a self-citation for the same canonical paper node",
            termination: "duplicate-source",
          });
          continue;
        }
        const existingCitation = citationEdges.some((edge) => edge.sourceKey === sourceKey && edge.targetKey === targetKey && edge.direction === proposal.citation_direction);
        if (!existingCitation && accepted.length + candidateMatches.length + citationEdges.length >= maxEdges) {
          rejected.push({
            parent_url: otherPaper.url,
            parent_id: otherPaper.id,
            child_id: currentPaper.id,
            confidence: null,
            reason: `edge budget reached (${maxEdges} investigation edges already recorded for this run)`,
            termination: "edge-budget-exhausted",
          });
          continue;
        }
        if (!existingCitation && createsCitationCycle(sourceKey, targetKey)) {
          rejected.push({
            parent_url: otherPaper.url,
            parent_id: otherPaper.id,
            child_id: currentPaper.id,
            confidence: null,
            reason: "accepting this citation relation would create a citation cycle",
            termination: "cycle",
          });
          continue;
        }
        const recursed = !sourceState.has(otherKey);
        if (recursed) {
          sourceState.set(otherKey, "queued");
          queue.push({ key: otherKey, depth: current.depth + 1, job_id: null });
        }
        if (!existingCitation) {
          citationEdges.push({
            sourceKey,
            targetKey,
            direction: proposal.citation_direction,
            recursed,
            provider_metadata: proposal.citation_metadata,
          });
          citationEdgesForSource += 1;
        }
        continue;
      }
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
      if (parentKey && parentKey !== current.key && proposal.discovered_by?.length) {
        // Rediscovered by another route: remember every channel that found it. Metadata only.
        let changed = false;
        for (const [index, known] of rawDocuments.entries()) {
          if (keyOf(known) !== parentKey) continue;
          const added = proposal.discovered_by.filter((channel) => !known.discovered_via.includes(channel));
          if (!added.length) continue;
          rawDocuments[index] = { ...known, discovered_via: [...known.discovered_via, ...added] };
          changed = true;
        }
        if (changed) {
          canonicalized = canonicalizeDocuments(rawDocuments);
          documents = canonicalized.documents;
        }
      }
      if (!parentKey) {
        const priorFailure = failedReferences.get(referenceKey);
        if (priorFailure) {
          rejected.push({
            parent_url: referenceKey,
            parent_id: null,
            child_id: child.id,
            confidence: null,
            reason: `previous acquisition failed: ${priorFailure}`,
            termination: "fetch-failure",
          });
          continue;
        }
        const ingested = await (acquisitions.get(referenceKey) ?? acquire(proposal));
        if (!ingested.ok) {
          fetchFailures += 1;
          const failure = `${ingested.reason}${ingested.detail ? `: ${ingested.detail}` : ""}`;
          failedReferences.set(referenceKey, failure);
          rejected.push({
            parent_url: referenceKey,
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
        const channels = (proposal.discovered_by ?? []).filter((channel) => !ingested.document.discovered_via.includes(channel));
        rawDocuments.push(channels.length ? { ...ingested.document, discovered_via: [...ingested.document.discovered_via, ...channels] } : ingested.document);
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
        const existingCandidate = candidateMatches.some((edge) => edge.sourceKey === parentKey && edge.targetKey === current.key);
        if (!existingCandidate && accepted.length + candidateMatches.length + citationEdges.length >= maxEdges) {
          rejected.push({
            parent_url: parent.url,
            parent_id: parent.id,
            child_id: currentChild.id,
            confidence: null,
            reason: `edge budget reached (${maxEdges} investigation edges already recorded for this run)`,
            termination: "edge-budget-exhausted",
          });
          continue;
        }
        if (!existingCandidate) {
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

      const wouldCreateCycle = createsCycle(parentKey, current.key);
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

      if (accepted.length + candidateMatches.length + citationEdges.length >= maxEdges) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: null,
          reason: `edge budget reached (${maxEdges} investigation edges already recorded for this run)`,
          termination: "edge-budget-exhausted",
        });
        continue;
      }

      const timings = computeTimings(documents);
      const eligibleParents = documents.filter(
        (candidate) => candidate.id !== currentChild.id && ordering(candidate, currentChild, timings) !== "impossible",
      );
      const score = scoreEdge(parent, currentChild, { timings, eligibleParents });
      const validated = !score.impossible && score.strong && score.confidence >= ACCEPT_THRESHOLD;
      let status: "validated" | "probable" | "related" | null = validated ? "validated" : null;
      if (status && acceptedForSource >= maxChildrenPerNode) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: score.confidence,
          reason: `children-per-node cap reached (${maxChildrenPerNode} accepted investigation links per source)`,
          termination: "children-per-node-cap",
        });
        continue;
      }
      if (
        !status &&
        (mode === "exploratory" || mode === "deep") &&
        !score.impossible &&
        score.has_meaningful_evidence &&
        score.exploratory_confidence >= EXPLORATORY_THRESHOLD
      ) {
        if (acceptedForSource >= maxChildrenPerNode || probableForSource >= maxProbableChildrenPerNode) {
          rejected.push({
            parent_url: parent.url,
            parent_id: parent.id,
            child_id: currentChild.id,
            confidence: score.exploratory_confidence,
            reason: acceptedForSource >= maxChildrenPerNode
              ? `children-per-node cap reached (${maxChildrenPerNode} accepted investigation links per source)`
              : `exploratory branch cap reached (${maxProbableChildrenPerNode} probable parents already accepted for this source)`,
            termination: acceptedForSource >= maxChildrenPerNode ? "children-per-node-cap" : "exploratory-branch-cap",
          });
          continue;
        }
        status = "probable";
      }
      if (
        !status &&
        mode === "deep" &&
        !score.impossible &&
        score.has_meaningful_evidence &&
        score.exploratory_confidence >= RELATED_THRESHOLD
      ) {
        if (acceptedForSource >= maxChildrenPerNode || relatedForSource >= maxRelatedChildrenPerNode) {
          rejected.push({
            parent_url: parent.url,
            parent_id: parent.id,
            child_id: currentChild.id,
            confidence: score.exploratory_confidence,
            reason: acceptedForSource >= maxChildrenPerNode
              ? `children-per-node cap reached (${maxChildrenPerNode} accepted investigation links per source)`
              : `related branch cap reached (${maxRelatedChildrenPerNode} related investigation links per source)`,
            termination: acceptedForSource >= maxChildrenPerNode ? "children-per-node-cap" : "related-branch-cap",
          });
          continue;
        }
        status = "related";
      }
      if (!status) {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: score.confidence,
          reason: wouldCreateCycle ? "accepting this proposed edge would create a provenance cycle" : rejectionReason(score, mode),
          termination: wouldCreateCycle ? "cycle" : "validation-rejected",
        });
        continue;
      }

      // Only an unknown-direction investigative relationship may close a cycle. Provenance
      // states retain the DAG invariant; `sourceState` below ensures even related cycles never
      // requeue an expanded document.
      if (wouldCreateCycle && status !== "related") {
        rejected.push({
          parent_url: parent.url,
          parent_id: parent.id,
          child_id: currentChild.id,
          confidence: status === "validated" ? score.confidence : score.exploratory_confidence,
          reason: "accepting this proposed edge would create a provenance cycle",
          termination: "cycle",
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
        status,
      });
      acceptedForSource += 1;
      if (status === "probable") probableForSource += 1;
      if (status === "related") relatedForSource += 1;
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
      reason: acceptedForSource > 0 ? "accepted-parents" : citationEdgesForSource > 0 ? "citation-edges" : candidateRootsForSource > 0 ? "candidate-roots" : "all-proposals-rejected",
      detail: null,
    });
  }

  const finalByKey = documentsByKey();
  const stats = {
    max_depth: maxDepth,
    sources_expanded: expandedCount,
    proposals_received: proposalsReceived,
    fetched,
    fetch_failures: fetchFailures,
    analysis_requests: analysisRequests,
    citation_edges: citationEdges.length,
  };
  const checkpointResult: TraversalCheckpoint | null = paused
    ? {
        documents,
        queue,
        source_states: [...sourceState.entries()],
        accepted,
        citation_edges: citationEdges,
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
        ? accepted.length > 0 || citationEdges.length > 0 || candidateMatches.length > 0
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
        edge.status,
      ),
    ),
    citation_edges: citationEdges.map((edge) => ({
      source_id: sourceFromDocuments(edge.sourceKey, finalByKey).id,
      target_id: sourceFromDocuments(edge.targetKey, finalByKey).id,
      direction: edge.direction,
      relationship_kind: "citation",
      recursed: edge.recursed,
      provider_metadata: edge.provider_metadata,
    })),
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
