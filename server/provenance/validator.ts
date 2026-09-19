import type { ProvenanceProposal } from "../gptzero/proposal";
import {
  computeTimings,
  MIN_COVERAGE,
  ordering,
  round,
  temporalEvidence,
  unquoted,
  type Ordering,
} from "../research/edges";
import { canonicalUrl, type CandidateDocument } from "../research/extract";
import type { UpstreamProposal } from "../research/traversal";
import { jaccard, matchKey, shingles } from "../research/text";
import {
  ProvenanceEdgeValidation,
  type ProposalContext,
  type ProvenanceRelationship,
  type ValidationEvidence,
  type ValidationSignal,
  type ValidationSignalId,
} from "../../shared/provenance-validation";

/** Only this validator decides whether document evidence supports an edge. */
export const ACCEPT_THRESHOLD = 0.35;

/**
 * Independent validation of one candidate upstream relationship.
 *
 * A proposer points at a pair of documents. This module decides, on its own, whether that pair
 * is actually a provenance edge. The scoring core {@link validateProvenanceEdge} takes documents
 * and nothing else: it has no parameter through which a proposer's judgement could reach it, so
 * "GPTZero's confidence did not contribute" is a property of the call signature rather than a
 * promise. {@link validateProposedEdge} unwraps a proposal into that call, keeping the proposer's
 * probability in the audit record only.
 *
 * Three signals are preconditions — distinct_artifact, chronology and canonical_metadata. They
 * can rule an edge out but never argue one into existence, so nothing a proposer supplies (which
 * pair to look at, which URL it named, which passage it flagged) can raise the score. The flagged
 * passage only chooses which text `passage_overlap` measures, and only once found verbatim in the
 * child; that signal is capped far below what an edge needs to be accepted.
 *
 * Every signal is something a reader can re-check by opening the two documents:
 *
 *   distinct_artifact   they are not the same text under two URLs
 *   chronology          the child can have been written after the parent (a precondition)
 *   explicit_link       the child links to the parent
 *   citation_reference  the child names the parent in prose
 *   canonical_metadata  the named reference resolves to this exact artifact (a precondition)
 *   shared_fabrications both repeat the same invented citations, misspellings or entities
 *   shared_phrasing     word sequences shared with the parent and with no other candidate
 *   passage_overlap     the flagged passage itself occurs in the parent
 */

/** Weights are corroborating strength, combined with noisy-OR. Preconditions weigh nothing. */
const WEIGHT_LINK = 0.6;
const WEIGHT_CITATION = 0.45;
const WEIGHT_FABRICATION_SET = 0.35;
const WEIGHT_VARIANT = 0.15;
const WEIGHT_ENTITY = 0.2;
const CAP_FABRICATIONS = 0.7;
const WEIGHT_PHRASE = 0.05;
const CAP_PHRASES = 0.3;
const WEIGHT_PASSAGE = 0.25;
const CAP_PASSAGE = 0.2;

/** Without a link, a citation or a shared fabrication, nothing above this can be claimed. */
const CAP_WEAK = 0.25;
/** Nothing orders the two documents. */
const CAP_UNKNOWN_ORDER = 0.3;
/** They share a timestamp: either could have copied the other, or both an unseen third. */
const CAP_SAME_TIME = 0.6;

/** Shingle sizes: long enough that a shared sequence is a choice, not a coincidence. */
const PHRASE_SIZE = 6;
const PASSAGE_SIZE = 5;
const SIMILARITY_SIZE = 3;
/** The passage must reach this share of its word sequences inside the parent to count. */
const MIN_PASSAGE_OVERLAP = 0.5;
/** Distinctive phrases are listed in full up to here; the count always reports all of them. */
const MAX_LISTED_PHRASES = 5;

