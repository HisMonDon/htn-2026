import type { ProvenanceEdgeValidation } from "../../shared/provenance-validation";
import type { RejectedEdge, TreeEdge } from "../../shared/tree";
import { computeTimings, ordering } from "../research/edges";
import type { CandidateDocument } from "../research/extract";
import { analyzeClaimMutations } from "../research/mutations";

/** The graph-only result of assembling independently validated relationships. */
export interface ReconstructedProvenanceDag {
  root_ids: string[];
  edges: TreeEdge[];
  rejected_edges: RejectedEdge[];
  /** Transitive ancestors for every candidate node in deterministic id order. */
  ancestry: Record<string, string[]>;
}

function effectiveTime(document: CandidateDocument, timings: ReturnType<typeof computeTimings>): number {
  return timings.get(document.id)?.effective ?? Number.MAX_SAFE_INTEGER;
}

function wouldCreateCycle(edges: TreeEdge[], parentId: string, childId: string): boolean {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.parent_id) ?? [];
    list.push(edge.child_id);
    children.set(edge.parent_id, list);
  }
  const pending = [childId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === parentId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return false;
}

function computeAncestry(ids: string[], edges: TreeEdge[]): Record<string, string[]> {
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const edge of edges) {
    parents.get(edge.child_id)!.push(edge.parent_id);
    children.get(edge.parent_id)!.push(edge.child_id);
    indegree.set(edge.child_id, (indegree.get(edge.child_id) ?? 0) + 1);
  }
  for (const values of parents.values()) values.sort();
  for (const values of children.values()) values.sort();

  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const ancestors = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of children.get(parent) ?? []) {
      const childAncestors = ancestors.get(child)!;
      childAncestors.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) childAncestors.add(ancestor);
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  return Object.fromEntries(ids.sort().map((id) => [id, [...ancestors.get(id)!].sort()]));
}

/**
 * Reconstruct a cycle-free provenance DAG from validation output. Validation establishes whether
 * each pair is defensible; this stage establishes graph-wide facts: endpoint integrity, chronology,
 * duplicate suppression, cycle prevention, roots, and transitive ancestry.
 */
export function reconstructValidatedProvenance(
  documents: CandidateDocument[],
  validations: ProvenanceEdgeValidation[],
): ReconstructedProvenanceDag {
  const byId = new Map<string, CandidateDocument>();
  for (const document of documents) {
    if (byId.has(document.id)) throw new Error(`duplicate candidate node id "${document.id}"`);
    byId.set(document.id, document);
  }
  const timings = computeTimings(documents, new Set(byId.keys()));
  const accepted: TreeEdge[] = [];
  const rejected: RejectedEdge[] = [];
  const seen = new Set<string>();

  const sorted = [...validations].sort((a, b) => {
    const parentA = byId.get(a.parent_id);
    const parentB = byId.get(b.parent_id);
    const childA = byId.get(a.child_id);
    const childB = byId.get(b.child_id);
    return (
      (parentA ? effectiveTime(parentA, timings) : Number.MAX_SAFE_INTEGER) -
        (parentB ? effectiveTime(parentB, timings) : Number.MAX_SAFE_INTEGER) ||
      (childA ? effectiveTime(childA, timings) : Number.MAX_SAFE_INTEGER) -
        (childB ? effectiveTime(childB, timings) : Number.MAX_SAFE_INTEGER) ||
      a.parent_id.localeCompare(b.parent_id) ||
      a.child_id.localeCompare(b.child_id) ||
      b.confidence - a.confidence
    );
  });

  for (const validation of sorted) {
    const reject = (reason: string) =>
      rejected.push({
        parent_id: validation.parent_id,
        child_id: validation.child_id,
        confidence: validation.confidence,
        reason,
      });

    if (!validation.accepted || !validation.graph_edge) {
      reject(validation.reasons.join("; "));
      continue;
    }
    const parent = byId.get(validation.parent_id);
    const child = byId.get(validation.child_id);
    if (!parent || !child) {
      reject(`validated relationship references missing ${!parent ? "parent" : "child"} node`);
      continue;
    }
    const edge = validation.graph_edge;
    if (edge.parent_id !== validation.parent_id || edge.child_id !== validation.child_id) {
      reject("validated graph edge endpoints do not match the validation record");
      continue;
    }
    const key = `${edge.parent_id}\u0000${edge.child_id}`;
    if (seen.has(key)) {
      reject("duplicate validated relationship");
      continue;
    }

    const order = ordering(parent, child, timings);
    // Missing or equal dates are not contradictions. Only the validator judges whether
    // other evidence establishes direction; assembly never reclassifies or rescores it.
    if (order === "impossible") {
      reject(`validated relationship has no defensible parent-before-child order (${order})`);
      continue;
    }
    if (wouldCreateCycle(accepted, edge.parent_id, edge.child_id)) {
      reject("accepting this validated relationship would create a provenance cycle");
      continue;
    }

    seen.add(key);
    accepted.push({
      ...edge,
      claim_mutations: analyzeClaimMutations(parent, child),
    });
  }

  const childIds = new Set(accepted.map((edge) => edge.child_id));
  const rootIds = [...byId.values()]
    .filter((document) => !childIds.has(document.id))
    .sort((a, b) => effectiveTime(a, timings) - effectiveTime(b, timings) || a.id.localeCompare(b.id))
    .map((document) => document.id);
  const ids = [...byId.keys()];
  return {
    root_ids: rootIds,
    edges: accepted,
    rejected_edges: rejected,
    ancestry: computeAncestry(ids, accepted),
  };
}
