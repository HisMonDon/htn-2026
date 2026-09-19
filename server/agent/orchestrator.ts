import type { ActionLogEntry, ActionStep, Case } from "../../shared/schema";
import { parseCase } from "../../shared/validate";
import { buildDraft, correctionReference, passageHints } from "./draft";
import {
  assertIndependentEvidence,
  draftHash,
  isControlledTarget,
  issueSubmissionPermit,
  SafetyError,
} from "./safety";
import { normalizeText } from "./semantics";
import type { BrowserOperator, OperatorFactory } from "./types";

/**
 * Drives the action loop:
 *
 *   investigate: open_source -> verify_passage -> locate_route -> fill_fields -> await_approval (stop)
 *   execute:     [approval gate] -> submit -> reopen -> verify
 *
 * Browser work is delegated to a BrowserOperator; this module owns ordering, logging and safety.
 */

export type RunOutcome =
  | "awaiting_approval"
  | "draft_only"
  | "rejected"
  | "blocked"
  | "verified"
  | "inconclusive"
  | "failed";

export interface StageRecord {
  step: ActionStep;
  status: ActionLogEntry["status"];
  detail: string;
  at: string;
}

export interface RunReport {
  case_id: string;
  phase: "investigate" | "execute";
  operator: BrowserOperator["kind"] | null;
  replay_url: string | null;
  stages: StageRecord[];
  outcome: RunOutcome;
  error: string | null;
}

/** Per-case state that is not part of the shared contract and does not survive a restart. */
export interface RunContext {
  sourceUrl: string | null;
  passage: string | null;
  operator: BrowserOperator | null;
  /** Hash of the draft currently typed into the open form, if any. */
  filledDraftHash: string | null;
  /** Hash of the draft the human approved. */
  approvedDraftHash: string | null;
}

export function emptyContext(): RunContext {
  return { sourceUrl: null, passage: null, operator: null, filledDraftHash: null, approvedDraftHash: null };
}

export interface OrchestratorDeps {
  operatorFactory: OperatorFactory;
  allowedOrigins: readonly string[];
  contactEmail: string;
  now?: () => Date;
}

class StageFailure extends Error {}

/** One run's mutable view of the case, validated against the shared contract on every change. */
class Run {
  value: Case;
  readonly report: RunReport;
  private readonly stageByLogIndex = new Map<number, StageRecord>();

  constructor(
    value: Case,
    phase: RunReport["phase"],
    private readonly now: () => Date,
  ) {
    this.value = structuredClone(value);
    this.report = {
      case_id: value.id,
      phase,
      operator: null,
      replay_url: null,
      stages: [],
      outcome: "failed",
      error: null,
    };
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  commit(mutate: (draft: Case) => void): void {
    const next = structuredClone(this.value);
    mutate(next);
    this.value = parseCase(next);
  }

  record(step: ActionStep, status: ActionLogEntry["status"], detail: string, replayUrl: string | null): number {
    const at = this.timestamp();
    this.commit((draft) => {
      draft.action_log.push({ step, status, timestamp: at, replay_url: replayUrl });
    });
    const record: StageRecord = { step, status, detail, at };
    this.report.stages.push(record);
    const index = this.value.action_log.length - 1;
    this.stageByLogIndex.set(index, record);
    return index;
  }

  update(index: number, status: ActionLogEntry["status"], detail: string, replayUrl: string | null): void {
    const at = this.timestamp();
    this.commit((draft) => {
      const entry = draft.action_log[index]!;
      entry.status = status;
      entry.timestamp = at;
      entry.replay_url = replayUrl ?? entry.replay_url;
    });
    const stage = this.stageByLogIndex.get(index);
    if (stage) Object.assign(stage, { status, detail, at });
    else this.report.stages.push({ step: this.value.action_log[index]!.step, status, detail, at });
  }

  /** Log a stage as attempted, run it, then mark it completed or failed. */
  async stage<T>(
    step: ActionStep,
    operator: BrowserOperator | null,
    work: () => Promise<{ result: T; detail: string }>,
  ): Promise<T> {
    const replay = () => operator?.replayUrl() ?? null;
    const index = this.record(step, "attempted", "", replay());
    try {
      const { result, detail } = await work();
      this.update(index, "completed", detail, replay());
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update(index, "failed", message, replay());
      throw new StageFailure(`${step}: ${message}`);
    }
  }
}

export class Orchestrator {
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isControlled(url: string): boolean {
    return isControlledTarget(url, this.deps.allowedOrigins);
  }

