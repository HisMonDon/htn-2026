import type { TreeEdge } from "../../shared/tree";
import type { CandidateDocument } from "./extract";
import { canonicalText, jaccard, matchKey, shingles } from "./text";

/**
 * Deterministic scoring of one possible parent -> child edge. No model involved.
 *
 * Timing: a document's position in time is its claimed timestamp, unless it links to something
 * published later (then the claimed date is contradicted and only a lower bound is known).
 * Ordering between two documents is known when the child links to the parent, or when the parent
 * has a trustworthy timestamp no later than the child's. A later document never parents an
 * earlier one, and a document that links to the child is after it.
 */

export interface Timing {
  claimed: number | null;
  /** Latest publication time among documents this one links to. */
  lowerFromLinks: number | null;
  effective: number | null;
  /** Claimed timestamp is present and not contradicted by links. */
  exact: boolean;
  conflict: string | null;
}

/**
 * @param anchors Documents whose dates may bound others through links. Restrict this to lineage
 *   members: navigation or store pages often carry "today" as their date and would poison timing.
 */
export function computeTimings(docs: CandidateDocument[], anchors?: Set<string>): Map<string, Timing> {
  const byUrl = new Map(docs.filter((doc) => !anchors || anchors.has(doc.id)).map((doc) => [doc.url, doc]));
  const timings = new Map<string, Timing>();
  for (const doc of docs) {
    const claimed = doc.timestamp ? Date.parse(doc.timestamp) : null;
    timings.set(doc.id, { claimed, lowerFromLinks: null, effective: claimed, exact: claimed !== null, conflict: null });
  }
  // Propagate lower bounds along links; a few passes cover chains of links.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const doc of docs) {
      const timing = timings.get(doc.id)!;
      let lower: number | null = null;
      let because: CandidateDocument | null = null;
      for (const link of doc.outbound_links) {
        const target = byUrl.get(link);
        if (!target || target.id === doc.id) continue;
        const targetTiming = timings.get(target.id)!;
        const time = targetTiming.exact ? targetTiming.claimed : targetTiming.effective;
        if (time !== null && (lower === null || time > lower)) {
          lower = time;
          because = target;
        }
      }
      timing.lowerFromLinks = lower;
      if (lower !== null && (timing.claimed === null || lower > timing.claimed)) {
        timing.effective = lower;
        timing.exact = false;
        timing.conflict =
          timing.claimed !== null && because
            ? `claims ${new Date(timing.claimed).toISOString().slice(0, 10)} but links to ${because.id}, published ${new Date(lower).toISOString().slice(0, 10)}`
            : null;
      } else {
        timing.effective = timing.claimed;
        timing.exact = timing.claimed !== null;
        timing.conflict = null;
      }
    }
  }
  return timings;
}

export type Ordering = "strict" | "same-time" | "from-link" | "unknown" | "impossible";

export interface EdgeSignals {
  explicit_link: boolean;
  reverse_link: boolean;
  shared_fabricated: string[];
  shared_variants: string[];
  coverage: number;
  unique_phrases: number;
  similarity: number;
  ordering: Ordering;
}

export interface ScoredEdge {
  parent_id: string;
  child_id: string;
  confidence: number;
  strong: boolean;
  signals: EdgeSignals;
  reasons: string[];
  /** Set when the edge can never be accepted, e.g. wrong temporal order. */
  impossible: string | null;
  /**
   * Confidence before the CAP_WEAK clamp that keeps unsubstantiated similarity out of the strict
   * validated tier. Chronology-derived caps (same-time, unknown order) still apply: those guard
   * against claiming a direction the evidence doesn't support, not against weak-but-real evidence.
   * Only meaningful in exploratory mode; strict acceptance never reads this field.
   */
  exploratory_confidence: number;
  /**
   * True when at least one non-similarity signal is present: an explicit link, any shared
   * fabricated citation, a shared citation misspelling, or a rare shared phrase found in no other
   * candidate parent. Generic word-overlap similarity alone never sets this. Exploratory acceptance
   * requires this to be true; provider metadata (search rank, GPTZero confidence, etc.) never
   * contributes to it because it is never a scoring input in the first place.
   */
  has_meaningful_evidence: boolean;
}

const WEIGHT_LINK = 0.6;
const WEIGHT_FABRICATED = 0.35;
const WEIGHT_VARIANT = 0.15;
const WEIGHT_PHRASE = 0.05;
const CAP_PHRASES = 0.3;
const CAP_SIMILARITY = 0.15;
const CAP_WEAK = 0.25;
const CAP_UNKNOWN_ORDER = 0.3;
const CAP_SAME_TIME = 0.6;
export const MIN_COVERAGE = 2 / 3;

