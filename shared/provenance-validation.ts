import { z } from "zod";
import { TemporalEvidence, TreeEdge } from "./tree";

/**
 * Contract for one independently validated provenance edge.
 *
 * A proposer (today: GPTZero) may say "this claim looks like it came from somewhere upstream".
 * That is a pointer to a pair of documents, nothing more. Everything in this result is derived
 * from evidence a human can re-check by opening the two documents: links, citations, dates,
 * shared fabrications, distinctive phrasing, canonical identity and passage overlap. The
 * proposer's own probability is recorded under `proposal` for audit and is excluded from
 * `confidence` by construction (see `server/provenance/validator.ts`).
 */

const confidence = z.number().min(0).max(1);

/** The deterministic signals the validator inspects. Each is independently checkable. */
export const ValidationSignalId = z.enum([
  /** Parent and child are not the same artifact. */
  "distinct_artifact",
  /** The child could have been written after the parent. A precondition, never corroboration. */
  "chronology",
  /** The child links to the parent's URL. */
  "explicit_link",
  /** The child names the parent in prose (title/publisher) without linking to it. */
  "citation_reference",
  /** The reference resolves, through canonicalization and mirrors, to this exact artifact. */
  "canonical_metadata",
  /** Both documents repeat the same fabricated citations, spelling variants or invented entities. */
  "shared_fabrications",
  /** Word sequences shared with the parent and with no other candidate, outside quotations. */
  "shared_phrasing",
  /** The flagged passage itself appears in the parent. */
  "passage_overlap",
]);
export type ValidationSignalId = z.infer<typeof ValidationSignalId>;

export const SignalStatus = z.enum(["passed", "failed", "not-applicable"]);

export const ValidationSignal = z.object({
  id: ValidationSignalId,
  status: SignalStatus,
  /** Corroborating strength this signal contributed. Zero for preconditions and for non-passes. */
  weight: confidence,
  /** A failure here rules the relationship out no matter what else was found. */
  disqualifying: z.boolean(),
  /** Why the signal landed where it did, in terms a reader can verify. */
  detail: z.string().min(1),
  /** The exact matched strings — URLs, citations, phrases — behind `status`. */
  evidence: z.array(z.string()),
});
export type ValidationSignal = z.infer<typeof ValidationSignal>;

/**
 * What the evidence supports, which is not the same as what was proposed.
 *
 * `propagation`   the child derives from the parent and the direction is established
 * `shared-source` strong shared material, but nothing orders the two documents
 * `similarity`    they resemble each other; no evidence of copying
 * `unsupported`   no deterministic signal corroborates the relationship
 * `contradicted`  the evidence rules the relationship out
 */
export const ProvenanceRelationship = z.enum([
  "propagation",
  "shared-source",
  "similarity",
  "unsupported",
  "contradicted",
]);
export type ProvenanceRelationship = z.infer<typeof ProvenanceRelationship>;

const DocumentEvidence = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  canonical_id: z.string().min(1),
  mirror_urls: z.array(z.string()),
  publisher: z.string(),
  title: z.string(),
  timestamp: z.string().nullable(),
  timestamp_source: z.string(),
  timestamp_confidence: z.string(),
  timestamp_conflict: z.string().nullable(),
  passage: z.string(),
});

/** Everything GraphVisualizer needs to draw and explain this edge without re-deriving anything. */
export const ValidationEvidence = z.object({
  parent: DocumentEvidence,
  child: DocumentEvidence,
  temporal: TemporalEvidence,
  /** Links in the child that point at the parent or one of its mirrors. */
  matched_links: z.array(z.string()),
  /** Prose references in the child that name the parent. */
  matched_citations: z.array(z.string()),
  /** Fabricated citations, spelling variants and invented entities present in both. */
  shared_fabrications: z.array(z.string()),
  /** Word sequences found in both and in no other candidate. Truncated for display. */
  shared_phrases: z.array(z.string()),
  rare_shared_phrases: z.number().int().min(0),
  /** Share of the validated passage's word sequences that also occur in the parent. */
  passage_overlap: confidence,
  /** Whole-document word overlap. Weak on its own. */
  similarity: confidence,
  /** The passage that was compared, and whether it was found verbatim in the child. */
  validated_passage: z.string(),
  passage_source: z.enum(["proposed-span", "extracted-passage"]),
  span_verified: z.boolean(),
});
export type ValidationEvidence = z.infer<typeof ValidationEvidence>;

/**
 * The proposal that pointed at this pair, kept for audit only. `influence: "none"` is a
 * structural fact: the scoring core never receives this object.
 */
export const ProposalContext = z.object({
  proposer: z.literal("gptzero"),
  suspicious_claim: z.string(),
  proposed_upstream: z.object({ url: z.string().nullable(), citation: z.string().nullable() }),
  /** GPTZero's probability. Recorded, never scored. */
  proposer_confidence: confidence.nullable(),
  influence: z.literal("none"),
});
export type ProposalContext = z.infer<typeof ProposalContext>;

export const ProvenanceEdgeValidation = z
  .object({
    validator: z.literal("lineage-deterministic-v1"),
    parent_id: z.string().min(1),
    child_id: z.string().min(1),
    relationship: ProvenanceRelationship,
    confidence,
    /** True only for a `propagation` relationship at or above the acceptance threshold. */
    accepted: z.boolean(),
    signals: z.array(ValidationSignal).min(1),
    passed: z.array(ValidationSignalId),
    failed: z.array(ValidationSignalId),
    reasons: z.array(z.string().min(1)).min(1),
    evidence: ValidationEvidence,
    /** Semantic edge, ready for reconstruction to attach mutations. Null unless `accepted`. */
    graph_edge: TreeEdge.nullable(),
    /** Null when the pair was validated directly rather than from a proposal. */
    proposal: ProposalContext.nullable(),
    validated_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((result, ctx) => {
    if (result.accepted !== (result.graph_edge !== null)) {
      ctx.addIssue({ code: "custom", path: ["graph_edge"], message: "graph_edge is present exactly when accepted" });
    }
    if (result.accepted && result.relationship !== "propagation") {
      ctx.addIssue({ code: "custom", path: ["relationship"], message: "only a propagation edge can be accepted" });
    }
    if (result.parent_id === result.child_id) {
      ctx.addIssue({ code: "custom", path: ["parent_id"], message: "a document cannot be its own parent" });
    }
    const ids = new Set(result.signals.map((signal) => signal.id));
    if (ids.size !== result.signals.length) {
      ctx.addIssue({ code: "custom", path: ["signals"], message: "each signal appears at most once" });
    }
    for (const id of result.passed) {
      if (!result.signals.some((signal) => signal.id === id && signal.status === "passed")) {
        ctx.addIssue({ code: "custom", path: ["passed"], message: `"${id}" is not a passed signal` });
      }
    }
    for (const id of result.failed) {
      if (!result.signals.some((signal) => signal.id === id && signal.status === "failed")) {
        ctx.addIssue({ code: "custom", path: ["failed"], message: `"${id}" is not a failed signal` });
      }
    }
  });
export type ProvenanceEdgeValidation = z.infer<typeof ProvenanceEdgeValidation>;

export function parseProvenanceEdgeValidation(input: unknown): ProvenanceEdgeValidation {
  return ProvenanceEdgeValidation.parse(input);
}
