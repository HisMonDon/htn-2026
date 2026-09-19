import type { Config } from "../config";
import { BrowserbaseOperator } from "./browserbase-operator";
import { OfflineOperator } from "./offline-operator";
import type { OperatorFactory } from "./types";

/**
 * USE_MOCKS=true selects the offline test operator (no Browserbase, no replay).
 * Otherwise a real Browserbase session is required; there is no silent fallback to the mock.
 */
export function createOperatorFactory(config: Config): OperatorFactory {
  if (config.useMocks) {
    return async () => new OfflineOperator(config.controlledTargetOrigins);
  }
  const apiKey = config.browserbaseApiKey;
  if (!apiKey) {
    return async () => {
      throw new Error("BROWSERBASE_API_KEY is not set. Set it, or set USE_MOCKS=true for the offline test operator.");
    };
  }
  return () =>
    BrowserbaseOperator.launch({
      apiKey,
      projectId: config.browserbaseProjectId,
      model: config.stagehandModel,
      sessionTimeoutS: config.browserbaseSessionTimeoutS,
      allowedOrigins: config.controlledTargetOrigins,
    });
}

/** Cloud browsers cannot reach the developer's machine. Catch that before spending a session on it. */
export function unreachableFromCloud(url: string): boolean {
  const host = new URL(url).hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}
