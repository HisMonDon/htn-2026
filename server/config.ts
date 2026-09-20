export interface Config {
  useMocks: boolean;
  browserbaseApiKey: string | null;
  browserbaseProjectId: string | null;
  gptzeroApiKey: string | null;
  /** Independent web-retrieval proposer that runs alongside GPTZero. No apiKey: GPTZero-only discovery. */
  webSearch: {
    apiKey: string | null;
    maxQueries: number;
    resultsPerQuery: number;
    maxCandidates: number;
    timeoutMs: number;
  };
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
  /** Elastic retrieval for the research tree. null: in-memory BM25. */
  elastic: {
    url: string | null;
    cloudId: string | null;
    apiKey: string | null;
    index: string;
    semantic: boolean;
    inferenceId: string | null;
  } | null;
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
    webSearch: {
      apiKey: nonEmpty(env.BRAVE_SEARCH_API_KEY),
      maxQueries: int(env.WEB_SEARCH_MAX_QUERIES, 5),
      resultsPerQuery: int(env.WEB_SEARCH_RESULTS_PER_QUERY, 4),
      maxCandidates: int(env.WEB_SEARCH_MAX_CANDIDATES, 10),
      timeoutMs: int(env.WEB_SEARCH_TIMEOUT_MS, 10_000),
    },
    stagehandModel: nonEmpty(env.STAGEHAND_MODEL),
    browserbaseSessionTimeoutS: int(env.BROWSERBASE_SESSION_TIMEOUT_S, 900),
    apiPort: int(env.API_PORT, 4000),
    targetPort,
    controlledTargetUrl,
    controlledTargetOrigins: [controlledTargetUrl, ...extraOrigins].map(
      (url) => new URL(url).origin,
    ),
    contactEmail: nonEmpty(env.LINEAGE_CONTACT_EMAIL) ?? "corrections-bot@lineage.invalid",
    elastic:
      nonEmpty(env.ELASTIC_URL) || nonEmpty(env.ELASTIC_CLOUD_ID)
        ? {
            url: nonEmpty(env.ELASTIC_URL),
            cloudId: nonEmpty(env.ELASTIC_CLOUD_ID),
            apiKey: nonEmpty(env.ELASTIC_API_KEY),
            index: nonEmpty(env.ELASTIC_INDEX) ?? "lineage-candidates",
            semantic: !["0", "false", "no", "off"].includes((env.ELASTIC_SEMANTIC ?? "").trim().toLowerCase()),
            inferenceId: nonEmpty(env.ELASTIC_INFERENCE_ID),
          }
        : null,
  };
}
