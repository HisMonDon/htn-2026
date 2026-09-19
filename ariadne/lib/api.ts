/**
 * Client for the Node/TypeScript research backend (default: http://localhost:4000).
 *
 * Base URL comes from NEXT_PUBLIC_API_URL so deploys can point elsewhere; trailing
 * slashes are stripped so paths never turn into `//api/...`.
 */

import type { AriadneResponse } from "../../shared/ariadne";

const DEFAULT_API_URL = "http://localhost:4000";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");

function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

// Type-only aliases keep the frontend on the backend's exact response contract without
// pulling the shared Zod schemas into the browser bundle.
export type ResearchResult = AriadneResponse;
export type LineageTree = AriadneResponse["tree"];
export type LineageTreeNode = LineageTree["nodes"][number];
export type LineageTreeEdge = LineageTree["edges"][number];
export type RejectedEdge = LineageTree["rejected_edges"][number];
export type ExcludedCandidate = LineageTree["excluded"][number];
export type BackendEdge = AriadneResponse["edges"][number];

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
