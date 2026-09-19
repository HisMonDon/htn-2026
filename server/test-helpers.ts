import fixture from "../data/cohen-bard.json" with { type: "json" };
import type { Case } from "../shared/schema";
import { parseCase } from "../shared/validate";
import { OfflineOperator } from "./agent/offline-operator";
import { Orchestrator } from "./agent/orchestrator";
import type { BrowserOperator, OperatorFactory } from "./agent/types";
import { loadConfig } from "./config";
import { MockGptZero } from "./gptzero/client";
import { LineageService } from "./service";
import type { TargetVariant } from "./target/app";
import { startTarget, type RunningTarget } from "./target/server";

export const CASE_ID = "cohen-bard-2023";

export function seedCase(): Case {
  return parseCase(structuredClone(fixture));
}

export interface Harness {
  target: RunningTarget;
  service: LineageService;
  orchestrator: Orchestrator;
  articleUrl: string;
  operatorsCreated: BrowserOperator[];
  close(): Promise<void>;
}

/** Controlled target on a random port, allowlisted, driven by the offline test operator. */
export async function harness(
  options: { variant?: TargetVariant; wrapOperator?: (operator: BrowserOperator) => BrowserOperator } = {},
): Promise<Harness> {
  const target = await startTarget({ variant: options.variant });
  const config = loadConfig({ USE_MOCKS: "true", CONTROLLED_TARGET_URL: target.url });
  const operatorsCreated: BrowserOperator[] = [];
  const operatorFactory: OperatorFactory = async () => {
    const base = new OfflineOperator(config.controlledTargetOrigins);
    const operator = options.wrapOperator ? options.wrapOperator(base) : base;
    operatorsCreated.push(operator);
    return operator;
  };
  const orchestrator = new Orchestrator({
    operatorFactory,
    allowedOrigins: config.controlledTargetOrigins,
    contactEmail: config.contactEmail,
  });
  const service = new LineageService({ config, orchestrator, detector: new MockGptZero(), seed: [seedCase()] });
  return {
    target,
    service,
    orchestrator,
    articleUrl: `${target.url}/articles/cohen-supervised-release`,
    operatorsCreated,
    close: async () => {
      await service.shutdown();
      await target.close();
    },
  };
}
