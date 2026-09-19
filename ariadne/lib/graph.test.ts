import { describe, expect, it } from "vitest";
import type { LineageTree, LineageTreeEdge, LineageTreeNode } from "./api";
import { graphLegendItems, toGraphData } from "./graph";

function node(
  id: string,
  sourceKind: LineageTreeNode["source_kind"],
  overrides: Partial<LineageTreeNode> = {}
): LineageTreeNode {
  return {
    id,
    canonical_id: id,
    content_fingerprint: id.padEnd(64, "0"),
    url: sourceKind === "submitted" ? `https://submitted.ariadne.invalid/${id}` : `https://example.com/${id}`,
    mirror_urls: [],
    publisher: sourceKind === "submitted" ? "User submission" : "Example",
    title: sourceKind === "submitted" ? "Submitted text" : `Source ${id}`,
    timestamp: sourceKind === "submitted" ? null : "2026-01-01T00:00:00Z",
    timestamp_source: sourceKind === "submitted" ? "none" : "meta",
    timestamp_confidence: sourceKind === "submitted" ? "none" : "strong",
    earliest_possible: null,
    timestamp_conflict: null,
    passage: "A matched passage.",
    outbound_links: [],
    fabricated_citations: [],
    mutations: [],
    ai_evidence: null,
    discovered_via: [sourceKind === "submitted" ? "submitted-text" : "gptzero"],
    is_seed: sourceKind === "submitted",
    source_kind: sourceKind,
    ...overrides,
  };
}

function edge(parent_id: string, child_id: string): LineageTreeEdge {
  return {
    parent_id,
    child_id,
    type: "similarity",
    confidence: 0.88,
    basis: "Source-match evidence",
    shared_mutations: [],
    claim_mutations: [],
    explicit_link: false,
    rare_shared_phrases: 2,
    similarity: 0.82,
    temporal: { parent_time: null, child_time: null, gap_days: null, ordering: "unknown" },
    alternatives: [],
  };
}

function tree(nodes: LineageTreeNode[], edges: LineageTreeEdge[]): LineageTree {
  return {
    seed: { claim: "Submitted claim", url: null, fabricated_citations: [] },
    generated_at: "2026-09-19T00:00:00Z",
    root_ids: nodes.filter((candidate) => !edges.some((item) => item.child_id === candidate.id)).map((candidate) => candidate.id),
    nodes,
    edges,
    rejected_edges: [],
    excluded: [],
    status: "complete",
    diagnostics: [],
    stats: {
      pipeline: "recursive-provenance",
      max_depth: 5,
      sources_expanded: 1,
      proposals_received: 1,
      fetched: 1,
      fetch_failures: 0,
      analysis_requests: 1,
    },
  };
}

describe("graph presentation semantics", () => {
  it("renders a fetched-to-submitted edge as a candidate match", () => {
    const data = toGraphData(tree([node("source", "fetched"), node("seed", "submitted")], [edge("source", "seed")]));

    expect(data.links[0]).toMatchObject({ backend_status: "validated", kind: "candidate_match" });
    expect(data.nodes.find((item) => item.id === "source")?.role).toBe("candidate");
    expect(graphLegendItems(data).map((item) => item.label)).toEqual(["Seed", "Candidate source"]);
  });

  it("keeps document-to-document validation solid and treats missing dates as unknown", () => {
    const unknown = node("unknown", "fetched", { timestamp: null, timestamp_source: "none", timestamp_confidence: "none" });
    const child = node("child", "fetched", { is_seed: true });
    const data = toGraphData(tree([unknown, child], [edge("unknown", "child")]));

    expect(data.links[0]?.kind).toBe("validated_provenance");
    expect(data.nodes.find((item) => item.id === "unknown")?.role).not.toBe("conflict");
    expect(graphLegendItems(data).map((item) => item.label)).toContain("Validated provenance");
    expect(graphLegendItems(data).map((item) => item.label)).not.toContain("Timestamp conflict");
  });

  it("shows timestamp conflict only when the backend supplies conflict evidence", () => {
    const conflicted = node("conflicted", "fetched", {
      timestamp: null,
      timestamp_source: "none",
      timestamp_confidence: "none",
      timestamp_conflict: "conflicting strong timestamp evidence: meta (2025-01-01), json-ld (2025-02-01)",
    });
    const data = toGraphData(tree([conflicted], []));

    expect(data.nodes[0]?.role).toBe("conflict");
    expect(graphLegendItems(data).map((item) => item.label)).toContain("Timestamp conflict");
  });
});
