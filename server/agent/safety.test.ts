import { describe, expect, it } from "vitest";
import type { Case } from "../../shared/schema";
import { seedCase } from "../test-helpers";
import {
  assertIndependentEvidence,
  consumePermit,
  draftHash,
  isControlledTarget,
  issueSubmissionPermit,
  SafetyError,
  type SubmissionPermit,
} from "./safety";

const ORIGINS = ["http://127.0.0.1:4100"];
const FORM = "http://127.0.0.1:4100/corrections?article=x";

function ready(status: Case["approval"]["status"] = "approved"): Case {
  const value = seedCase();
  value.correction = {
    route_type: "form",
    route_url: FORM,
    policy_summary: "",
    draft_fields: { subject: "s", body: "b" },
    draft_ready: true,
  };
  value.approval = { status, decided_at: status === "pending" ? null : "2026-09-19T00:00:00Z" };
  return value;
}

function permitFor(value: Case, overrides: Partial<Parameters<typeof issueSubmissionPermit>[0]> = {}) {
  return issueSubmissionPermit({
    value,
    formUrl: FORM,
    allowedOrigins: ORIGINS,
    approvedDraftHash: draftHash(value.correction.draft_fields),
    ...overrides,
  });
}

describe("controlled target allowlist", () => {
  it("matches origins exactly", () => {
    expect(isControlledTarget(FORM, ORIGINS)).toBe(true);
    expect(isControlledTarget("http://127.0.0.1:4101/corrections", ORIGINS)).toBe(false);
    expect(isControlledTarget("https://www.nytimes.com/corrections", ORIGINS)).toBe(false);
    expect(isControlledTarget("http://127.0.0.1.evil.com:4100/", ORIGINS)).toBe(false);
    expect(isControlledTarget("mailto:corrections@example.com", ORIGINS)).toBe(false);
  });
});

describe("submission permits", () => {
  it("is issued only when approved", () => {
    expect(() => permitFor(ready("pending"))).toThrow(SafetyError);
    expect(() => permitFor(ready("rejected"))).toThrow(SafetyError);
    expect(() => permitFor(ready("approved"))).not.toThrow();
  });

  it("is never issued for a real external site", () => {
    expect(() => permitFor(ready(), { formUrl: "https://www.nytimes.com/corrections" })).toThrow(/not a controlled target/);
  });

  it("is refused if the draft differs from what was approved", () => {
    expect(() => permitFor(ready(), { approvedDraftHash: "something-else" })).toThrow(/changed after it was approved/);
    expect(() => permitFor(ready(), { approvedDraftHash: null })).toThrow(SafetyError);
  });

  it("can be used once, on the permitted origin only", () => {
    const permit = permitFor(ready());
    expect(() => consumePermit(permit, "https://example.org/form", ORIGINS)).toThrow(SafetyError);
    consumePermit(permit, FORM, ORIGINS);
    expect(() => consumePermit(permit, FORM, ORIGINS)).toThrow(/already used/);
  });

  it("rejects a forged permit", () => {
    const forged: SubmissionPermit = { caseId: "x", origin: "http://127.0.0.1:4100", draftHash: "h", issuedAt: Date.now() };
    expect(() => consumePermit(forged, FORM, ORIGINS)).toThrow(/not issued/);
  });
});

describe("falsehood evidence", () => {
  it("refuses to act when there is no independent evidence, whatever GPTZero says", () => {
    const value = seedCase();
    value.chain[0]!.ai_evidence = {
      provider: "gptzero",
      ai_probability: 0.99,
      label: "ai",
      checked_at: "2026-09-19T00:00:00Z",
      flagged_passages: ["United States v. Ortiz"],
    };
    value.falsehood.independent_evidence_urls = [];
    expect(() => assertIndependentEvidence(value)).toThrow(SafetyError);
  });
});
