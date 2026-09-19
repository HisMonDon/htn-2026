import { describe, expect, it } from "vitest";
import fixture from "./cohen-bard.json";
import { parseCase } from "../shared/validate";

describe("Cohen/Bard fixture", () => {
  it("validates against the shared Case contract", () => {
    expect(() => parseCase(fixture)).not.toThrow();
  });

  it("is a four-node linear propagation chain", () => {
    const parsed = parseCase(fixture);
    expect(parsed.chain).toHaveLength(4);
    expect(parsed.chain[0]?.edge).toBeNull();

    for (let index = 1; index < parsed.chain.length; index += 1) {
      expect(parsed.chain[index]?.edge?.parent_id).toBe(parsed.chain[index - 1]?.id);
      expect(parsed.chain[index]?.edge?.type).toBe("propagation");
    }
  });

  it("establishes falsehood with independent evidence rather than GPTZero", () => {
    const parsed = parseCase(fixture);
    expect(parsed.falsehood.independent_evidence_urls.length).toBeGreaterThan(0);
    expect(parsed.chain.every((node) => node.ai_evidence === null)).toBe(true);
  });

  it("starts with no correction route, approval, action, or verification", () => {
    const parsed = parseCase(fixture);
    expect(parsed.correction.route_type).toBe("none");
    expect(parsed.correction.draft_ready).toBe(false);
    expect(parsed.approval.status).toBe("pending");
    expect(parsed.action_log).toEqual([]);
    expect(parsed.verification.status).toBe("not_started");
  });
});
