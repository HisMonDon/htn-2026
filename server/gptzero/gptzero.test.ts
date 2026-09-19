import { describe, expect, it } from "vitest";
import { CASE_ID, harness, seedCase } from "../test-helpers";
import { createDetector, GptZeroClient, MockGptZero } from "./client";
import { attachAiEvidence } from "./evidence";

const fixedNow = () => new Date("2026-09-19T12:00:00Z");

describe("MockGptZero", () => {
  it("is deterministic and schema-valid", async () => {
    const mock = new MockGptZero(fixedNow);
    const a = await mock.detect("Some text. More text.");
    const b = await mock.detect("Some text. More text.");
    expect(a).toEqual(b);
    expect(a.provider).toBe("gptzero");
    expect(a.ai_probability).toBeGreaterThanOrEqual(0);
    expect(a.ai_probability).toBeLessThanOrEqual(1);
  });
});

describe("GptZeroClient", () => {
  it("posts the document with the API key and maps the response", async () => {
    let request: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          documents: [
            {
              predicted_class: "ai",
              class_probabilities: { ai: 0.93, human: 0.05, mixed: 0.02 },
              completely_generated_prob: 0.9,
              sentences: [
                { sentence: "See United States v. Ortiz.", generated_prob: 0.97, highlight_sentence_for_ai: true },
                { sentence: "Plain sentence.", generated_prob: 0.1, highlight_sentence_for_ai: false },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new GptZeroClient("test-key", fakeFetch, fixedNow);
    const evidence = await client.detect("See United States v. Ortiz. Plain sentence.");

    expect(request!.url).toBe("https://api.gptzero.me/v2/predict/text");
    expect((request!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(request!.init.body))).toEqual({ document: "See United States v. Ortiz. Plain sentence." });
    expect(evidence).toEqual({
      provider: "gptzero",
      ai_probability: 0.93,
      label: "ai",
      checked_at: "2026-09-19T12:00:00.000Z",
      flagged_passages: ["See United States v. Ortiz."],
    });
  });

  it("surfaces API errors", async () => {
    const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(new GptZeroClient("bad", fakeFetch).detect("x")).rejects.toThrow(/401/);
  });
});

describe("detector selection", () => {
  it("uses the mock when USE_MOCKS is on and the real client otherwise", async () => {
    expect(createDetector({ useMocks: true, gptzeroApiKey: null }).kind).toBe("mock");
    expect(createDetector({ useMocks: false, gptzeroApiKey: "k" })).toBeInstanceOf(GptZeroClient);
    await expect(createDetector({ useMocks: false, gptzeroApiKey: null }).detect("x")).rejects.toThrow(/GPTZERO_API_KEY/);
  });
});

describe("AI-writing evidence never decides falsehood or triggers action", () => {
  const evidence = {
    provider: "gptzero" as const,
    ai_probability: 0.99,
    label: "ai" as const,
    checked_at: "2026-09-19T12:00:00Z",
    flagged_passages: ["United States v. Ortiz"],
  };

  it("only changes the node's ai_evidence", () => {
    const before = seedCase();
    const after = attachAiEvidence(before, "bard-generation", evidence);
    expect(after.chain[0]!.ai_evidence).toEqual(evidence);
    const { chain: _a, ...restAfter } = after;
    const { chain: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
  });

  it("a high AI score through the API starts no action", async () => {
    const h = await harness();
    try {
      const { case: value } = await h.service.checkAiWriting(CASE_ID, "schwartz-motion");
      expect(value.chain.find((node) => node.id === "schwartz-motion")!.ai_evidence).not.toBeNull();
      expect(value.action_log).toEqual([]);
      expect(value.approval.status).toBe("pending");
      expect(value.correction.route_type).toBe("none");
      expect(h.operatorsCreated).toHaveLength(0);
      expect(h.target.app.state().corrections).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
