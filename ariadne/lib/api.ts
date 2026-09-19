/**
 * Client for the Node/TypeScript research backend (default: http://localhost:4000).
 *
 * Base URL comes from NEXT_PUBLIC_API_URL so deploys can point elsewhere; trailing
 * slashes are stripped so paths never turn into `//api/...`.
 */

const DEFAULT_API_URL = "http://localhost:4000";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");

function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

/**
 * Frontend mirror of the backend's LineageTree (shared/tree.ts). Hand-written rather than
 * imported: shared/tree.ts is a Zod module outside this Next.js package, and pulling it in
 * would drag a runtime dependency across the package boundary for types alone.
 * The backend schema is the source of truth — keep these in sync with it, never the reverse.
 */

export type TimestampSource =
  | "meta"
  | "json-ld"
  | "time-element"
  | "pdf-metadata"
  | "court-filing-header"
  | "document-publication-label"
  | "url"
  | "search-result"
  | "none";

export type TimestampConfidence = "strong" | "moderate" | "weak" | "none";

export interface AiEvidence {
  provider: "gptzero";
  ai_probability: number;
  label: "human" | "mixed" | "ai";
  checked_at: string;
  flagged_passages: string[];
}

export interface LineageTreeNode {
  id: string;
  canonical_id: string;
  content_fingerprint: string;
  url: string;
  mirror_urls: string[];
  publisher: string;
  title: string;
  /** Publication time the document claims, if any. */
  timestamp: string | null;
  timestamp_source: TimestampSource;
  timestamp_confidence: TimestampConfidence;
  /** Earliest time the document can have existed, given what it links to. */
  earliest_possible: string | null;
  timestamp_conflict: string | null;
  passage: string;
  outbound_links: string[];
  fabricated_citations: string[];
  mutations: string[];
  ai_evidence: AiEvidence | null;
  discovered_via: string[];
  is_seed: boolean;
}

export interface TemporalEvidence {
  parent_time: string | null;
  child_time: string | null;
  gap_days: number | null;
  ordering: "strict" | "same-time" | "from-link" | "unknown";
}

export interface EdgeAlternative {
  candidate_id: string;
  confidence: number;
  reason: string;
}

export interface LineageTreeEdge {
  parent_id: string;
  child_id: string;
  type: "propagation" | "similarity";
  confidence: number;
  basis: string;
  shared_mutations: string[];
  explicit_link: boolean;
  rare_shared_phrases: number;
  similarity: number;
  temporal: TemporalEvidence;
  alternatives: EdgeAlternative[];
}

export interface RejectedEdge {
  parent_id: string;
  child_id: string;
  confidence: number;
  reason: string;
}

export interface ExcludedCandidate {
  id: string;
  url: string;
  reason: string;
}

export interface LineageTreeStats {
  discovery: "browserbase" | "offline-corpus";
  retrieval: "elastic-hybrid" | "elastic-lexical" | "memory-bm25";
  queries: string[];
  failed_queries: string[];
  fetched: number;
  candidates: number;
  pairs_scored: number;
}

export interface LineageTree {
  seed: { claim: string; url: string | null; fabricated_citations: string[] };
  generated_at: string;
  root_ids: string[];
  nodes: LineageTreeNode[];
  edges: LineageTreeEdge[];
  rejected_edges: RejectedEdge[];
  excluded: ExcludedCandidate[];
  stats: LineageTreeStats;
}

export interface ResearchResult {
  id: string;
  tree: LineageTree;
}

export interface CreateResearchOptions {
  seed_url?: string;
  fabricated_citations?: string[];
  include_ai_evidence?: boolean;
  signal?: AbortSignal;
}

/** Pull the backend's `{ error }` message out of a failed response, if there is one. */
async function errorFrom(response: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const body = await response.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      detail = (body as { error: string }).error;
    }
  } catch {
    // Non-JSON error body; fall through to the generic message.
  }
  return new Error(`${fallback} (${response.status}${detail ? `: ${detail}` : ""})`);
}

/** POST /api/research — builds a lineage tree for a claim. */
export async function createResearch(claim: string, options: CreateResearchOptions = {}): Promise<ResearchResult> {
  const { signal, ...rest } = options;
  const response = await fetch(apiUrl("/api/research"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, ...rest }),
    signal,
  });

  if (!response.ok) throw await errorFrom(response, "Research request failed");

  return (await response.json()) as ResearchResult;
}

/** GET /api/research/:id — a previously built lineage tree. */
export async function getResearch(id: string, signal?: AbortSignal): Promise<ResearchResult> {
  const response = await fetch(apiUrl(`/api/research/${encodeURIComponent(id)}`), {
    method: "GET",
    signal,
  });

  if (!response.ok) throw await errorFrom(response, `Could not load research "${id}"`);

  return (await response.json()) as ResearchResult;
}
