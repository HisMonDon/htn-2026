import type { AiEvidence } from "../../shared/schema";
import type { LineageTree, RejectedEdge, TreeEdge, TreeNode } from "../../shared/tree";
import type { CandidateIndex } from "./candidate-index";
import { computeTimings, MIN_COVERAGE, ordering, round, scoreEdge, type ScoredEdge, type Timing } from "./edges";
import type { CandidateDocument } from "./extract";
import { matchKey } from "./text";

/** Minimum confidence for an accepted edge. Below this a node stays a root. */
export const ACCEPT_THRESHOLD = 0.35;
/** When the best two parents are this close, the choice is ambiguous and confidence is reduced. */
const AMBIGUITY_MARGIN = 0.05;
const AMBIGUITY_FACTOR = 0.8;
const RELATED_PER_DOC = 10;
const REJECTED_PER_CHILD = 4;

export interface BuildInput {
  runId: string;
  claim: string;
  seedUrl: string | null;
  seedId: string | null;
  fabricated: string[];
  documents: CandidateDocument[];
  index: CandidateIndex;
  aiEvidence?: Map<string, AiEvidence>;
  stats: Omit<LineageTree["stats"], "retrieval" | "pairs_scored" | "candidates">;
  now?: () => Date;
}

function coverageOf(doc: CandidateDocument, fabricated: string[]): number {
  if (fabricated.length === 0) return 0;
  const set = new Set(doc.fabricated_citations.map(matchKey));
  return fabricated.filter((citation) => set.has(matchKey(citation))).length / fabricated.length;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function temporal(parent: Timing, child: Timing, ordering: ScoredEdge["signals"]["ordering"]): TreeEdge["temporal"] {
  const parentTime = parent.exact ? parent.claimed : parent.effective;
  const childTime = child.effective;
  return {
    parent_time: iso(parentTime),
    child_time: iso(childTime),
    gap_days:
      parentTime !== null && childTime !== null ? round((childTime - parentTime) / 86_400_000) : null,
    ordering: ordering === "impossible" ? "unknown" : ordering,
  };
}

export async function buildTree(input: BuildInput): Promise<LineageTree> {
  const now = input.now ?? (() => new Date());
  const docs = input.documents;
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const byUrl = new Map(docs.map((doc) => [doc.url, doc]));
  // 1. Which candidates carry the claim at all? Only those can be in the lineage.
  const included: CandidateDocument[] = [];
  const excluded: LineageTree["excluded"] = [];
  for (const doc of docs) {
    const coverage = coverageOf(doc, input.fabricated);
    if (doc.id === input.seedId || coverage >= MIN_COVERAGE || doc.citation_variants.length > 0) {
      included.push(doc);
      continue;
    }
    excluded.push({
      id: doc.id,
      url: doc.url,
      reason:
        doc.fabricated_citations.length === 0
          ? "does not repeat any of the fabricated citations"
          : `repeats only ${doc.fabricated_citations.join(", ")} (${doc.fabricated_citations.length} of ${input.fabricated.length}); a lone common case name does not place it in this lineage`,
    });
  }
  const includedIds = new Set(included.map((doc) => doc.id));
  const timings = computeTimings(docs, includedIds);

  // 2. Candidate pairs: retrieval proposes, links add explicit references. Nothing is decided here.
  await input.index.indexDocuments(input.runId, docs);
  const proposals = new Map<string, Set<string>>();
  try {
    for (const child of included) {
      const set = new Set<string>();
      for (const hit of await input.index.related(input.runId, child, RELATED_PER_DOC)) set.add(hit.id);
      for (const link of child.outbound_links) {
        const target = byUrl.get(link);
        if (target) set.add(target.id);
      }
      set.delete(child.id);
      proposals.set(child.id, set);
    }
  } finally {
    await input.index.cleanup(input.runId).catch(() => undefined);
  }

  // 3. Score every proposed pair.
  let pairsScored = 0;
  const scored = new Map<string, ScoredEdge[]>();
  for (const child of included) {
    const proposed = [...(proposals.get(child.id) ?? [])].map((id) => byId.get(id)!).filter(Boolean);
    // Rarity of shared evidence is judged only among parents that could really have come first.
    const eligible = proposed.filter(
      (parent) => includedIds.has(parent.id) && ordering(parent, child, timings) !== "impossible",
    );
    const edges = proposed.map((parent) => {
      pairsScored += 1;
      const edge = scoreEdge(parent, child, { timings, eligibleParents: eligible });
      if (!includedIds.has(parent.id)) {
        // Out-of-lineage candidates are scored for explanation only and can never be accepted.
        const reason = excluded.find((entry) => entry.id === parent.id)?.reason ?? "not in the lineage";
        return { ...edge, strong: false, impossible: edge.impossible ?? `${parent.id} ${reason}` };
      }
      return edge;
    });
    scored.set(
      child.id,
      edges.sort((a, b) => b.confidence - a.confidence || a.parent_id.localeCompare(b.parent_id)),
    );
  }

  // 4. Choose parents, earliest children first, refusing cycles.
  const parentOf = new Map<string, string>();
  const createsCycle = (parent: string, child: string) => {
    let current: string | undefined = parent;
    while (current !== undefined) {
      if (current === child) return true;
      current = parentOf.get(current);
    }
    return false;
  };
  const order = [...included].sort((a, b) => {
    const ta = timings.get(a.id)!.effective ?? Number.MAX_SAFE_INTEGER;
    const tb = timings.get(b.id)!.effective ?? Number.MAX_SAFE_INTEGER;
    return ta - tb || a.id.localeCompare(b.id);
  });

  const edges: TreeEdge[] = [];
  const rejected: RejectedEdge[] = [];
  for (const child of order) {
    const candidates = scored.get(child.id) ?? [];
    const acceptable = candidates.filter(
      (edge) => !edge.impossible && edge.strong && edge.confidence >= ACCEPT_THRESHOLD && !createsCycle(edge.parent_id, child.id),
    );
    const best = acceptable[0];
    const runnerUp = acceptable[1];

    if (best) {
      let confidence = best.confidence;
      const basis = [...best.reasons];
      if (runnerUp && best.confidence - runnerUp.confidence <= AMBIGUITY_MARGIN) {
        confidence = round(confidence * AMBIGUITY_FACTOR);
        basis.push(`ambiguous with ${runnerUp.parent_id} (${runnerUp.confidence}); chose the more recent/specific source`);
      }
      parentOf.set(child.id, best.parent_id);
      edges.push({
        parent_id: best.parent_id,
        child_id: child.id,
        type: (best.signals.explicit_link || best.signals.coverage >= MIN_COVERAGE) && confidence >= 0.5 ? "propagation" : "similarity",
        confidence,
        basis: basis.join("; "),
        shared_mutations: [...best.signals.shared_fabricated, ...best.signals.shared_variants],
        explicit_link: best.signals.explicit_link,
        rare_shared_phrases: best.signals.unique_phrases,
        similarity: best.signals.similarity,
        temporal: temporal(timings.get(best.parent_id)!, timings.get(child.id)!, best.signals.ordering),
        alternatives: candidates
          .filter((edge) => edge !== best)
          .slice(0, 3)
          .map((edge) => ({
            candidate_id: edge.parent_id,
            confidence: edge.confidence,
            reason: edge.impossible ?? `${edge.confidence} < ${best.confidence}: ${edge.reasons.slice(0, 2).join("; ")}`,
          })),
      });
    }

    for (const edge of candidates.filter((candidate) => candidate !== best).slice(0, REJECTED_PER_CHILD)) {
      const reason =
        edge.impossible ??
        (!edge.strong
          ? `insufficient evidence: ${edge.reasons.slice(-1)[0]}`
          : edge.confidence < ACCEPT_THRESHOLD
            ? `confidence ${edge.confidence} below ${ACCEPT_THRESHOLD}`
            : best
              ? `weaker than ${best.parent_id} (${edge.confidence} vs ${best.confidence})`
              : "would create a cycle");
      rejected.push({ parent_id: edge.parent_id, child_id: child.id, confidence: edge.confidence, reason });
    }
  }

  // 5. Nodes and roots.
  const nodes: TreeNode[] = included.map((doc) => {
    const timing = timings.get(doc.id)!;
    return {
      id: doc.id,
      canonical_id: doc.canonical_id,
      content_fingerprint: doc.content_fingerprint,
      url: doc.url,
      mirror_urls: doc.mirror_urls,
      publisher: doc.publisher,
      title: doc.title,
      timestamp: doc.timestamp,
      timestamp_source: doc.timestamp_source,
      timestamp_confidence: doc.timestamp_confidence,
      earliest_possible: iso(timing.effective),
      timestamp_conflict: [doc.timestamp_conflict, timing.conflict].filter((conflict): conflict is string => conflict !== null).join("; ") || null,
      passage: doc.passage,
      outbound_links: doc.outbound_links,
      fabricated_citations: doc.fabricated_citations,
      mutations: [...doc.fabricated_citations, ...doc.citation_variants],
      ai_evidence: input.aiEvidence?.get(doc.id) ?? null,
      discovered_via: doc.discovered_via,
      is_seed: doc.id === input.seedId,
    };
  });
  const rootIds = order.filter((doc) => !parentOf.has(doc.id)).map((doc) => doc.id);

  return {
    seed: { claim: input.claim, url: input.seedUrl, fabricated_citations: input.fabricated },
    generated_at: now().toISOString(),
    root_ids: rootIds,
    nodes,
    edges,
    rejected_edges: rejected,
    excluded,
    stats: {
      ...input.stats,
      retrieval: input.index.kind,
      candidates: docs.length,
      pairs_scored: pairsScored,
    },
  };
}