export interface ValidateEdgeInput {
  /** The candidate upstream document. */
  parent: CandidateDocument;
  /** The document carrying the claim. */
  child: CandidateDocument;
  /**
   * Other discovered documents. They decide how rare a shared phrase or fabrication is, and
   * they bound dates through links. Parent and child are added automatically.
   */
  corpus?: CandidateDocument[];
  /** Invented details beyond case citations: fake authors, docket numbers, quotations. */
  knownFabrications?: string[];
  /**
   * A passage to compare instead of the child's extracted one. Treated as a locator: it is used
   * only after being found verbatim in the child, and whoever supplied it earns no credit for it.
   */
  focusSpan?: string | null;
  /** The URL the upstream reference named, checked against the parent's canonical identity. */
  referenceUrl?: string | null;
  now?: () => Date;
}

export interface ValidateProposedEdgeInput extends Omit<ValidateEdgeInput, "focusSpan" | "referenceUrl"> {
  /** Used to locate the pair and to fill the audit record. Never scored. */
  proposal: ProvenanceProposal | UpstreamProposal;
}

interface SignalDraft {
  id: ValidationSignalId;
  status: ValidationSignal["status"];
  weight: number;
  disqualifying?: boolean;
  detail: string;
  evidence?: string[];
}

function noisyOr(weights: number[]): number {
  return 1 - weights.reduce((product, weight) => product * (1 - weight), 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** URL identity as the graph sees it, plus a scheme-free form for finding URLs written in prose. */
function urlForms(url: string): { canonical: string; bare: string } {
  const canonical = canonicalUrl(url);
  return { canonical, bare: canonical.replace(/^https?:\/\//, "").toLowerCase() };
}

function documentEvidence(document: CandidateDocument): ValidationEvidence["parent"] {
  return {
    id: document.id,
    url: document.url,
    canonical_id: document.canonical_id,
    mirror_urls: document.mirror_urls,
    publisher: document.publisher,
    title: document.title,
    timestamp: document.timestamp,
    timestamp_source: document.timestamp_source,
    timestamp_confidence: document.timestamp_confidence,
    timestamp_conflict: document.timestamp_conflict,
    passage: document.passage,
  };
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "an unknown date";
}

/** Parent and child are not the same text served twice. */
function distinctArtifact(parent: CandidateDocument, child: CandidateDocument): SignalDraft {
  if (parent.content_fingerprint === child.content_fingerprint) {
    return {
      id: "distinct_artifact",
      status: "failed",
      weight: 0,
      disqualifying: true,
      detail: `${parent.id} and ${child.id} are the same artifact (${parent.canonical_id}); one cannot be the source of the other`,
      evidence: [parent.canonical_id],
    };
  }
  return {
    id: "distinct_artifact",
    status: "passed",
    weight: 0,
    detail: `separate artifacts (${parent.canonical_id.slice(0, 15)}… and ${child.canonical_id.slice(0, 15)}…)`,
  };
}

/** Ordering is a precondition: it can rule an edge out, but it never argues one into existence. */
function chronology(parent: CandidateDocument, child: CandidateDocument, order: Ordering, conflict: string | null): SignalDraft {
  const parentDay = day(parent.timestamp);
  const childDay = day(child.timestamp);
  if (order === "impossible") {
    return {
      id: "chronology",
      status: "failed",
      weight: 0,
      disqualifying: true,
      detail: parent.outbound_links.includes(child.url)
        ? `${parent.id} links to ${child.id}, so it was written after it`
        : `${parent.id} (${parentDay}) is not earlier than ${child.id} (${childDay})`,
      evidence: [`${parent.id}: ${parentDay}`, `${child.id}: ${childDay}`],
    };
  }
  if (order === "strict" || order === "from-link") {
    return {
      id: "chronology",
      status: "passed",
      weight: 0,
      detail:
        order === "strict"
          ? `${parent.id} (${parentDay}) precedes ${child.id} (${childDay})`
          : child.outbound_links.includes(parent.url)
            ? `${child.id} links to ${parent.id}, so it was written after it`
            : `${child.id} links to material at least as recent as ${parent.id}, so it follows it`,
      evidence: [`${parent.id}: ${parentDay}`, `${child.id}: ${childDay}`],
    };
  }
  return {
    id: "chronology",
    status: "not-applicable",
    weight: 0,
    detail:
      order === "same-time"
        ? `both claim ${parentDay}; the dates cannot order them`
        : conflict
          ? `order unknown: ${parent.id} ${conflict}`
          : "order unknown: neither document has a trustworthy timestamp",
    evidence: [`${parent.id}: ${parentDay}`, `${child.id}: ${childDay}`],
  };
}

/** Links in the child pointing at the parent's URL, one of its mirrors, or its URL in prose. */
function explicitLink(parent: CandidateDocument, child: CandidateDocument): { draft: SignalDraft; matched: string[] } {
  const parentUrls = [parent.url, ...parent.mirror_urls].map(urlForms);
  const childText = child.text.toLowerCase();
  const matched: string[] = [];
  for (const link of child.outbound_links) {
    const form = urlForms(link);
    if (parentUrls.some((parentUrl) => parentUrl.canonical === form.canonical)) matched.push(form.canonical);
  }
  for (const parentUrl of parentUrls) {
    if (!matched.includes(parentUrl.canonical) && childText.includes(parentUrl.bare)) matched.push(parentUrl.canonical);
  }
  const found = unique(matched);
  if (found.length === 0) {
    return {
      draft: {
        id: "explicit_link",
        status: "failed",
        weight: 0,
        detail: `${child.id} does not link to ${parent.url}`,
      },
      matched: [],
    };
  }
  const mirrored = found.some((link) => link !== urlForms(parent.url).canonical);
  return {
    draft: {
      id: "explicit_link",
      status: "passed",
      weight: WEIGHT_LINK,
      detail: mirrored ? `${child.id} links to ${parent.id} through a mirror URL` : `${child.id} links to ${parent.id}`,
      evidence: found,
    },
    matched: found,
  };
}

/**
 * The child names the parent without linking to it. A title is only a reference if it is long
 * enough to identify a document; "Update" appearing in two pages says nothing.
 */
function citationReference(parent: CandidateDocument, child: CandidateDocument): { draft: SignalDraft; matched: string[] } {
  const childKey = matchKey(child.text);
  const matched: string[] = [];
  const title = parent.title.trim();
  if (title.length >= 12 && matchKey(title).split(" ").length >= 3 && childKey.includes(matchKey(title))) {
    matched.push(title);
  }
  const publisher = parent.publisher.trim();
  const publisherNamed = publisher.length >= 4 && childKey.includes(matchKey(publisher));
  if (matched.length === 0) {
    return {
      draft: {
        id: "citation_reference",
        status: "failed",
        weight: 0,
        detail: publisherNamed
          ? `${child.id} mentions ${publisher} but never names the document "${title}"`
          : `${child.id} does not name ${parent.id} in its text`,
      },
      matched: [],
    };
  }
  return {
    draft: {
      id: "citation_reference",
      status: "passed",
      weight: WEIGHT_CITATION,
      detail: `${child.id} names "${title}"${publisherNamed ? ` and credits ${publisher}` : ""}`,
      evidence: publisherNamed ? [...matched, publisher] : matched,
    },
    matched,
  };
}

/**
 * Does the URL the reference named actually resolve to the artifact being validated?
 *
 * This is a precondition and carries no weight, deliberately. When the reference URL came from
 * the proposer, resolving it says only that the right document was fetched — crediting it would
 * let a proposer raise the score by naming a URL. What it can do is rule the pair out: a URL that
 * resolves elsewhere means a different document was validated than the one referenced. The
 * parent's own metadata is reported here so a reader can see how firm the identity is; unreliable
 * dates already weaken the edge through `chronology`.
 */
function canonicalMetadata(parent: CandidateDocument, referenceUrl: string | null): SignalDraft {
  if (!referenceUrl) {
    return {
      id: "canonical_metadata",
      status: "not-applicable",
      weight: 0,
      detail: "the upstream reference named no URL, so canonical identity was not checked against one",
    };
  }
  const wanted = urlForms(referenceUrl).canonical;
  const known = [parent.url, ...parent.mirror_urls].map((url) => urlForms(url).canonical);
  if (!known.includes(wanted)) {
    return {
      id: "canonical_metadata",
      status: "failed",
      weight: 0,
      disqualifying: true,
      detail: `the proposed upstream URL ${wanted} does not resolve to ${parent.id} (${parent.url}); a different document was validated than the one referenced`,
      evidence: [wanted, parent.url, ...parent.mirror_urls],
    };
  }
  const trusted = parent.timestamp_confidence !== "none" && !parent.timestamp_conflict;
  const mirror = wanted !== urlForms(parent.url).canonical;
  return {
    id: "canonical_metadata",
    status: "passed",
    weight: 0,
    detail: `${wanted} resolves to ${parent.canonical_id}${mirror ? " through a recorded mirror" : ""}; publication date from ${parent.timestamp_source} (${parent.timestamp_confidence})${
      trusted ? "" : parent.timestamp_conflict ? `, but ${parent.timestamp_conflict}` : ", which is not trustworthy on its own"
    }`,
    evidence: [wanted, parent.canonical_id],
  };
}

/**
 * Invented material both documents repeat: fabricated citations, the same misspelling of one, and
 * any other known hallucinated entity. Shared fabrications place two documents in one lineage, but
 * they only single out a parent when few other candidates carry the same set.
 */
function sharedFabrications(
  parent: CandidateDocument,
  child: CandidateDocument,
  pool: CandidateDocument[],
  knownFabrications: string[],
): { draft: SignalDraft; shared: string[] } {
  const childCitations = new Set(child.fabricated_citations.map(matchKey));
  const citations = parent.fabricated_citations.filter((citation) => childCitations.has(matchKey(citation)));
  const childVariants = new Set(child.citation_variants.map(matchKey));
  const variants = parent.citation_variants.filter((variant) => childVariants.has(matchKey(variant)));
  const parentText = matchKey(parent.text);
  const childText = matchKey(child.text);
  const entities = knownFabrications.filter((entity) => {
    const key = matchKey(entity);
    return key.length > 0 && parentText.includes(key) && childText.includes(key);
  });

  const coverage = childCitations.size ? citations.length / childCitations.size : 0;
  // How many other candidates carry the same fabricated set? Each one weakens this parent's claim.
  const carriers = pool.filter((other) => {
    if (other.id === child.id || childCitations.size === 0) return false;
    const set = new Set(other.fabricated_citations.map(matchKey));
    return [...childCitations].filter((citation) => set.has(citation)).length / childCitations.size >= MIN_COVERAGE;
  }).length;

  const shared = unique([...citations, ...variants, ...entities]);
  if (shared.length === 0) {
    return {
      draft: {
        id: "shared_fabrications",
        status: "failed",
        weight: 0,
        detail: childCitations.size
          ? `${parent.id} repeats none of the ${childCitations.size} fabricated citation(s) in ${child.id}`
          : "no fabricated citation or invented entity is known for this pair",
      },
      shared: [],
    };
  }

  const weight = Math.min(
    CAP_FABRICATIONS,
    noisyOr([
      coverage >= MIN_COVERAGE ? WEIGHT_FABRICATION_SET / Math.sqrt(Math.max(1, carriers)) : 0.1 * coverage,
      Math.min(0.3, WEIGHT_VARIANT * variants.length),
      Math.min(0.3, (WEIGHT_ENTITY * entities.length) / Math.sqrt(Math.max(1, carriers))),
    ]),
  );
  const parts: string[] = [];
  if (citations.length) {
    parts.push(
      `${citations.length} of ${childCitations.size} fabricated citation(s)${
        carriers > 1 && coverage >= MIN_COVERAGE ? `, which ${carriers - 1} other candidate(s) also carry` : ""
      }`,
    );
  }
  if (variants.length) parts.push(`the same misspelling ${variants.map((variant) => `"${variant}"`).join(", ")}`);
  if (entities.length) parts.push(`the invented detail(s) ${entities.map((entity) => `"${entity}"`).join(", ")}`);
  return {
    draft: {
      id: "shared_fabrications",
      status: "passed",
      weight: round(weight),
      detail: `both documents repeat ${parts.join("; ")}`,
      evidence: shared,
    },
    shared,
  };
}

/**
 * Word sequences the child shares with this parent and with no other candidate, quotations
 * removed: two documents quoting the same press release did not copy each other.
 */
function sharedPhrasing(
  parent: CandidateDocument,
  child: CandidateDocument,
  pool: CandidateDocument[],
): { draft: SignalDraft; phrases: string[] } {
  const childPhrases = shingles(unquoted(child.text), PHRASE_SIZE);
  const parentPhrases = shingles(unquoted(parent.text), PHRASE_SIZE);
  const others = pool
    .filter((other) => other.id !== parent.id && other.id !== child.id)
    .map((other) => shingles(unquoted(other.text), PHRASE_SIZE));
  const phrases = [...parentPhrases]
    .filter((phrase) => childPhrases.has(phrase) && others.every((set) => !set.has(phrase)))
    .sort();
  if (phrases.length === 0) {
    const anyShared = [...parentPhrases].some((phrase) => childPhrases.has(phrase));
    return {
      draft: {
        id: "shared_phrasing",
        status: "failed",
        weight: 0,
        detail: anyShared
          ? `every ${PHRASE_SIZE}-word sequence shared with ${parent.id} also appears in another candidate, so it does not point here`
          : `no ${PHRASE_SIZE}-word sequence outside quotations is shared with ${parent.id}`,
      },
      phrases: [],
    };
  }
  return {
    draft: {
      id: "shared_phrasing",
      status: "passed",
      weight: Math.min(CAP_PHRASES, WEIGHT_PHRASE * phrases.length),
      detail: `${phrases.length} ${PHRASE_SIZE}-word sequence(s) outside quotations appear in ${parent.id} and in no other candidate`,
      evidence: phrases.slice(0, MAX_LISTED_PHRASES),
    },
    phrases,
  };
}

/** How much of the passage under examination is present in the parent. */
function passageOverlap(parent: CandidateDocument, passage: string): { draft: SignalDraft; overlap: number } {
  const passagePhrases = shingles(passage, PASSAGE_SIZE);
  if (passagePhrases.size === 0) {
    return {
      draft: {
        id: "passage_overlap",
        status: "not-applicable",
        weight: 0,
        detail: `the passage is shorter than ${PASSAGE_SIZE} words, so overlap cannot be measured`,
      },
      overlap: 0,
    };
  }
  const parentPhrases = shingles(parent.text, PASSAGE_SIZE);
  let shared = 0;
  for (const phrase of passagePhrases) if (parentPhrases.has(phrase)) shared += 1;
  const overlap = round(shared / passagePhrases.size);
  if (overlap < MIN_PASSAGE_OVERLAP) {
    return {
      draft: {
        id: "passage_overlap",
        status: "failed",
        weight: 0,
        detail: `${Math.round(overlap * 100)}% of the passage occurs in ${parent.id}, below the ${Math.round(MIN_PASSAGE_OVERLAP * 100)}% needed to call it the same text`,
      },
      overlap,
    };
  }
  return {
    draft: {
      id: "passage_overlap",
      status: "passed",
      weight: Math.min(CAP_PASSAGE, WEIGHT_PASSAGE * overlap),
      detail: `${Math.round(overlap * 100)}% of the passage's ${PASSAGE_SIZE}-word sequences occur in ${parent.id}`,
      evidence: [passage],
    },
    overlap,
  };
}

function toSignal(draft: SignalDraft): ValidationSignal {
  return {
    id: draft.id,
    status: draft.status,
    weight: draft.status === "passed" ? round(draft.weight) : 0,
    disqualifying: draft.disqualifying ?? false,
    detail: draft.detail,
    evidence: draft.evidence ?? [],
  };
}

/**
 * Validate a candidate parent -> child relationship from the documents alone.
 *
 * There is deliberately no parameter here for a proposer's opinion: the only inputs are two
 * documents, the pool they were discovered in, and known fabrications. A caller cannot make this
 * function more confident by being more confident itself.
 */
export function validateProvenanceEdge(input: ValidateEdgeInput): ProvenanceEdgeValidation {
  const { parent, child } = input;
  if (parent.id === child.id) throw new Error(`cannot validate ${parent.id} as its own parent`);
  const now = input.now ?? (() => new Date());

  const pool = [...new Map([...(input.corpus ?? []), parent, child].map((doc) => [doc.id, doc])).values()];
  const timings = computeTimings(pool);
  const order = ordering(parent, child, timings);
  const parentTiming = timings.get(parent.id)!;
  const childTiming = timings.get(child.id)!;

  // The proposed span is a locator, not testimony: it is used only once found in the child itself.
  const span = input.focusSpan?.trim() || null;
  const spanVerified = span !== null && matchKey(child.text).includes(matchKey(span));
  const validatedPassage = spanVerified ? span! : child.passage;
  const passageSource: ValidationEvidence["passage_source"] = spanVerified ? "proposed-span" : "extracted-passage";

  const artifact = distinctArtifact(parent, child);
  const chronologySignal = chronology(parent, child, order, parentTiming.conflict);
  const link = explicitLink(parent, child);
  const citation = citationReference(parent, child);
  const canonical = canonicalMetadata(parent, input.referenceUrl ?? null);
  const fabrications = sharedFabrications(parent, child, pool, input.knownFabrications ?? []);
  const phrasing = sharedPhrasing(parent, child, pool);
  const passage = passageOverlap(parent, validatedPassage);

  const drafts = [artifact, chronologySignal, link.draft, citation.draft, canonical, fabrications.draft, phrasing.draft, passage.draft];
  const signals = drafts.map(toSignal);
  const passed = signals.filter((signal) => signal.status === "passed").map((signal) => signal.id);
  const failed = signals.filter((signal) => signal.status === "failed").map((signal) => signal.id);
  const disqualified = signals.filter((signal) => signal.status === "failed" && signal.disqualifying);

  const similarity = round(jaccard(shingles(child.text, SIMILARITY_SIZE), shingles(parent.text, SIMILARITY_SIZE)));
  const reasons: string[] = [];
  let confidence = 0;
  let relationship: ProvenanceRelationship;

  if (disqualified.length > 0) {
    relationship = "contradicted";
    reasons.push(...disqualified.map((signal) => signal.detail));
    reasons.push("no amount of shared text can establish an edge the evidence rules out");
    // Corroborating weights are reported per signal but never aggregated for a ruled-out edge.
    for (const signal of signals) if (!signal.disqualifying) signal.weight = 0;
  } else {
    confidence = noisyOr(signals.map((signal) => (signal.status === "passed" ? signal.weight : 0)));

    // A link, a named reference or repeated invented material is what separates propagation from
    // resemblance. Copied phrasing and overlap can choose between parents but cannot claim one.
    const strong = link.draft.status === "passed" || citation.draft.status === "passed" || fabrications.draft.status === "passed";
    const directionKnown = order === "strict" || order === "from-link" || link.draft.status === "passed";

    for (const signal of signals) if (signal.status === "passed" && signal.weight > 0) reasons.push(signal.detail);

    if (!strong) {
      confidence = Math.min(confidence, CAP_WEAK);
      reasons.push(
        phrasing.phrases.length > 0 || passage.overlap >= MIN_PASSAGE_OVERLAP
          ? "shared wording without a link, a named reference or a shared fabrication is not enough to claim propagation"
          : "only textual resemblance; nothing ties these two documents together",
      );
    }
    if (order === "unknown") {
      confidence = Math.min(confidence, CAP_UNKNOWN_ORDER);
      reasons.push(chronologySignal.detail);
    }
    if (order === "same-time") {
      confidence = Math.min(confidence, CAP_SAME_TIME);
      reasons.push(`${chronologySignal.detail}; either could have copied the other, or both an unseen third document`);
    }

    // distinct_artifact, chronology and canonical_metadata are preconditions: passing them
    // means the edge is possible, not that anything corroborates it.
    if (signals.every((signal) => signal.status !== "passed" || signal.weight === 0)) {
      relationship = "unsupported";
      confidence = 0;
      reasons.push(`no signal corroborates ${parent.id} as a source for ${child.id}`);
    } else if (strong && directionKnown && confidence >= ACCEPT_THRESHOLD) {
      relationship = "propagation";
    } else if (strong && !directionKnown) {
      relationship = "shared-source";
      reasons.push("the shared material is real, but nothing establishes which document came first");
    } else {
      relationship = "similarity";
    }
  }

  confidence = round(confidence);
  reasons.push(`whole-document word overlap ${similarity}`);
  if (span !== null && !spanVerified) {
    reasons.push("the proposed passage was not found in the child document; its own extracted passage was compared instead");
  }

  const accepted = relationship === "propagation" && confidence >= ACCEPT_THRESHOLD;
  const temporal = temporalEvidence(parentTiming, childTiming, order);
  const evidence: ValidationEvidence = {
    parent: documentEvidence(parent),
    child: documentEvidence(child),
    temporal,
    matched_links: link.matched,
    matched_citations: citation.matched,
    shared_fabrications: fabrications.shared,
    shared_phrases: phrasing.phrases.slice(0, MAX_LISTED_PHRASES),
    rare_shared_phrases: phrasing.phrases.length,
    passage_overlap: passage.overlap,
    similarity,
    validated_passage: validatedPassage,
    passage_source: passageSource,
    span_verified: spanVerified,
  };

  return ProvenanceEdgeValidation.parse({
    validator: "lineage-deterministic-v1",
    parent_id: parent.id,
    child_id: child.id,
    relationship,
    confidence,
    accepted,
    signals,
    passed,
    failed,
    reasons,
    evidence,
    graph_edge: accepted
      ? {
          parent_id: parent.id,
          child_id: child.id,
          type: "propagation",
          confidence,
          basis: reasons.join("; "),
          shared_mutations: fabrications.shared,
          // Reconstruction owns mutation analysis, after graph structure is checked.
          claim_mutations: [],
          explicit_link: link.draft.status === "passed",
          rare_shared_phrases: phrasing.phrases.length,
          similarity,
          temporal,
          alternatives: [],
        }
      : null,
    proposal: null,
    validated_at: now().toISOString(),
  });
}

/**
 * Validate the relationship a GPTZero proposal points at.
 *
 * The proposal contributes exactly two things, both inert: which pair to look at, and a passage to
 * look at first (used only after it is found verbatim in the child). Its probability, label and
 * raw provider output are copied into the audit record and are never read by the scorer.
 */
export function validateProposedEdge(input: ValidateProposedEdgeInput): ProvenanceEdgeValidation {
  const { proposal, ...rest } = input;
  const context = "proposed_upstream" in proposal ? proposal : null;
  const upstream = "proposed_upstream" in proposal ? proposal.proposed_upstream : proposal;
  const childUrls = [input.child.url, ...input.child.mirror_urls].map((url) => urlForms(url).canonical);
  if (context?.source_url && !childUrls.includes(urlForms(context.source_url).canonical)) {
    throw new Error(
      `proposal is about ${context.source_url}, which is not the supplied child document ${input.child.url}`,
    );
  }
  const result = validateProvenanceEdge({
    ...rest,
    focusSpan: context?.evidence_span ?? context?.suspicious_claim,
    referenceUrl: upstream.url,
  });
  const audit: ProposalContext | null = context ? {
    proposer: "gptzero",
    suspicious_claim: context.suspicious_claim,
    proposed_upstream: { url: upstream.url ?? null, citation: upstream.citation ?? null },
    proposer_confidence: context.confidence,
    influence: "none",
  } : null;
  return ProvenanceEdgeValidation.parse({ ...result, proposal: audit });
}
