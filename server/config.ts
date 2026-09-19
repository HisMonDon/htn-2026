export interface Config {
  useMocks: boolean;
  browserbaseApiKey: string | null;
  browserbaseProjectId: string | null;
  gptzeroApiKey: string | null;
  /** Optional Stagehand model, e.g. "anthropic/claude-sonnet-4-6". Omitted lets Model Gateway choose. */
  stagehandModel: string | null;
  /** Browserbase session lifetime in seconds (covers the gap while a human reviews the draft). */
  browserbaseSessionTimeoutS: number;
  apiPort: number;
  targetPort: number;
  /**
   * Base URL the browser uses to reach the controlled target. Browserbase runs in the cloud and
   * cannot reach localhost, so for live runs this must be a public tunnel to the target port.
   */
  controlledTargetUrl: string;
  /** Origins that submissions are allowed to reach. Always derived from controlledTargetUrl plus extras. */
  controlledTargetOrigins: string[];
  contactEmail: string;
}

function flag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const targetPort = int(env.TARGET_PORT, 4100);
  const controlledTargetUrl = (
    nonEmpty(env.CONTROLLED_TARGET_URL) ?? `http://localhost:${targetPort}`
  ).replace(/\/+$/, "");
  const extraOrigins = (env.CONTROLLED_TARGET_EXTRA_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    useMocks: flag(env.USE_MOCKS),
    browserbaseApiKey: nonEmpty(env.BROWSERBASE_API_KEY),
    browserbaseProjectId: nonEmpty(env.BROWSERBASE_PROJECT_ID),
    gptzeroApiKey: nonEmpty(env.GPTZERO_API_KEY),
    stagehandModel: nonEmpty(env.STAGEHAND_MODEL),
    browserbaseSessionTimeoutS: int(env.BROWSERBASE_SESSION_TIMEOUT_S, 900),
    apiPort: int(env.API_PORT, 4000),
    targetPort,
    controlledTargetUrl,
    controlledTargetOrigins: [controlledTargetUrl, ...extraOrigins].map(
      (url) => new URL(url).origin,
    ),
    contactEmail: nonEmpty(env.LINEAGE_CONTACT_EMAIL) ?? "corrections-bot@lineage.invalid",
  };
}
