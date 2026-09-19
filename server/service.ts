import type { Case, ChainNode } from "../shared/schema";
import { parseCase } from "../shared/validate";
import { unreachableFromCloud } from "./agent/factory";
import { emptyContext, type Orchestrator, type RunContext, type RunReport } from "./agent/orchestrator";
import { draftHash } from "./agent/safety";
import type { Config } from "./config";
import { attachAiEvidence } from "./gptzero/evidence";
import type { AiWritingDetector } from "./gptzero/client";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceDeps {
  config: Config;
  orchestrator: Orchestrator;
  detector: AiWritingDetector;
  seed: Case[];
  now?: () => Date;
}

/** In-memory case store plus the per-case browser context. Every stored case passes parseCase. */
export class LineageService {
  private readonly seed = new Map<string, Case>();
  private readonly cases = new Map<string, Case>();
  private readonly contexts = new Map<string, RunContext>();
  private readonly runs = new Map<string, RunReport[]>();
  private readonly busy = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => Date;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    for (const value of deps.seed) {
      const parsed = parseCase(value);
      this.seed.set(parsed.id, parsed);
      this.cases.set(parsed.id, structuredClone(parsed));
    }
  }

  list(): Case[] {
    return [...this.cases.values()];
  }

  get(id: string): Case {
    const value = this.cases.get(id);
    if (!value) throw new HttpError(404, `unknown case "${id}"`);
    return value;
  }

  runsFor(id: string): RunReport[] {
    this.get(id);
    return this.runs.get(id) ?? [];
  }

  private context(id: string): RunContext {
    let ctx = this.contexts.get(id);
    if (!ctx) {
      ctx = emptyContext();
      this.contexts.set(id, ctx);
    }
    return ctx;
  }

  private save(value: Case): Case {
    const parsed = parseCase(value);
    this.cases.set(parsed.id, parsed);
    return parsed;
  }

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new HttpError(409, `case "${id}" already has a run in progress`);
    this.busy.add(id);
    try {
      return await work();
    } finally {
      this.busy.delete(id);
    }
  }

  private recordRun(id: string, report: RunReport) {
    const list = this.runs.get(id) ?? [];
    list.push(report);
    this.runs.set(id, list);
  }

  /** Close a browser session left open for approval once it has idled past the session timeout. */
  private scheduleIdleClose(id: string) {
    clearTimeout(this.idleTimers.get(id));
    const ctx = this.contexts.get(id);
    if (!ctx?.operator) return;
    const timer = setTimeout(() => {
      const operator = ctx.operator;
      ctx.operator = null;
      ctx.filledDraftHash = null;
      void operator?.close().catch(() => undefined);
    }, this.deps.config.browserbaseSessionTimeoutS * 1000);
    timer.unref();
    this.idleTimers.set(id, timer);
  }

  defaultSourceUrl(): string {
    return `${this.deps.config.controlledTargetUrl}/articles/cohen-supervised-release`;
  }

  async investigate(id: string, sourceUrl?: string): Promise<{ case: Case; run: RunReport }> {
    const value = this.get(id);
    const url = sourceUrl ?? this.defaultSourceUrl();
    try {
      new URL(url);
    } catch {
      throw new HttpError(400, `invalid source_url "${url}"`);
    }
    if (!this.deps.config.useMocks && unreachableFromCloud(url)) {
      throw new HttpError(
        400,
        `${url} is not reachable from Browserbase cloud browsers. Expose the controlled target through a public tunnel and set CONTROLLED_TARGET_URL to it.`,
      );
    }
    return this.exclusive(id, async () => {
      const result = await this.deps.orchestrator.investigate(value, this.context(id), url);
      const saved = this.save(result.value);
      this.recordRun(id, result.report);
      this.scheduleIdleClose(id);
      return { case: saved, run: result.report };
    });
  }

  /** Editing the draft always voids a previous approval. */
  updateDraft(id: string, draft: Case["correction"]["draft_fields"]): Case {
    if (this.busy.has(id)) throw new HttpError(409, `case "${id}" already has a run in progress`);
    const value = structuredClone(this.get(id));
    if (value.correction.route_type === "none") {
      throw new HttpError(409, "no correction route yet; investigate first");
    }
    value.correction.draft_fields = draft;
    value.approval = { status: "pending", decided_at: null };
    this.context(id).approvedDraftHash = null;
    return this.save(value);
  }

  decide(id: string, status: "approved" | "rejected"): Case {
    if (this.busy.has(id)) throw new HttpError(409, `case "${id}" already has a run in progress`);
    const value = structuredClone(this.get(id));
    if (!value.correction.draft_ready) throw new HttpError(409, "there is no prepared draft to decide on");
    value.approval = { status, decided_at: this.now().toISOString() };
    this.context(id).approvedDraftHash = status === "approved" ? draftHash(value.correction.draft_fields) : null;
    return this.save(value);
  }

  async execute(id: string): Promise<{ case: Case; run: RunReport }> {
    const value = this.get(id);
    return this.exclusive(id, async () => {
      clearTimeout(this.idleTimers.get(id));
      const result = await this.deps.orchestrator.execute(value, this.context(id));
      const saved = this.save(result.value);
      this.recordRun(id, result.report);
      return { case: saved, run: result.report };
    });
  }

  /** AI-writing evidence only. Never changes the falsehood, the draft, approval or the action log. */
  async checkAiWriting(id: string, nodeId: string): Promise<{ case: Case; node: ChainNode }> {
    const value = this.get(id);
    const node = value.chain.find((candidate) => candidate.id === nodeId);
    if (!node) throw new HttpError(404, `unknown chain node "${nodeId}"`);
    const evidence = await this.deps.detector.detect(node.excerpt);
    // Re-read in case a run finished while the detector was working.
    const saved = this.save(attachAiEvidence(this.get(id), nodeId, evidence));
    return { case: saved, node: saved.chain.find((candidate) => candidate.id === nodeId)! };
  }

  async reset(id: string): Promise<Case> {
    const original = this.seed.get(id);
    if (!original) throw new HttpError(404, `unknown case "${id}"`);
    if (this.busy.has(id)) throw new HttpError(409, `case "${id}" already has a run in progress`);
    const ctx = this.contexts.get(id);
    await ctx?.operator?.close().catch(() => undefined);
    this.contexts.delete(id);
    this.runs.delete(id);
    return this.save(structuredClone(original));
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    await Promise.all(
      [...this.contexts.values()].map((ctx) => ctx.operator?.close().catch(() => undefined)),
    );
  }
}