  /**
   * Investigate the source, prepare the draft, and stop at the approval gate. Never submits.
   * On a controlled target the correction form is left filled in an open browser session.
   */
  async investigate(value: Case, ctx: RunContext, sourceUrl: string): Promise<{ value: Case; report: RunReport }> {
    const run = new Run(value, "investigate", this.now);
    await closeOperator(ctx);
    Object.assign(ctx, emptyContext(), { sourceUrl });

    try {
      assertIndependentEvidence(run.value);
      // A fresh investigation always needs a fresh human decision.
      run.commit((draft) => {
        draft.approval = { status: "pending", decided_at: null };
        draft.verification = { status: "not_started", checked_at: null, observed_change: null };
      });

      const operator = await this.deps.operatorFactory();
      ctx.operator = operator;
      run.report.operator = operator.kind;
      await this.prepare(run, ctx, operator, sourceUrl, { regenerateDraft: true });

      if (!this.isControlled(sourceUrl) || run.value.correction.route_type !== "form") {
        // External routes are drafted for a human to use; the browser session is not needed.
        await closeOperator(ctx);
        run.record("await_approval", "pending", "draft only: route is not a controlled target", null);
        run.report.outcome = "draft_only";
      } else {
        run.record("await_approval", "pending", "form filled; waiting for human approval", operator.replayUrl());
        run.report.outcome = "awaiting_approval";
      }
      run.report.replay_url = operator.replayUrl();
    } catch (error) {
      await closeOperator(ctx);
      run.report.outcome = "failed";
      run.report.error = error instanceof Error ? error.message : String(error);
    }
    return { value: run.value, report: run.report };
  }

  /** Stages 1-4. Types into the page only when the route is a form on a controlled target. */
  private async prepare(
    run: Run,
    ctx: RunContext,
    operator: BrowserOperator,
    sourceUrl: string,
    options: { regenerateDraft: boolean },
  ): Promise<void> {
    await run.stage("open_source", operator, async () => {
      const page = await operator.open(sourceUrl);
      return { result: page, detail: `opened ${page.url}` };
    });

    const passage = await run.stage("verify_passage", operator, async () => {
      const found = await operator.findPassage(passageHints(run.value));
      if (!found.found || !found.passage) {
        throw new Error(`affected passage not verified on the page: ${found.reason ?? "not found"}`);
      }
      return { result: found.passage, detail: `${found.passage}${found.reason ? ` [${found.reason}]` : ""}` };
    });
    ctx.passage = passage;

    const route = await run.stage("locate_route", operator, async () => {
      const found = await operator.locateCorrectionRoute();
      if (found.route_type === "none" || !found.route_url) throw new Error("no correction route found");
      return { result: found, detail: `${found.route_type} at ${found.route_url}` };
    });

    run.commit((draft) => {
      const existing = draft.correction.draft_fields;
      const keep = !options.regenerateDraft && (existing.subject !== "" || existing.body !== "");
      draft.correction = {
        route_type: route.route_type,
        route_url: route.route_url,
        policy_summary: route.policy_summary,
        draft_fields: keep ? existing : buildDraft(draft, passage),
        draft_ready: false,
      };
    });

    const typeIntoPage = route.route_type === "form" && this.isControlled(route.route_url!);
    await run.stage("fill_fields", operator, async () => {
      if (!typeIntoPage) {
        return { result: null, detail: "draft prepared; external route is never filled or submitted" };
      }
      const fill = await operator.fillCorrectionForm({
        name: "Lineage correction agent",
        email: this.deps.contactEmail,
        subject: run.value.correction.draft_fields.subject,
        body: run.value.correction.draft_fields.body,
        passage,
        sources: run.value.falsehood.independent_evidence_urls,
      });
      if (fill.missing_required.length > 0) {
        throw new Error(`could not fill required fields: ${fill.missing_required.join(", ")}`);
      }
      if (!fill.filled.includes("body")) {
        throw new Error(`the correction text was not entered into the form (filled: ${fill.filled.join(", ") || "nothing"})`);
      }
      return { result: fill, detail: `filled ${fill.filled.join(", ")}; not submitted` };
    });
    ctx.filledDraftHash = typeIntoPage ? draftHash(run.value.correction.draft_fields) : null;
    run.commit((draft) => {
      draft.correction.draft_ready = true;
    });
  }