/**
 * Exploratory-mode-only acceptance floor, lower than the strict `ACCEPT_THRESHOLD` (0.35, in
 * ./tree.ts). Derived from the weight constants above rather than picked arbitrarily: it sits
 * just above what any *single* weak signal can contribute alone (a lone rare phrase tops out at
 * CAP_PHRASES=0.3 only with 6+ unique phrases, and typically contributes ~0.1-0.15; similarity
 * alone never exceeds CAP_SIMILARITY*noisyOr=0.15), but below what two independent weak signals
 * (e.g. one shared phrase + moderate similarity, or a single shared citation-spelling variant)
 * combine to via noisy-OR (commonly ~0.20-0.30). This keeps single-signal noise out while letting
 * genuinely corroborated-but-thin candidates recurse. Combined with `has_meaningful_evidence`,
 * pure content similarity can never cross this floor on its own.
 */
export const EXPLORATORY_THRESHOLD = 0.2;

function noisyOr(weights: number[]): number {
  return 1 - weights.reduce((product, weight) => product * (1 - weight), 1);
}

/**
 * Text with quoted passages removed. Two documents quoting the same primary source (a court order,
 * a press release) is not evidence that one copied the other, so quotations never count as copied
 * phrasing.
 */
export function unquoted(text: string): string {
  return canonicalText(text).replace(/"[^"]{20,}?"/g, " ");
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function ordering(parent: CandidateDocument, child: CandidateDocument, timings: Map<string, Timing>): Ordering {
  if (parent.outbound_links.includes(child.url)) return "impossible";
  if (child.outbound_links.includes(parent.url)) return "from-link";
  const p = timings.get(parent.id)!;
  const c = timings.get(child.id)!;
  // A link-derived lower bound after the child's own date proves the parent came later.
  if (p.effective !== null && c.exact && p.effective > c.claimed!) return "impossible";
  if (!p.exact || p.claimed === null || c.effective === null) return "unknown";
  if (c.exact) {
    if (p.claimed > c.claimed!) return "impossible";
    return p.claimed === c.claimed ? "same-time" : "strict";
  }
  // Child only has a lower bound: the parent is certainly earlier if it predates that bound.
  return p.claimed <= c.effective ? "from-link" : "unknown";
}

/**
 * The dated view of an edge: what each side claims, the gap, and how firmly they are ordered.
 * `impossible` is reported as `unknown` — an edge that cannot exist carries no usable ordering.
 */
export function temporalEvidence(parent: Timing, child: Timing, order: Ordering): TreeEdge["temporal"] {
  const parentTime = parent.exact ? parent.claimed : parent.effective;
  const childTime = child.effective;
  const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());
  return {
    parent_time: iso(parentTime),
    child_time: iso(childTime),
    gap_days: parentTime !== null && childTime !== null ? round((childTime - parentTime) / 86_400_000) : null,
    ordering: order === "impossible" ? "unknown" : order,
  };
}

export interface ScoringContext {
  timings: Map<string, Timing>;
  /** All possible parents of this child (used for rarity of shared phrasing and citations). */
  eligibleParents: CandidateDocument[];
}

