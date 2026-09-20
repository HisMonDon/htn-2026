import { describe, expect, it } from "vitest";
import { toGraphData } from "./graph";
import { isQuantizationDemoQuery, QUANTIZATION_DEMO, QUANTIZATION_DEMO_TRIGGER } from "./quantization-demo";

describe("quantization chimera demo", () => {
  it("activates only for the documented sentence, ignoring case and terminal punctuation", () => {
    expect(isQuantizationDemoQuery(QUANTIZATION_DEMO_TRIGGER)).toBe(true);
    expect(isQuantizationDemoQuery("BINARIZED NEURAL NETWORKS!")).toBe(true);
    expect(isQuantizationDemoQuery("binarized neural networks please")).toBe(false);
  });

  it("builds three real-source streams that converge into one malformed citation", () => {
    const { tree, edges } = QUANTIZATION_DEMO;
    expect(tree.root_ids).toEqual([
      "binarized-neural-networks-2016",
      "quantizing-deep-convolutional-networks-2018",
      "weakly-isolated-horizons-2016",
    ]);

    expect(tree.edges.filter((edge) => edge.child_id === "merged-citation-2021").map((edge) => edge.parent_id).sort())
      .toEqual(["author-cache-2018", "title-survey-2019"]);
    expect(tree.edges.filter((edge) => edge.child_id === "malformed-bibtex-2022").map((edge) => edge.parent_id).sort())
      .toEqual(["merged-citation-2021", "weakly-isolated-horizons-2016"]);
    expect(tree.rejected_edges[0]).toMatchObject({
      parent_id: "merged-citation-2021",
      child_id: "Efficient Integer Quantization Survey",
      confidence: 0.2,
    });
    expect(tree.rejected_edges[0]?.reason).toContain("no matching identifier");

    const graph = toGraphData(tree, edges);
    expect(graph.links.find((edge) => edge.child_id === "neurips-paper-2025")).toMatchObject({
      confidence: 1,
      provenance_status: "validated",
    });
  });
});
