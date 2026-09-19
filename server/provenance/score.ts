import type { Edge } from "../../shared/schema";

/**
 * Deterministic parent scoring for a propagation chain. No LLM.
 *
 * Signals, strongest first:
 *   explicit link    the target links to or cites the candidate's URL
 *   shared mutation  both contain a known error (fabricated citation, fake author, typo); weighted by
 *                    how rare it is among the candidates, so a mutation every candidate shares cannot
 *                    single out a parent
 *   rare phrasing    word 6-grams the target shares with this candidate and with no other candidate;
 *                    only meaningful with enough candidates to judge rarity, otherwise it is similarity
 *   similarity       overall word overlap; weak, and capped so it can never carry a claim alone
 *
 * Timestamp ordering is a precondition, not evidence: a later document is never a parent.
 */

export interface ProvenanceDoc {
  id: string;
  timestamp: string;
  text: string;
  url?: string;
  /** Outbound links or citations found in the document. */
  links?: string[];
}

export interface ScoreOptions {
  /** Strings known to be erroneous: fabricated citations, invented authors, distinctive typos. */
  knownMutations?: string[];
}

export interface CandidateSignals {
  explicit_link: boolean;
  shared_mutations: string[];
  rare_shared_phrases: number;
  similarity: number;
  same_timestamp: boolean;
}

export interface CandidateScore {
  candidate_id: string;
  eligible: boolean;
  confidence: number;
  basis: string;
  signals: CandidateSignals;
}

export interface ProvenanceResult {
  parent_id: string | null;
  confidence: number;
  type: Edge["type"];
  basis: string;
  candidates: CandidateScore[];
}

const WEIGHT_LINK = 0.6;
const WEIGHT_MUTATION = 0.5;
const CAP_MUTATIONS = 0.7;
const WEIGHT_PHRASE = 0.04;
const CAP_PHRASES = 0.25;
const CAP_SIMILARITY = 0.15;
/** Without a link or a shared mutation, confidence cannot exceed these. */
const CAP_WEAK = 0.25;
const CAP_PHRASING_ONLY = 0.4;
/** Rarity of a phrase can only be judged against at least this many earlier candidates. */
const MIN_POOL_FOR_RARITY = 3;
/** Timestamps that cannot order the two documents limit confidence. */
const CAP_SAME_TIME = 0.6;
const MIN_PARENT_CONFIDENCE = 0.15;
const AMBIGUITY_MARGIN = 0.05;
const AMBIGUITY_FACTOR = 0.6;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, "")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