export function scoreEdge(parent: CandidateDocument, child: CandidateDocument, context: ScoringContext): ScoredEdge {
  const order = ordering(parent, child, context.timings);
  const childFab = new Set(child.fabricated_citations.map(matchKey));
  const sharedFabricated = parent.fabricated_citations.filter((citation) => childFab.has(matchKey(citation)));
  const childVariants = new Set(child.citation_variants.map(matchKey));
  const sharedVariants = parent.citation_variants.filter((variant) => childVariants.has(matchKey(variant)));
  const coverage = childFab.size ? sharedFabricated.length / childFab.size : 0;

  const childPhrases = shingles(unquoted(child.text), 6);
  const parentPhrases = shingles(unquoted(parent.text), 6);
  const others = context.eligibleParents
    .filter((other) => other.id !== parent.id)
    .map((other) => shingles(unquoted(other.text), 6));
  let unique = 0;
  for (const phrase of parentPhrases) {
    if (childPhrases.has(phrase) && others.every((set) => !set.has(phrase))) unique += 1;
  }
  const similarity = round(jaccard(shingles(child.text, 3), shingles(parent.text, 3)));

  const signals: EdgeSignals = {
    explicit_link: child.outbound_links.includes(parent.url),
    reverse_link: parent.outbound_links.includes(child.url),
    shared_fabricated: sharedFabricated,
    shared_variants: sharedVariants,
    coverage: round(coverage),
    unique_phrases: unique,
    similarity,
    ordering: order,
  };

  const reasons: string[] = [];
  const p = context.timings.get(parent.id)!;
  const c = context.timings.get(child.id)!;

  if (order === "impossible") {
    const why = signals.reverse_link
      ? `${parent.id} links to ${child.id}, so it was written after it`
      : p.exact
        ? `${parent.id} (${day(p.claimed!)}) was published after ${child.id} (${day(c.claimed!)})`
        : `${parent.id} links to material from ${day(p.effective!)}, after ${child.id} (${day(c.claimed!)})`;
    return {
      parent_id: parent.id,
      child_id: child.id,
      confidence: 0,
      strong: false,
      signals,
      reasons: [why],
      impossible: why,
      exploratory_confidence: 0,
      has_meaningful_evidence: false,
    };
  }

  // Shared fabricated citations place both documents in the same lineage but rarely single out
  // the parent: discount by how many possible parents carry the same set.
  const carriers = context.eligibleParents.filter((other) => {
    const set = new Set(other.fabricated_citations.map(matchKey));
    return childFab.size > 0 && [...childFab].filter((citation) => set.has(citation)).length / childFab.size >= MIN_COVERAGE;
  }).length;
  const fabricatedWeight = coverage >= MIN_COVERAGE ? WEIGHT_FABRICATED / Math.sqrt(Math.max(1, carriers)) : 0.1 * coverage;

  let confidence = noisyOr([
    signals.explicit_link ? WEIGHT_LINK : 0,
    fabricatedWeight,
    Math.min(0.3, WEIGHT_VARIANT * sharedVariants.length),
    Math.min(CAP_PHRASES, WEIGHT_PHRASE * unique),
    Math.min(CAP_SIMILARITY, similarity * 0.3),
  ]);

  // Copied phrasing helps choose between parents already tied to the claim, but on its own it is
  // only textual similarity.
  // Identical timestamps without a link say nothing about direction (both may copy an unseen source).
  const directionKnown = order === "strict" || order === "from-link" || signals.explicit_link;
  const strong = directionKnown && (signals.explicit_link || coverage >= MIN_COVERAGE || sharedVariants.length > 0);

  if (signals.explicit_link) reasons.push(`${child.id} links to ${parent.id}`);
  if (sharedFabricated.length) {
    reasons.push(
      `shares ${sharedFabricated.length} of ${childFab.size} fabricated citations${
        carriers > 1 && coverage >= MIN_COVERAGE
          ? ` (as do ${carriers - 1} other possible parent${carriers - 1 === 1 ? "" : "s"})`
          : ""
      }`,
    );
  }
  if (sharedVariants.length) reasons.push(`shares the misspelling ${sharedVariants.map((v) => `"${v}"`).join(", ")}`);
  if (unique) {
    reasons.push(`${unique} copied 6-word phrase${unique === 1 ? "" : "s"} (outside quotations) found in no other possible parent`);
  }
  reasons.push(`word overlap ${similarity}`);

  if (order === "strict") reasons.push(`${parent.id} (${day(p.claimed!)}) precedes ${child.id} (${day(c.effective!)})`);
  if (order === "same-time") {
    confidence = Math.min(confidence, CAP_SAME_TIME);
    reasons.push(
      signals.explicit_link
        ? "same timestamp; direction taken from the link"
        : "same timestamp and no link: direction unknown (both may copy an unseen common source)",
    );
  }
  if (order === "from-link" && !signals.explicit_link) {
    reasons.push(`${child.id} links to a page published on or after ${day(c.effective!)}, so it follows ${parent.id}`);
  }
  if (order === "unknown") {
    confidence = Math.min(confidence, CAP_UNKNOWN_ORDER);
    reasons.push(p.conflict ? `order unknown: ${parent.id} ${p.conflict}` : "order unknown: no trustworthy timestamp");
  }
  // Chronology caps (same-time/unknown, above) bound what direction the evidence supports and
  // apply in both modes. The weak-evidence cap below exists only to keep unsubstantiated
  // similarity out of the strict validated tier, so exploratory mode reads confidence from before
  // this point instead.
  const exploratoryConfidence = confidence;
  const hasMeaningfulEvidence = signals.explicit_link || coverage > 0 || sharedVariants.length > 0 || unique > 0;

  if (!signals.explicit_link && coverage < MIN_COVERAGE && sharedVariants.length === 0) {
    confidence = Math.min(confidence, CAP_WEAK);
    reasons.push(
      coverage > 0
        ? `only ${sharedFabricated.length} of ${childFab.size} fabricated citations shared; a single shared case name is weak evidence`
        : unique > 0
          ? "copied phrasing but no link or shared fabricated citation; not enough to claim propagation"
          : "only textual similarity; not enough to claim propagation",
    );
  }

  return {
    parent_id: parent.id,
    child_id: child.id,
    confidence: round(confidence),
    strong,
    signals,
    reasons,
    impossible: null,
    exploratory_confidence: round(exploratoryConfidence),
    has_meaningful_evidence: hasMeaningfulEvidence,
  };
}
