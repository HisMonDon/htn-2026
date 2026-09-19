/**
 * Runs the action loop end to end against the controlled target and prints each stage.
 *
 *   USE_MOCKS=true npm run loop     offline test operator (no Browserbase), for a quick sanity check
 *   npm run loop                    real Browserbase session; needs BROWSERBASE_API_KEY and
 *                                   CONTROLLED_TARGET_URL pointing at a public tunnel to TARGET_PORT
 */
import seed from "../../data/cohen-bard.json" with { type: "json" };
import type { Case } from "../../shared/schema";
import { createOperatorFactory } from "../agent/factory";
import { Orchestrator, type RunReport } from "../agent/orchestrator";
import { loadConfig } from "../config";
import { createDetector } from "../gptzero/client";
import { LineageService } from "../service";
import { startTarget } from "../target/server";

const config = loadConfig();
const target = await startTarget({
  port: config.targetPort,
  host: "0.0.0.0",
  variant: process.env.TARGET_VARIANT === "alt" ? "alt" : "classic",
});
const service = new LineageService({
  config,
  orchestrator: new Orchestrator({
    operatorFactory: createOperatorFactory(config),
    allowedOrigins: config.controlledTargetOrigins,
    contactEmail: config.contactEmail,
  }),
  detector: createDetector(config),
  seed: [seed as Case],
});

function show(label: string, value: Case, run?: RunReport) {
  console.log(`\n== ${label}`);
  if (run) {
    console.log(`operator: ${run.operator}  outcome: ${run.outcome}${run.error ? `  error: ${run.error}` : ""}`);
    if (run.replay_url) console.log(`replay: ${run.replay_url}`);
    for (const stage of run.stages) console.log(`  ${stage.step.padEnd(15)} ${stage.status.padEnd(10)} ${stage.detail}`);
  }
  console.log(`approval: ${value.approval.status}  verification: ${value.verification.status}`);
}

let exitCode = 1;
try {
  console.log(`operator: ${config.useMocks ? "offline test operator (USE_MOCKS)" : "Browserbase"}`);
  console.log(`controlled target: local ${target.url}, browser-facing ${config.controlledTargetUrl}`);

  const investigated = await service.investigate("cohen-bard-2023");
  show("investigate (stops before submit)", investigated.case, investigated.run);
  if (investigated.run.outcome !== "awaiting_approval") throw new Error("investigation did not reach the approval gate");

  const early = await service.execute("cohen-bard-2023");
  show("execute while approval is pending (must refuse)", early.case, early.run);
  if (target.app.state().corrections.length !== 0) throw new Error("SAFETY: something was submitted before approval");

  service.decide("cohen-bard-2023", "approved");
  const executed = await service.execute("cohen-bard-2023");
  show("execute after approval", executed.case, executed.run);
  console.log(`observed: ${executed.case.verification.observed_change}`);
  console.log(`target received ${target.app.state().corrections.length} correction(s)`);
  exitCode = executed.run.outcome === "verified" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await service.shutdown();
  await target.close();
}
process.exitCode = exitCode;