  /**
   * Submit, reopen and verify. Refuses unless approval.status === "approved" and the route is a
   * form on a controlled target.
   */
  async execute(value: Case, ctx: RunContext): Promise<{ value: Case; report: RunReport }> {
    const run = new Run(value, "execute", this.now);
    run.report.operator = ctx.operator?.kind ?? null;
    const lastAwait = lastIndexOfStep(run.value, "await_approval");

    try {
      if (run.value.approval.status === "pending") {
        run.report.outcome = "awaiting_approval";
        throw new SafetyError('approval.status is "pending"; nothing was submitted');
      }
      if (run.value.approval.status === "rejected") {
        if (lastAwait >= 0) run.update(lastAwait, "failed", "approval rejected", null);
        await closeOperator(ctx);
        run.report.outcome = "rejected";
        throw new SafetyError('approval.status is "rejected"; nothing was submitted');
      }
      const route = run.value.correction;
      if (route.route_type !== "form" || !route.route_url || !this.isControlled(route.route_url)) {
        run.report.outcome = "blocked";
        throw new SafetyError("route is not a form on a controlled target; it may be drafted but never submitted");
      }
      if (!ctx.sourceUrl) {
        run.report.outcome = "blocked";
        throw new SafetyError("no investigation context; run investigate first");
      }
      if (lastAwait >= 0) run.update(lastAwait, "completed", "approved by a human", null);

      const operator = await this.sessionForSubmit(run, ctx);
      run.report.operator = operator.kind;

      const permit = issueSubmissionPermit({
        value: run.value,
        formUrl: await operator.currentUrl(),
        allowedOrigins: this.deps.allowedOrigins,
        approvedDraftHash: ctx.approvedDraftHash,
      });

      await run.stage("submit", operator, async () => {
        const result = await operator.submitCorrectionForm(permit);
        if (!result.submitted) throw new Error(`submission did not go through: ${result.message}`);
        return { result, detail: `submitted; landed on ${result.result_url}` };
      });
      ctx.filledDraftHash = null;

      const sourceUrl = ctx.sourceUrl;
      await run.stage("reopen", operator, async () => {
        const page = await operator.open(sourceUrl);
        return { result: page, detail: `reopened ${page.url}` };
      });

      const verdict = await this.verify(run, operator, ctx.passage ?? "");
      run.report.outcome =
        verdict === "passed" ? "verified" : verdict === "inconclusive" ? "inconclusive" : "failed";
      run.report.replay_url = operator.replayUrl();
      await closeOperator(ctx);
    } catch (error) {
      if (!(error instanceof SafetyError)) {
        run.report.outcome = "failed";
        await closeOperator(ctx);
      } else if (run.report.outcome === "failed") {
        run.report.outcome = "blocked";
      }
      run.report.error = error instanceof Error ? error.message : String(error);
    }
    return { value: run.value, report: run.report };
  }

  /** Reuse the investigation session when the approved draft is what is typed in; otherwise re-prepare. */
  private async sessionForSubmit(run: Run, ctx: RunContext): Promise<BrowserOperator> {
    const approvedHash = draftHash(run.value.correction.draft_fields);
    if (ctx.operator && ctx.filledDraftHash === approvedHash) {
      try {
        const url = await ctx.operator.currentUrl();
        if (this.isControlled(url)) return ctx.operator;
      } catch {
        // Session expired or was closed; fall through to a fresh one.
      }
    }
    await closeOperator(ctx);
    const operator = await this.deps.operatorFactory();
    ctx.operator = operator;
    await this.prepare(run, ctx, operator, ctx.sourceUrl!, { regenerateDraft: false });
    if (draftHash(run.value.correction.draft_fields) !== approvedHash) {
      throw new SafetyError("draft changed while re-preparing; approval no longer applies");
    }
    if (run.value.correction.route_url === null || !this.isControlled(run.value.correction.route_url)) {
      throw new SafetyError("re-discovered route is not on a controlled target");
    }
    return operator;
  }

  private async verify(run: Run, operator: BrowserOperator, passage: string): Promise<"passed" | "failed" | "inconclusive"> {
    const reference = correctionReference(run.value);
    const subject = run.value.correction.draft_fields.subject;
    let verdict: "passed" | "failed" | "inconclusive" = "failed";
    let observed = "";
    try {
      await run.stage("verify", operator, async () => {
        const page = await operator.readPage();
        const text = normalizeText(page.text);
        const referenceShown = text.includes(normalizeText(reference)) || text.includes(normalizeText(subject));
        const inspection = passage ? await operator.inspectCorrection(passage) : null;
        const passageGone = passage ? !text.includes(normalizeText(passage)) : false;
        const passageHandled = passageGone || inspection?.passage_marked_corrected === true;

        if (referenceShown && passageHandled) {
          verdict = "passed";
          observed = `correction notice citing ${reference} is published and the false passage is ${passageGone ? "removed" : "marked as corrected"}`;
        } else if (referenceShown || passageHandled) {
          verdict = "inconclusive";
          observed = referenceShown
            ? `correction notice citing ${reference} is published, but the false passage still appears unmarked`
            : "the passage changed, but no notice referencing our submission was found";
        } else {
          verdict = "failed";
          observed = "reopened page shows no sign of the correction";
          throw new Error(observed);
        }
        return { result: null, detail: observed };
      });
    } catch (error) {
      if (!(error instanceof StageFailure)) throw error;
    }
    run.commit((draft) => {
      draft.verification = { status: verdict, checked_at: run.timestamp(), observed_change: observed || null };
    });
    return verdict;
  }
}

function lastIndexOfStep(value: Case, step: ActionStep): number {
  for (let index = value.action_log.length - 1; index >= 0; index -= 1) {
    if (value.action_log[index]!.step === step) return index;
  }
  return -1;
}

async function closeOperator(ctx: RunContext): Promise<void> {
  const operator = ctx.operator;
  ctx.operator = null;
  ctx.filledDraftHash = null;
  if (operator) await operator.close().catch(() => undefined);
}
