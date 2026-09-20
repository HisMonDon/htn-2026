import { describe, expect, it } from "vitest";
import type { BackendEdge, LineageTree, LineageTreeEdge, LineageTreeNode } from "./api";
import { candidateStrength, graphLegendItems, toGraphData } from "./graph";

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

describe("candidate matches carried only by the backend response", () => {
  const candidate = (source: string | null, target: string): BackendEdge => ({
    id: `${source}-${target}`, source, target, reference_url: source ? `https://example.com/${source}` : null, status: "candidate", reason: "Awaiting validation",
  }) as BackendEdge;

  it("draws a fetched source matched to the submitted text even though no validated edge touches it", () => {
    const seed = node("seed", "submitted");
    const source = node("source", "fetched");
    // The compatibility tree holds only the submitted text; the source exists only in the full node list.
    const data = toGraphData(tree([seed], []), [candidate("source", "seed")], [seed, source]);

    expect(data.nodes.map((item) => item.id)).toEqual(["seed", "source"]);
    expect(data.nodes.find((item) => item.id === "source")?.role).toBe("candidate");
    expect(data.links).toHaveLength(1);
    expect(data.links[0]).toMatchObject({ source: "source", target: "seed", kind: "candidate_match", backend_status: "candidate" });
    expect(data.links[0]?.basis).toMatch(/not validated provenance/);
    expect(graphLegendItems(data).map((item) => item.label)).toEqual(["Seed", "Candidate source"]);
  });

  it("shows a real, non-zero match strength: the share of the claim's distinctive words the source repeats", () => {
    const seed = node("seed", "submitted");
    const claim = "Second Circuit decisions granted early termination of supervised release";
    const base = tree([seed], []);
    base.seed.claim = claim;
    const strong = node("strong", "fetched", { title: "Early termination", passage: "The Second Circuit granted early termination of supervised release in these decisions." });
    const weak = node("weak", "fetched", { title: "Gardening", passage: "Tomatoes need water. Supervised release is unrelated here." });
    const none = node("none", "fetched", { title: "Nothing", passage: "Completely different subject matter." });
    const data = toGraphData(base, [candidate("strong", "seed"), candidate("weak", "seed"), candidate("none", "seed")], [seed, strong, weak, none]);
    const strength = (id: string) => data.links.find((link) => link.source === id)!.confidence;

    expect(strength("strong")).toBeGreaterThan(0.8);
    expect(strength("weak")).toBeGreaterThan(0);
    expect(strength("weak")).toBeLessThan(strength("strong"));
    expect(strength("none")).toBe(0);
    expect(candidateStrength(claim, "")).toBe(0);
    expect(data.links.find((link) => link.source === "strong")?.basis).toMatch(/\d+% of the submitted text/);
  });

  it("never presents a candidate match as validated provenance", () => {
    const seed = node("seed", "submitted");
    const data = toGraphData(tree([seed], []), [candidate("source", "seed")], [seed, node("source", "fetched")]);

    expect(data.links.some((link) => link.kind === "validated_provenance")).toBe(false);
    expect(graphLegendItems(data).map((item) => item.label)).not.toContain("Validated provenance");
  });

  it("removes a promoted source from the excluded list, and keeps genuinely excluded pages there", () => {
    const seed = node("seed", "submitted");
    const base = tree([seed], []);
    base.excluded = [
      { id: "source", url: "https://example.com/source", reason: "No validated edge connects this source to the seed." },
      { id: "noise", url: "https://example.com/noise", reason: "No validated edge connects this source to the seed." },
    ];
    const data = toGraphData(base, [candidate("source", "seed")], [seed, node("source", "fetched"), node("noise", "fetched")]);

    expect(data.excludedCandidates.map((item) => item.id)).toEqual(["noise"]);
    expect(data.nodes.map((item) => item.id)).not.toContain("noise");
  });

  it("ignores unresolved candidates (no source yet), unknown documents, and duplicate matches", () => {
    const seed = node("seed", "submitted");
    const source = node("source", "fetched");
    const data = toGraphData(
      tree([seed], []),
      [candidate(null, "seed"), candidate("ghost", "seed"), candidate("source", "seed"), candidate("source", "seed")],
      [seed, source],
    );

    expect(data.nodes.map((item) => item.id)).toEqual(["seed", "source"]);
    expect(data.links).toHaveLength(1);
  });

  it("leaves a source that already has validated edges alone (no duplicate node)", () => {
    const seed = node("seed", "submitted");
    const source = node("source", "fetched");
    const upstream = node("upstream", "fetched");
    const data = toGraphData(tree([seed, source, upstream], [edge("upstream", "source")]), [candidate("source", "seed")], [seed, source, upstream]);

    expect(data.nodes.filter((item) => item.id === "source")).toHaveLength(1);
    expect(data.links.map((link) => link.kind).sort()).toEqual(["candidate_match", "validated_provenance"]);
  });
});
