import { createServer } from "node:http";
import seed from "../data/cohen-bard.json" with { type: "json" };
import { createOperatorFactory } from "./agent/factory";
import { Orchestrator } from "./agent/orchestrator";
import { createApi } from "./api/app";
import { createLineageController, createLineageDeps } from "./api/lineage";
import { loadConfig } from "./config";
import { createDetector } from "./gptzero/client";
import { LineageService } from "./service";
import { startTarget } from "./target/server";

const config = loadConfig();

const target = await startTarget({ port: config.targetPort, host: "0.0.0.0" });
const orchestrator = new Orchestrator({
  operatorFactory: createOperatorFactory(config),
  allowedOrigins: config.controlledTargetOrigins,
  contactEmail: config.contactEmail,
});
const detector = createDetector(config);
const lineage = createLineageController(createLineageDeps(config), config.useMocks ? "mock" : "live", () => new Date(), config.provenanceMode);
const service = new LineageService({ config, orchestrator, detector, seed: [seed as never] });
const handle = createApi(
  service,
  {
    mocks: config.useMocks,
    operator: config.useMocks ? "offline-heuristic" : "browserbase",
    detector: detector.kind,
    controlled_target_url: config.controlledTargetUrl,
  },
  {
    corsOrigin: process.env.CORS_ORIGIN?.trim() || null,
    lineage,
  },
);

const api = createServer((req, res) => void handle(req, res));
api.listen(config.apiPort, () => {
  console.log(`API on http://localhost:${config.apiPort}`);
  console.log(`controlled target on ${target.url} (browser-facing: ${config.controlledTargetUrl})`);
  console.log(`operator: ${config.useMocks ? "offline test operator (USE_MOCKS)" : "Browserbase"}; detector: ${detector.kind}`);
});

async function stop() {
  await service.shutdown();
  api.close();
  await target.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
