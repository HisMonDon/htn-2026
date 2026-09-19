import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createResearchDeps } from "./factory";
import { DirectHttpFetcher } from "./providers";

function config(env: NodeJS.ProcessEnv) {
  return loadConfig({ ...env });
}

describe("createResearchDeps provider selection", () => {
  it("USE_MOCKS=true selects the offline corpus provider", () => {
    const deps = createResearchDeps(config({ USE_MOCKS: "true", BROWSERBASE_API_KEY: "test-key" }));
    expect(deps.search.kind).toBe("offline-corpus");
  });

  it("does not configure Browserbase as a research fallback resolver", () => {
    const deps = createResearchDeps(config({ BROWSERBASE_API_KEY: "test-key" }));
    expect(deps.search.kind).toBe("unconfigured");
    expect(deps.fetcher).toBeInstanceOf(DirectHttpFetcher);
    expect(deps.resolver).toBeUndefined();
  });

  it("keeps direct URL fetching available without a paid fallback-search credential", async () => {
    const deps = createResearchDeps(config({}));
    expect(deps.search.kind).toBe("unconfigured");
    expect(deps.fetcher).toBeInstanceOf(DirectHttpFetcher);
    expect(deps.resolver).toBeUndefined();
    await expect(deps.search.search("query", 5)).rejects.toThrow(/No fallback source resolver is configured/);
    await expect(deps.fetcher.fetch("not a URL")).resolves.toBeNull();
  });
});
