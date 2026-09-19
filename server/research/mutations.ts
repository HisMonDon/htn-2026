import type { ClaimMutation } from "../../shared/tree";
import type { CandidateDocument } from "./extract";
import { canonicalText, jaccard, matchKey, tokens } from "./text";

const MATCH_THRESHOLD = 0.28;
const MAX_MUTATIONS = 6;
const MAX_QUOTE_LENGTH = 240;

interface ClaimUnit {
  text: string;
  exactKey: string;
  words: Set<string>;
  index: number;
}

/**
 * Split the selected claim passage without breaking legal names at `v.`. The extractor already
 * narrows `passage` to the paragraph most relevant to the investigated claim, so this deliberately
 * avoids diffing navigation, captions, or the rest of the article.
 */
function sentences(value: string): string[] {
  const protectedValue = canonicalText(value)
    .replace(/\bv\.\s/gi, "v\uE000 ")
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|No)\.\s/g, "$1\uE000 ");
  return protectedValue
    .split(/(?<=[.!?])\s+(?=["'([A-Z0-9])/)
    .map((sentence) => sentence.replace(/\uE000/g, ".").trim())
    .filter((sentence) => tokens(sentence).length >= 4);
}

function removeKnownCitations(value: string, documents: CandidateDocument[]): string {
  let result = value;
  const citations = new Set(
    documents.flatMap((document) => [...document.fabricated_citations, ...document.citation_variants]),
  );
  for (const citation of citations) {
    const escaped = citation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), " ");
  }
  return result;
}

function claimUnits(document: CandidateDocument, pair: CandidateDocument[]): ClaimUnit[] {
  return sentences(document.passage || document.text).map((text, index) => {
    const comparisonText = removeKnownCitations(text, pair);
    const exactKey = matchKey(text).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
    return { text, exactKey, words: new Set(tokens(comparisonText)), index };
  });
}

function quote(value: string): string {
  if (value.length <= MAX_QUOTE_LENGTH) return `“${value}”`;
  return `“${value.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…”`;
}

function added(after: string): ClaimMutation {
  return { type: "added", summary: `Added claim: ${quote(after)}`, before: null, after };
}

function omitted(before: string): ClaimMutation {
  return { type: "omitted", summary: `Omitted claim: ${quote(before)}`, before, after: null };
}

function reframed(before: string, after: string): ClaimMutation {
  return {
    type: "reframed",
    summary: `Reframed ${quote(before)} as ${quote(after)}`,
    before,
    after,
  };
}

/**
 * Produce a deterministic, sentence-level description of how the claim-bearing passage changed
 * from a validated parent to its child. Exact and reordered sentences are treated as retained,
 * related sentences as reframed, and unmatched sentences as additions or omissions.
 */
export function analyzeClaimMutations(parent: CandidateDocument, child: CandidateDocument): ClaimMutation[] {
  const pair = [parent, child];
  const parents = claimUnits(parent, pair);
  const children = claimUnits(child, pair);
  const matchedParents = new Set<number>();
  const matchedChildren = new Set<number>();
  const mutations: Array<ClaimMutation & { order: number; priority: number }> = [];

  // Exact text survives punctuation/case/whitespace differences and movement within the passage.
  for (const childUnit of children) {
    const parentUnit = parents.find(
      (candidate) =>
        !matchedParents.has(candidate.index) &&
        candidate.exactKey.length > 0 &&
        candidate.exactKey === childUnit.exactKey,
    );
    if (!parentUnit) continue;
    matchedParents.add(parentUnit.index);
    matchedChildren.add(childUnit.index);
  }

  // Greedy maximum-overlap matching is stable because ties break on the original sentence order.
  const candidates = parents.flatMap((parentUnit) =>
    children.map((childUnit) => ({
      parent: parentUnit,
      child: childUnit,
      similarity: jaccard(parentUnit.words, childUnit.words),
    })),
  );
  candidates.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.parent.index - b.parent.index ||
      a.child.index - b.child.index,
  );
  for (const candidate of candidates) {
    if (candidate.similarity < MATCH_THRESHOLD) break;
    if (matchedParents.has(candidate.parent.index) || matchedChildren.has(candidate.child.index)) continue;
    matchedParents.add(candidate.parent.index);
    matchedChildren.add(candidate.child.index);
    mutations.push({
      ...reframed(candidate.parent.text, candidate.child.text),
      order: candidate.child.index,
      priority: 0,
    });
  }

  for (const childUnit of children) {
    if (matchedChildren.has(childUnit.index)) continue;
    mutations.push({ ...added(childUnit.text), order: childUnit.index, priority: 1 });
  }
  for (const parentUnit of parents) {
    if (matchedParents.has(parentUnit.index)) continue;
    mutations.push({ ...omitted(parentUnit.text), order: parentUnit.index, priority: 2 });
  }

  return mutations
    .sort((a, b) => a.priority - b.priority || a.order - b.order || a.summary.localeCompare(b.summary))
    .slice(0, MAX_MUTATIONS)
    .map(({ order: _order, priority: _priority, ...mutation }) => mutation);
}
