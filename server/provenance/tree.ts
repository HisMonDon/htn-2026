import type { AiEvidence } from "../../shared/schema";
import { type DocumentIndex, type ProvenanceDocument, toScoringDoc } from "./document-index";
import { scoreParents, type CandidateScore } from "./score";

export interface LineageNode {
  id: string;
  title: string;
  url: string;
  publisher: string;
  timestamp: string;
  excerpt: string;
  ai_evidence: AiEvidence | null;
  mutations: string[];
}

export interface LineageEdge {
  source: string;
  target: string;
  confidence: number;
  basis: string;
  explicit_link_evidence: string[];
  explicit_reference_evidence: string[];
  temporal_evidence: string;
  shared_mutations: string[];
  new_mutations: string[];
  removed_mutations: string[];
  similarity: number;
}

export interface RejectedLineageEdge {
  source: string;
  target: string;
  score: number;
  reason: string;
  eligible: boolean;
}

export interface LineageTree {
  nodes: LineageNode[];
  edges: LineageEdge[];
  rejected_edges: RejectedLineageEdge[];
  discovery: {
    seed_id: string;
    candidate_count: number;
    candidate_ids: string[];
  };
}

export interface ReconstructOptions {
  knownMutations?: string[];
  limit?: number;
  minConfidence?: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mutations(document: ProvenanceDocument): string[] {
  return unique([...(document.fabricatedCitations ?? []), ...(document.rareMutations ?? [])]);
}

function matchingLinks(target: ProvenanceDocument, parent: ProvenanceDocument): string[] {
  const wanted = parent.url.toLowerCase().replace(/\/+$/, "");
  return (target.explicitLinks ?? []).filter((link) => link.toLowerCase().replace(/\/+$/, "") === wanted);
}

function normalizeReference(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchingReferences(target: ProvenanceDocument, parent: ProvenanceDocument): string[] {
  const identities = unique([parent.id, parent.title, parent.publisher, parent.url]).map(normalizeReference);
  return (target.sourceReferences ?? []).filter((reference) => identities.includes(normalizeReference(reference)));
}

function edgeFromScore(
  parent: ProvenanceDocument,
  target: ProvenanceDocument,
  score: CandidateScore,
  confidence: number,
  basis: string,
): LineageEdge {
  const parentMutations = mutations(parent);
  const targetMutations = mutations(target);
  const parentSet = new Set(parentMutations);
  const targetSet = new Set(targetMutations);
  return {
    source: parent.id,
    target: target.id,
    confidence,
    basis,
    explicit_link_evidence: matchingLinks(target, parent),
    explicit_reference_evidence: matchingReferences(target, parent),
    temporal_evidence: `${parent.timestamp} <= ${target.timestamp}`,
    shared_mutations: targetMutations.filter((mutation) => parentSet.has(mutation)),
    new_mutations: targetMutations.filter((mutation) => !parentSet.has(mutation)),
    removed_mutations: parentMutations.filter((mutation) => !targetSet.has(mutation)),
    similarity: score.signals.similarity,
  };
}

function wouldCycle(parentId: string, targetId: string, parentOf: Map<string, string>): boolean {
  let cursor: string | undefined = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === targetId) return true;
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

function node(document: ProvenanceDocument): LineageNode {
  return {
    id: document.id,
    title: document.title,
    url: document.url,
    publisher: document.publisher,
    timestamp: document.timestamp,
    excerpt: document.relevantPassage,
    ai_evidence: document.aiEvidence ?? null,
    mutations: mutations(document),
  };
}

export async function reconstructLineage(
  seed: ProvenanceDocument,
  index: DocumentIndex,
  options: ReconstructOptions = {},
): Promise<LineageTree> {
  const knownMutations = unique(options.knownMutations ?? mutations(seed));
  const candidates = await index.search({
    text: [seed.title, seed.claim ?? "", seed.relevantPassage, ...knownMutations].join(" "),
    mutations: knownMutations,
    limit: options.limit ?? 20,
  });
  const documents = new Map<string, ProvenanceDocument>();
  for (const document of candidates) documents.set(document.id, document);
  documents.set(seed.id, seed);
  const ordered = [...documents.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id),
  );
  const scoringDocs = ordered.map(toScoringDoc);
  const byId = new Map(ordered.map((document) => [document.id, document]));
  const edges: LineageEdge[] = [];
  const rejected: RejectedLineageEdge[] = [];
  const parentOf = new Map<string, string>();
  const minConfidence = options.minConfidence ?? 0.5;

  for (const target of ordered) {
    const result = scoreParents(
      toScoringDoc(target),
      scoringDocs.filter((candidate) => candidate.id !== target.id),
      { knownMutations },
    );
    const acceptedParent =
      result.parent_id && result.type === "propagation" && result.confidence >= minConfidence
        ? result.parent_id
        : null;
    let accepted = false;

    if (acceptedParent) {
      const parent = byId.get(acceptedParent);
      const score = result.candidates.find((candidate) => candidate.candidate_id === acceptedParent);
      if (parent && score && !wouldCycle(parent.id, target.id, parentOf)) {
        edges.push(edgeFromScore(parent, target, score, result.confidence, result.basis));
        parentOf.set(target.id, parent.id);
        accepted = true;
      }
    }

    for (const candidate of result.candidates) {
      if (accepted && candidate.candidate_id === acceptedParent) continue;
      let reason = candidate.basis;
      if (candidate.candidate_id === acceptedParent && !accepted) reason = `${reason}; rejected to avoid a cycle`;
      if (candidate.candidate_id === result.parent_id && result.type !== "propagation") {
        reason = `${reason}; strongest candidate is still similarity-only`;
      } else if (candidate.candidate_id === result.parent_id && result.confidence < minConfidence) {
        reason = `${reason}; confidence ${result.confidence} is below the ${minConfidence} propagation threshold`;
      }
      rejected.push({
        source: candidate.candidate_id,
        target: target.id,
        score: candidate.confidence,
        reason,
        eligible: candidate.eligible,
      });
    }
  }

  return {
    nodes: ordered.map(node),
    edges,
    rejected_edges: rejected,
    discovery: {
      seed_id: seed.id,
      candidate_count: ordered.length,
      candidate_ids: ordered.map((document) => document.id),
    },
  };
}
