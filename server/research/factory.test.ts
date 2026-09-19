import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createResearchDeps } from "./factory";

function config(env: NodeJS.ProcessEnv) {
  return loadConfig({ ...env });
}

describe("createResearchDeps provider selection", () => {
  it("USE_MOCKS=true selects the offline corpus provider, even if a Browserbase key is also set", () => {
    const deps = createResearchDeps(config({ USE_MOCKS: "true", BROWSERBASE_API_KEY: "test-key" }));
    expect(deps.search.kind).toBe("offline-corpus");
  });

  it("a configured Browserbase key selects the Browserbase provider", () => {
    const deps = createResearchDeps(config({ BROWSERBASE_API_KEY: "test-key" }));
    expect(deps.search.kind).toBe("browserbase");
  });

  it("no key and no mocks falls back to a provider that fails non-fatally at call time, not at construction", async () => {
    const deps = createResearchDeps(config({}));
    expect(deps.search.kind).toBe("browserbase");
    await expect(deps.search.search("query", 5)).rejects.toThrow(/BROWSERBASE_API_KEY is not set/);
    await expect(deps.fetcher.fetch("https://example.test")).rejects.toThrow(/BROWSERBASE_API_KEY is not set/);
  });
});
