import { describe, expect, it } from "vitest";
import { GptZeroClient } from "./client";
import { proposeProvenance } from "./proposal";

const fixedNow = () => new Date("2026-09-19T12:00:00Z");

function fakeFetchWith(body: unknown) {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("proposeProvenance", () => {
  it("maps each flagged passage to a proposal, leaving upstream url unresolved", async () => {
    const fakeFetch = fakeFetchWith({
      documents: [
        {
          predicted_class: "ai",
          class_probabilities: { ai: 0.93, human: 0.05, mixed: 0.02 },
          sentences: [
            { sentence: "See United States v. Ortiz.", generated_prob: 0.97, highlight_sentence_for_ai: true },
            { sentence: "Plain sentence.", generated_prob: 0.1, highlight_sentence_for_ai: false },
          ],
        },
      ],
    });
    const client = new GptZeroClient("test-key", fakeFetch, fixedNow);
    const { evidence, raw } = await client.detectWithRaw("See United States v. Ortiz. Plain sentence.");

    const proposals = proposeProvenance({ sourceUrl: "https://example.com/brief", evidence, raw });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({
      proposer: "gptzero",
      source_url: "https://example.com/brief",
      suspicious_claim: "See United States v. Ortiz.",
      evidence_span: "See United States v. Ortiz.",
      proposed_upstream: { url: null, citation: "United States v. Ortiz" },
      confidence: 0.97,
      metadata: {
        label: "ai",
        document_ai_probability: 0.93,
        sentence_ai_probability: 0.97,
        checked_at: "2026-09-19T12:00:00.000Z",
      },
      raw_evidence: raw,
    });
  });

  it("produces no proposals when nothing is flagged", async () => {
    const fakeFetch = fakeFetchWith({
      documents: [
        {
          predicted_class: "human",
          class_probabilities: { ai: 0.05, human: 0.9, mixed: 0.05 },
          sentences: [{ sentence: "Plain sentence.", generated_prob: 0.05, highlight_sentence_for_ai: false }],
        },
      ],
    });
    const client = new GptZeroClient("test-key", fakeFetch, fixedNow);
    const { evidence, raw } = await client.detectWithRaw("Plain sentence.");

    expect(proposeProvenance({ sourceUrl: null, evidence, raw })).toEqual([]);
  });

  it("falls back to the document-level probability when a flagged passage has no per-sentence generated_prob", async () => {
    const fakeFetch = fakeFetchWith({
      documents: [
        {
          predicted_class: "ai",
          completely_generated_prob: 0.8,
          sentences: [{ sentence: "Flagged but no probability field.", highlight_sentence_for_ai: true }],
        },
      ],
    });
    const client = new GptZeroClient("test-key", fakeFetch, fixedNow);
    const { evidence, raw } = await client.detectWithRaw("Flagged but no probability field.");

    const [proposal] = proposeProvenance({ sourceUrl: null, evidence, raw });
    expect(proposal!.confidence).toBe(0.8);
    expect(proposal!.metadata.sentence_ai_probability).toBeNull();
    expect(proposal!.proposed_upstream).toEqual({ url: null, citation: null });
  });
});
