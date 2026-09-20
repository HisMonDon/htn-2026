import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("traversal configuration", () => {
  it("uses deep mode and the explicit investigation limits from the environment", () => {
    const config = loadConfig({
      TRAVERSAL_MODE: "deep",
      MAX_GRAPH_DEPTH: "4",
      MAX_EXPANDED_NODES: "23",
      MAX_EDGES: "55",
      MAX_CHILDREN_PER_NODE: "6",
      MAX_RELATED_CHILDREN_PER_NODE: "4",
      MAX_PROBABLE_CHILDREN_PER_NODE: "3",
    });

    expect(config.provenanceMode).toBe("deep");
    expect(config.graphLimits).toEqual({
      maxDepth: 4,
      maxExpandedNodes: 23,
      maxEdges: 55,
      maxChildrenPerNode: 6,
      maxRelatedChildrenPerNode: 4,
      maxProbableChildrenPerNode: 3,
    });
    expect(config.semanticScholar).toEqual({ apiKey: null, maxReferences: 10, maxCitations: 10, timeoutMs: 10_000 });
  });

  it("keeps the compatible PROVENANCE_MODE fallback and strict default", () => {
    expect(loadConfig({ PROVENANCE_MODE: "exploratory" }).provenanceMode).toBe("exploratory");
    expect(loadConfig({}).provenanceMode).toBe("strict");
  });

  it("loads bounded Semantic Scholar settings without requiring an API key", () => {
    expect(loadConfig({
      SEMANTIC_SCHOLAR_API_KEY: "s2-key",
      SEMANTIC_SCHOLAR_MAX_REFERENCES: "7",
      SEMANTIC_SCHOLAR_MAX_CITATIONS: "8",
      SEMANTIC_SCHOLAR_TIMEOUT_MS: "9000",
    }).semanticScholar).toEqual({ apiKey: "s2-key", maxReferences: 7, maxCitations: 8, timeoutMs: 9000 });
    expect(loadConfig({}).semanticScholar.apiKey).toBeNull();
  });
});
