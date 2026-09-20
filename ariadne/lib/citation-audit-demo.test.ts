import { describe, expect, it } from "vitest";
import { toGraphData } from "./graph";
import { CITATION_AUDIT_DEMO, CITATION_AUDIT_DEMO_TRIGGER, isCitationAuditDemoQuery } from "./citation-audit-demo";

describe("citation audit demo", () => {
  it("activates only for the documented sentence, ignoring case and terminal punctuation", () => {
    expect(isCitationAuditDemoQuery(CITATION_AUDIT_DEMO_TRIGGER)).toBe(true);
    expect(isCitationAuditDemoQuery("MEMORY-AUGMENTED POTENTIAL FIELD THEORY!")).toBe(true);
    expect(isCitationAuditDemoQuery("memory-augmented potential field theory please")).toBe(false);
  });

  it("builds a seed paper whose citations are checked against a citation graph, not scored by similarity", () => {
    const { tree, edges } = CITATION_AUDIT_DEMO;
    expect(tree.root_ids).toEqual(["memory-augmented-potential-field-theory"]);

    const seed = tree.nodes.find((node) => node.id === "memory-augmented-potential-field-theory");
    expect(seed?.is_seed).toBe(true);

    const graph = toGraphData(tree, edges);
    for (const link of graph.links) {
      expect(link.provenance_status).toBe("citation");
    }
  });

  it("carries reviewer verdicts on flagged citations in fabricated_citations, and leaves clean ones empty", () => {
    const { tree } = CITATION_AUDIT_DEMO;
    const byId = new Map(tree.nodes.map((node) => [node.id, node]));

    expect(byId.get("mosek-optimizer-api-2019")?.fabricated_citations).toEqual(
      expect.arrayContaining([expect.stringContaining("Source is not found")])
    );
    expect(byId.get("tube-mppi-covariance-steering-2022")?.fabricated_citations).toEqual([]);
    expect(byId.get("voltage-source-converters-inertia-2020")?.fabricated_citations).toEqual([]);
  });

  it("nests the benchmark-model paper's own references two hops from the seed", () => {
    const { tree, edges } = CITATION_AUDIT_DEMO;
    const graph = toGraphData(tree, edges);
    const secondHop = graph.links
      .filter((link) => link.parent_id === "benchmark-model-power-system-2020")
      .map((link) => link.child_id)
      .sort();
    expect(secondHop).toEqual([
      "aemo-black-system-report-2016",
      "irena-renewable-energy-prospects-2018",
      "mosek-optimizer-api-2019",
      "westinghouse-frequency-oscillations-1982",
    ]);
  });
});
