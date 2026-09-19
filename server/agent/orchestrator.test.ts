import { afterEach, describe, expect, it } from "vitest";
import { parseCase } from "../../shared/validate";
import { CASE_ID, harness, type Harness } from "../test-helpers";
import { startTarget } from "../target/server";
import type { BrowserOperator } from "./types";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const steps = (log: { step: string; status: string }[]) => log.map((entry) => `${entry.step}:${entry.status}`);

describe("investigate", () => {
  it("runs stages 1-4, fills the form, and stops at the approval gate without submitting", async () => {
    h = await harness();
    const { case: value, run } = await h.service.investigate(CASE_ID, h.articleUrl);

    expect(run.outcome).toBe("awaiting_approval");
    expect(steps(value.action_log)).toEqual([
      "open_source:completed",
      "verify_passage:completed",
      "locate_route:completed",
      "fill_fields:completed",
      "await_approval:pending",
    ]);
    expect(value.correction.route_type).toBe("form");
    expect(value.correction.route_url).toContain("/corrections");
    expect(value.correction.draft_ready).toBe(true);
    expect(value.correction.draft_fields.body).toContain("LINEAGE-cohen-bard-2023");
    expect(value.approval.status).toBe("pending");
    expect(run.stages[1]?.detail).toContain("United States v. Figueroa-Florez");
    expect(h.target.app.state().corrections).toHaveLength(0);
    expect(() => parseCase(value)).not.toThrow();
  });

  it("finds the route and fields on a differently built page (no per-site selectors)", async () => {
    h = await harness({ variant: "alt" });
    const { case: value, run } = await h.service.investigate(CASE_ID, h.articleUrl);
    expect(run.outcome).toBe("awaiting_approval");
    expect(value.correction.route_url).toContain("/feedback/errata");
    expect(run.stages.find((stage) => stage.step === "fill_fields")?.detail).toMatch(/email.*subject.*passage.*body/);
  });

  it("fails verify_passage when the page does not contain the claim", async () => {
    h = await harness();
    const { case: value, run } = await h.service.investigate(CASE_ID, `${h.target.url}/articles/court-calendar`);
    expect(run.outcome).toBe("failed");
    expect(steps(value.action_log)).toEqual(["open_source:completed", "verify_passage:failed"]);
  });
});

describe("approval gate", () => {
  it("does not submit while approval is pending", async () => {
    h = await harness();
    await h.service.investigate(CASE_ID, h.articleUrl);
    const { case: value, run } = await h.service.execute(CASE_ID);
    expect(run.outcome).toBe("awaiting_approval");
    expect(value.action_log.some((entry) => entry.step === "submit")).toBe(false);
    expect(h.target.app.state().corrections).toHaveLength(0);
  });

  it("does not submit when approval is rejected", async () => {
    h = await harness();
    await h.service.investigate(CASE_ID, h.articleUrl);
    h.service.decide(CASE_ID, "rejected");
    const { case: value, run } = await h.service.execute(CASE_ID);
    expect(run.outcome).toBe("rejected");
    expect(value.action_log.some((entry) => entry.step === "submit")).toBe(false);
    expect(value.action_log.at(-1)).toMatchObject({ step: "await_approval", status: "failed" });
    expect(h.target.app.state().corrections).toHaveLength(0);
  });

  it("voids approval when the draft is edited, and refuses to submit", async () => {
    h = await harness();
    await h.service.investigate(CASE_ID, h.articleUrl);
    h.service.decide(CASE_ID, "approved");
    const edited = h.service.updateDraft(CASE_ID, { subject: "changed", body: "changed body" });
    expect(edited.approval.status).toBe("pending");
    const { run } = await h.service.execute(CASE_ID);
    expect(run.outcome).toBe("awaiting_approval");
    expect(h.target.app.state().corrections).toHaveLength(0);
  });

  it("submits, reopens and verifies after approval", async () => {
    h = await harness();
    await h.service.investigate(CASE_ID, h.articleUrl);
    h.service.decide(CASE_ID, "approved");
    const { case: value, run } = await h.service.execute(CASE_ID);

    expect(run.outcome).toBe("verified");
    expect(steps(value.action_log)).toEqual([
      "open_source:completed",
      "verify_passage:completed",
      "locate_route:completed",
      "fill_fields:completed",
      "await_approval:completed",
      "submit:completed",
      "reopen:completed",
      "verify:completed",
    ]);
    expect(value.verification.status).toBe("passed");
    expect(value.verification.observed_change).toContain("marked as corrected");
    const [submitted] = h.target.app.state().corrections;
    expect(submitted?.subject).toBe(value.correction.draft_fields.subject);
    expect(submitted?.details).toBe(value.correction.draft_fields.body);
    expect(submitted?.sources).toEqual(value.falsehood.independent_evidence_urls);
    // Reused the investigation session rather than starting over.
    expect(h.operatorsCreated).toHaveLength(1);
  });

  it("re-prepares in a fresh session if the investigation session is gone", async () => {
    h = await harness();
    await h.service.investigate(CASE_ID, h.articleUrl);
    await h.operatorsCreated[0]!.close();
    h.service.decide(CASE_ID, "approved");
    const { case: value, run } = await h.service.execute(CASE_ID);
    expect(run.outcome).toBe("verified");
    expect(h.operatorsCreated).toHaveLength(2);
    expect(value.action_log.filter((entry) => entry.step === "fill_fields")).toHaveLength(2);
    expect(h.target.app.state().corrections).toHaveLength(1);
  });

  it("does not reopen or verify when the submission fails", async () => {
    h = await harness({
      wrapOperator: (operator) =>
        Object.assign(Object.create(Object.getPrototypeOf(operator)), operator, {
          submitCorrectionForm: async () => ({ submitted: false, result_url: null, message: "server error" }),
        }) as BrowserOperator,
    });
    await h.service.investigate(CASE_ID, h.articleUrl);
    h.service.decide(CASE_ID, "approved");
    const { case: value, run } = await h.service.execute(CASE_ID);
    expect(run.outcome).toBe("failed");
    expect(value.action_log.at(-1)).toMatchObject({ step: "submit", status: "failed" });
    expect(value.action_log.some((entry) => entry.step === "reopen" || entry.step === "verify")).toBe(false);
    expect(value.verification.status).toBe("not_started");
  });
});

describe("real (non-controlled) sites", () => {
  it("drafts but never fills or submits, even when approved", async () => {
    h = await harness();
    // A second publisher on another origin that is NOT on the allowlist stands in for a real site.
    const external = await startTarget();
    try {
      const { case: value, run } = await h.service.investigate(
        CASE_ID,
        `${external.url}/articles/cohen-supervised-release`,
      );
      expect(run.outcome).toBe("draft_only");
      expect(value.correction.route_type).toBe("form");
      expect(value.correction.draft_ready).toBe(true);
      expect(run.stages.find((stage) => stage.step === "fill_fields")?.detail).toContain("never filled or submitted");

      h.service.decide(CASE_ID, "approved");
      const executed = await h.service.execute(CASE_ID);
      expect(executed.run.outcome).toBe("blocked");
      expect(executed.case.action_log.some((entry) => entry.step === "submit")).toBe(false);
      expect(external.app.state().corrections).toHaveLength(0);
    } finally {
      await external.close();
    }
  });
});
