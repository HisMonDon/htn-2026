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
  });

  it("keeps the compatible PROVENANCE_MODE fallback and strict default", () => {
    expect(loadConfig({ PROVENANCE_MODE: "exploratory" }).provenanceMode).toBe("exploratory");
    expect(loadConfig({}).provenanceMode).toBe("strict");
  });
});
