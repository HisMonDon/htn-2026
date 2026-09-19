import { z } from "zod";
import type { AiEvidence } from "../../shared/schema";
import { extractCaseNames } from "../research/text";
import type { GptZeroDocument } from "./client";

const confidence = z.number().min(0).max(1);
const timestamp = z.iso.datetime({ offset: true });

/**
 * One suspicious span GPTZero flagged, reshaped into a candidate lineage edge: "this claim in
 * `source_url` may descend from an upstream source." GPTZero never identifies that upstream source
 * itself (it has no notion of citations or documents, only text statistics), so `proposed_upstream`
 * is a deterministic best-effort guess from the flagged text, not a claim from the provider. This is
 * a proposal, not an edge: nothing here is written to a case's chain, and confidence is never
 * compared against the deterministic scorer in `research/edges.ts`.
 */
export const ProvenanceProposal = z.object({
  proposer: z.literal("gptzero"),
  source_url: z.url().nullable(),
  suspicious_claim: z.string().min(1),
  evidence_span: z.string().nullable(),
  proposed_upstream: z.object({
    /** Populated only if a later, separate lookup resolves the citation to a document. GPTZero never supplies this. */
    url: z.url().nullable(),
    /** A citation-shaped string pulled from the flagged span (e.g. a case name), or null if none was found. */
    citation: z.string().nullable(),
  }),
  confidence,
  metadata: z.object({
    label: z.enum(["human", "mixed", "ai"]),
    document_ai_probability: confidence,
    /** The flagged sentence's own generated_prob, when GPTZero reported one; null falls back to the document-level probability. */
    sentence_ai_probability: confidence.nullable(),
    checked_at: timestamp,
  }),
  /** The raw (validated, unmapped) GPTZero document this proposal was derived from, kept for debugging. */
  raw_evidence: z.unknown(),
});
export type ProvenanceProposal = z.infer<typeof ProvenanceProposal>;

export interface ProposalInput {
  /** The document GPTZero analyzed, or null if unknown (e.g. raw pasted text). */
  sourceUrl: string | null;
  evidence: AiEvidence;
  /** The raw provider document backing `evidence`, from {@link GptZeroClient.detectWithRaw}. */
  raw: GptZeroDocument;
}

/**
 * Map one GPTZero result into zero or more provenance proposals, one per flagged passage. GPTZero
 * is a proposer only: callers must not create accepted edges from this output, and it must never
 * feed the deterministic scorer in `research/edges.ts`. This is a single hop — it does not resolve
 * `proposed_upstream` beyond what is directly extractable from the flagged text, and it does not
 * recurse into whatever it proposes.
 */
export function proposeProvenance(input: ProposalInput): ProvenanceProposal[] {
  const sentenceProbabilities = new Map(
    (input.raw.sentences ?? [])
      .filter((sentence): sentence is typeof sentence & { sentence: string } => typeof sentence.sentence === "string")
      .map((sentence) => [sentence.sentence, sentence.generated_prob ?? null] as const),
  );

  return input.evidence.flagged_passages.map((passage) => {
    const sentenceProbability = sentenceProbabilities.get(passage) ?? null;
    const [citation] = extractCaseNames(passage);
    return ProvenanceProposal.parse({
      proposer: "gptzero",
      source_url: input.sourceUrl,
      suspicious_claim: passage,
      evidence_span: passage,
      proposed_upstream: { url: null, citation: citation ?? null },
      confidence: sentenceProbability ?? input.evidence.ai_probability,
      metadata: {
        label: input.evidence.label,
        document_ai_probability: input.evidence.ai_probability,
        sentence_ai_probability: sentenceProbability,
        checked_at: input.evidence.checked_at,
      },
      raw_evidence: input.raw,
    });
  });
}
