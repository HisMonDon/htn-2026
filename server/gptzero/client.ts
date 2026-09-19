import { createHash } from "node:crypto";
import { z } from "zod";
import { AiEvidence, type AiEvidence as AiEvidenceValue } from "../../shared/schema";

/**
 * AI-writing detection. A result is evidence that text may be machine-written, nothing more:
 * it never establishes that a claim is false and never triggers a correction. Falsehood rests on
 * falsehood.independent_evidence_urls only.
 */
export interface AiWritingDetector {
  readonly kind: "gptzero" | "mock";
  detect(text: string): Promise<AiEvidenceValue>;
}

function labelFor(probability: number): AiEvidenceValue["label"] {
  if (probability >= 0.7) return "ai";
  if (probability <= 0.3) return "human";
  return "mixed";
}

/** Deterministic stand-in: same text, same score. Clearly not a detector. */
export class MockGptZero implements AiWritingDetector {
  readonly kind = "mock" as const;
  constructor(private readonly now: () => Date = () => new Date()) {}

  async detect(text: string): Promise<AiEvidenceValue> {
    const digest = createHash("sha256").update(text).digest();
    const probability = Math.round((digest[0]! / 255) * 100) / 100;
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return AiEvidence.parse({
      provider: "gptzero",
      ai_probability: probability,
      label: labelFor(probability),
      checked_at: this.now().toISOString(),
      flagged_passages: probability >= 0.7 ? sentences.slice(0, 1) : [],
    });
  }
}

/**
 * Response fields read from POST https://api.gptzero.me/v2/predict/text (header x-api-key, body
 * { document }). Parsed loosely: only the fields we use, all optional, because the public docs
 * render client-side and we could not confirm the full schema offline.
 */
const PredictResponse = z.object({
  documents: z
    .array(
      z.object({
        predicted_class: z.enum(["ai", "human", "mixed"]).optional(),
        class_probabilities: z
          .object({ ai: z.number().optional(), human: z.number().optional(), mixed: z.number().optional() })
          .optional(),
        completely_generated_prob: z.number().optional(),
        sentences: z
          .array(
            z.object({
              sentence: z.string().optional(),
              generated_prob: z.number().optional(),
              highlight_sentence_for_ai: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});

export class GptZeroClient implements AiWritingDetector {
  readonly kind = "gptzero" as const;
  static readonly endpoint = "https://api.gptzero.me/v2/predict/text";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async detect(text: string): Promise<AiEvidenceValue> {
    const response = await this.fetchImpl(GptZeroClient.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ document: text }),
    });
    if (!response.ok) {
      throw new Error(`GPTZero returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const parsed = PredictResponse.parse(await response.json());
    const doc = parsed.documents[0]!;
    const probability = doc.class_probabilities?.ai ?? doc.completely_generated_prob;
    if (probability === undefined) throw new Error("GPTZero response had no AI probability");
    const clamped = Math.min(1, Math.max(0, probability));
    return AiEvidence.parse({
      provider: "gptzero",
      ai_probability: clamped,
      label: doc.predicted_class ?? labelFor(clamped),
      checked_at: this.now().toISOString(),
      flagged_passages: (doc.sentences ?? [])
        .filter((sentence) => sentence.highlight_sentence_for_ai && sentence.sentence)
        .map((sentence) => sentence.sentence!),
    });
  }
}

export function createDetector(config: { useMocks: boolean; gptzeroApiKey: string | null }): AiWritingDetector {
  if (config.useMocks) return new MockGptZero();
  if (!config.gptzeroApiKey) {
    return {
      kind: "gptzero",
      detect: async () => {
        throw new Error("GPTZERO_API_KEY is not set. Set it, or set USE_MOCKS=true.");
      },
    };
  }
  return new GptZeroClient(config.gptzeroApiKey);
}