function shingles(text: string, size: number): Set<string> {
  const words = tokens(text);
  const out = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    out.add(words.slice(index, index + size).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function linksTo(target: ProvenanceDoc, candidate: ProvenanceDoc): boolean {
  if (!candidate.url) return false;
  const wanted = canonicalUrl(candidate.url);
  if ((target.links ?? []).some((link) => canonicalUrl(link) === wanted)) return true;
  return target.text.toLowerCase().includes(wanted);
}

function noisyOr(weights: number[]): number {
  return 1 - weights.reduce((product, weight) => product * (1 - weight), 1);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function scoreParents(
  target: ProvenanceDoc,
  candidates: ProvenanceDoc[],
  options: ScoreOptions = {},
): ProvenanceResult {
  const targetTime = Date.parse(target.timestamp);
  const mutations = [...new Set((options.knownMutations ?? []).map(normalize).filter(Boolean))];
  const targetNorm = normalize(target.text);
  const targetMutations = mutations.filter((mutation) => targetNorm.includes(mutation));
  const targetPhrases = shingles(target.text, 6);
  const targetTrigrams = shingles(target.text, 3);

  const pool = candidates.filter((candidate) => candidate.id !== target.id);
  const eligible = pool.filter((candidate) => Date.parse(candidate.timestamp) <= targetTime);

  // How many eligible candidates carry each mutation / phrase, for rarity weighting.
  const mutationCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const candidatePhrases = new Map<string, Set<string>>();
  for (const candidate of eligible) {
    const norm = normalize(candidate.text);
    for (const mutation of targetMutations) {
      if (norm.includes(mutation)) mutationCounts.set(mutation, (mutationCounts.get(mutation) ?? 0) + 1);
    }
    const phrases = shingles(candidate.text, 6);
    candidatePhrases.set(candidate.id, phrases);
    for (const phrase of phrases) {
      if (targetPhrases.has(phrase)) phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }

  const scored: CandidateScore[] = pool.map((candidate) => {
    const candidateTime = Date.parse(candidate.timestamp);
    if (!(candidateTime <= targetTime)) {
      return {
        candidate_id: candidate.id,
        eligible: false,
        confidence: 0,
        basis: `excluded: published after ${target.id}, so it cannot be its parent`,
        signals: { explicit_link: false, shared_mutations: [], rare_shared_phrases: 0, similarity: 0, same_timestamp: false },
      };
    }

    const norm = normalize(candidate.text);
    const shared = targetMutations.filter((mutation) => norm.includes(mutation));
    const phrases = candidatePhrases.get(candidate.id) ?? new Set<string>();
    const rarePhrases =
      eligible.length >= MIN_POOL_FOR_RARITY
        ? [...phrases].filter((phrase) => targetPhrases.has(phrase) && phraseCounts.get(phrase) === 1)
        : [];
    const signals: CandidateSignals = {
      explicit_link: linksTo(target, candidate),
      shared_mutations: shared,
      rare_shared_phrases: rarePhrases.length,
      similarity: round(jaccard(targetTrigrams, shingles(candidate.text, 3))),
      same_timestamp: candidateTime === targetTime,
    };

    const mutationWeight = Math.min(
      CAP_MUTATIONS,
      noisyOr(shared.map((mutation) => WEIGHT_MUTATION / (mutationCounts.get(mutation) ?? 1))),
    );
    const weights = [
      signals.explicit_link ? WEIGHT_LINK : 0,
      mutationWeight,
      Math.min(CAP_PHRASES, WEIGHT_PHRASE * rarePhrases.length),
      Math.min(CAP_SIMILARITY, signals.similarity * 0.3),
    ];
    let confidence = noisyOr(weights);
    const strong = signals.explicit_link || shared.length > 0;
    if (!strong) confidence = Math.min(confidence, rarePhrases.length > 0 ? CAP_PHRASING_ONLY : CAP_WEAK);
    if (signals.same_timestamp) confidence = Math.min(confidence, CAP_SAME_TIME);

    const reasons: string[] = [];
    if (signals.explicit_link) reasons.push(`${target.id} links to ${candidate.url}`);
    for (const mutation of shared) {
      const count = mutationCounts.get(mutation) ?? 1;
      reasons.push(
        `shares the known error "${mutation}"${count > 1 ? ` (also in ${count - 1} other earlier candidate${count > 2 ? "s" : ""})` : " (no other earlier candidate has it)"}`,
      );
    }
    if (rarePhrases.length) reasons.push(`${rarePhrases.length} copied 6-word phrase(s) found in no other candidate`);
    reasons.push(`word overlap ${signals.similarity}`);
    if (!strong) {
      reasons.push(
        rarePhrases.length > 0
          ? "copied phrasing but no link or known error; not enough to claim propagation"
          : "only textual similarity; not enough to claim propagation",
      );
    }
    if (signals.same_timestamp) reasons.push("same timestamp, so ordering is uncertain");

    return {
      candidate_id: candidate.id,
      eligible: true,
      confidence: round(confidence),
      basis: reasons.join("; "),
      signals,
    };
  });

  // Highest confidence first; among ties prefer the most recent earlier document.
  const time = new Map(pool.map((candidate) => [candidate.id, Date.parse(candidate.timestamp)]));
  scored.sort(
    (a, b) => b.confidence - a.confidence || (time.get(b.candidate_id) ?? 0) - (time.get(a.candidate_id) ?? 0),
  );

  const [best, runnerUp] = scored.filter((score) => score.eligible);
  if (!best || best.confidence < MIN_PARENT_CONFIDENCE) {
    return {
      parent_id: null,
      confidence: best ? best.confidence : 0,
      type: "similarity",
      basis: best ? `no candidate has enough evidence (best: ${best.candidate_id}, ${best.basis})` : "no earlier candidates",
      candidates: scored,
    };
  }

  let confidence = best.confidence;
  let basis = best.basis;
  if (runnerUp && best.confidence - runnerUp.confidence <= AMBIGUITY_MARGIN) {
    confidence = round(confidence * AMBIGUITY_FACTOR);
    basis += `; ambiguous with ${runnerUp.candidate_id} (${runnerUp.confidence})`;
  }
  const propagation = (best.signals.explicit_link || best.signals.shared_mutations.length > 0) && confidence >= 0.5;
  return {
    parent_id: best.candidate_id,
    confidence,
    type: propagation ? "propagation" : "similarity",
    basis,
    candidates: scored,
  };
}

export function toEdge(result: ProvenanceResult): Edge | null {
  if (!result.parent_id) return null;
  return {
    parent_id: result.parent_id,
    type: result.type,
    confidence: result.confidence,
    basis: result.basis,
  };
}
