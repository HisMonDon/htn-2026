import { describe, expect, it } from "vitest";
import { computePrimaryParents, computeProvenanceLayout, LAYER_GAP, statusPriority, type LayoutLink, type LayoutNode } from "./layout";

const node = (id: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({
  id,
  title: `Title ${id}`,
  publisher: `pub-${id}`,
  timestamp: null,
  timestamp_conflict: null,
  ...extra,
});

const edge = (parent_id: string, child_id: string): LayoutLink => ({ parent_id, child_id });

describe("computeProvenanceLayout", () => {
  it("lays a chain out left to right, one layer per hop", () => {
    const at = computeProvenanceLayout([node("A"), node("B"), node("C")], [edge("A", "B"), edge("B", "C")]);
    expect(at.get("A")!.x).toBeLessThan(at.get("B")!.x);
    expect(at.get("B")!.x).toBeLessThan(at.get("C")!.x);
    expect(at.get("B")!.x - at.get("A")!.x).toBe(LAYER_GAP);
  });

  it("separates siblings vertically at a shared depth", () => {
    const at = computeProvenanceLayout([node("A"), node("B"), node("C")], [edge("A", "B"), edge("A", "C")]);
    expect(at.get("B")!.x).toBe(at.get("C")!.x);
    expect(at.get("B")!.x).toBeGreaterThan(at.get("A")!.x);
    expect(at.get("B")!.y).not.toBe(at.get("C")!.y);
  });

  it("places a merge point past every parent", () => {
    const at = computeProvenanceLayout([node("A"), node("B"), node("C")], [edge("A", "C"), edge("B", "C")]);
    expect(at.get("C")!.x).toBeGreaterThan(at.get("A")!.x);
    expect(at.get("C")!.x).toBeGreaterThan(at.get("B")!.x);
    expect(at.get("A")!.x).toBe(at.get("B")!.x);
  });

  it("uses the longest path for depth", () => {
    const at = computeProvenanceLayout(
      [node("A"), node("B"), node("C")],
      [edge("A", "B"), edge("B", "C"), edge("A", "C")]
    );
    expect(at.get("C")!.x).toBeGreaterThan(at.get("B")!.x);
  });

  it("gives each root subtree its own horizontal band", () => {
    const at = computeProvenanceLayout(
      [node("A", { is_root: true }), node("B", { is_root: true }), node("C"), node("D")],
      [edge("A", "C"), edge("B", "D")]
    );
    const first = new Set([at.get("A")!.y, at.get("C")!.y]);
    const second = [at.get("B")!.y, at.get("D")!.y];
    expect(second.some((y) => first.has(y))).toBe(false);
    expect(at.get("C")!.x).toBeGreaterThan(at.get("A")!.x);
    expect(at.get("D")!.x).toBeGreaterThan(at.get("B")!.x);
  });

  it("keeps disconnected nodes, below the main lineage", () => {
    const at = computeProvenanceLayout([node("A"), node("B"), node("LONE")], [edge("A", "B")]);
    expect(at.has("LONE")).toBe(true);
    expect(at.get("LONE")!.y).toBeGreaterThan(Math.max(at.get("A")!.y, at.get("B")!.y));
  });

  it("survives missing timestamps", () => {
    const at = computeProvenanceLayout([node("A"), node("B")], [edge("A", "B")]);
    expect([...at.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it("never lets a conflicting timestamp invert provenance direction", () => {
    const parent = node("P", { timestamp: "2026-05-01T00:00:00Z" });
    const child = node("K", { timestamp: "2020-01-01T00:00:00Z", timestamp_conflict: "links to a later document" });
    const at = computeProvenanceLayout([parent, child], [edge("P", "K")]);
    expect(at.get("K")!.x).toBeGreaterThan(at.get("P")!.x);
  });

  it("orders siblings by trustworthy timestamp", () => {
    const at = computeProvenanceLayout(
      [
        node("A"),
        node("late", { timestamp: "2026-03-01T00:00:00Z" }),
        node("early", { timestamp: "2026-01-01T00:00:00Z" }),
      ],
      [edge("A", "late"), edge("A", "early")]
    );
    expect(at.get("early")!.y).toBeLessThan(at.get("late")!.y);
  });

  it("terminates on a cycle and still places every node", () => {
    const at = computeProvenanceLayout(
      [node("A"), node("B"), node("C")],
      [edge("A", "B"), edge("B", "C"), edge("C", "B")]
    );
    expect(at.size).toBe(3);
  });

  it("resolves endpoints the simulation already replaced with node objects", () => {
    const nodes = [node("A"), node("B")];
    const links: LayoutLink[] = [
      { parent_id: "A", child_id: "B", source: nodes[0] as never, target: nodes[1] as never },
    ];
    expect(computeProvenanceLayout(nodes, links).get("B")!.x).toBeGreaterThan(
      computeProvenanceLayout(nodes, links).get("A")!.x
    );
  });

  it("is deterministic regardless of input order", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const links = [edge("A", "B"), edge("A", "C"), edge("C", "D")];
    const forward = [...computeProvenanceLayout(nodes, links).entries()].sort();
    const reversed = [...computeProvenanceLayout([...nodes].reverse(), [...links].reverse()).entries()].sort();
    expect(reversed).toEqual(forward);
  });

  it("handles an empty graph", () => {
    expect(computeProvenanceLayout([], []).size).toBe(0);
  });

  it("draws a multi-source convergence as a coherent tree, not a star", () => {
    // Source A, Source B -> Article C -> Article D -> Submitted claim (task fixture shape).
    const at = computeProvenanceLayout(
      [node("A"), node("B"), node("C"), node("D"), node("claim")],
      [edge("A", "C"), edge("B", "C"), edge("C", "D"), edge("D", "claim")]
    );
    expect(at.get("A")!.x).toBe(at.get("B")!.x);
    expect(at.get("C")!.x).toBeGreaterThan(at.get("A")!.x);
    expect(at.get("D")!.x).toBeGreaterThan(at.get("C")!.x);
    expect(at.get("claim")!.x).toBeGreaterThan(at.get("D")!.x);
    // No stray vertical scatter: A and B are the only two nodes sharing a layer.
    const layerXs = new Set([...at.values()].map((p) => p.x));
    expect(layerXs.size).toBe(4);
  });
});

describe("statusPriority", () => {
  it("ranks provenance strength validated > probable > citation > related > candidate", () => {
    expect(statusPriority("validated")).toBeLessThan(statusPriority("probable"));
    expect(statusPriority("probable")).toBeLessThan(statusPriority("citation"));
    expect(statusPriority("citation")).toBeLessThan(statusPriority("related"));
    expect(statusPriority("related")).toBeLessThan(statusPriority("candidate"));
  });

  it("puts an unrecognized status behind every known one", () => {
    expect(statusPriority("unknown-status")).toBeGreaterThan(statusPriority("candidate"));
    expect(statusPriority(undefined)).toBeGreaterThan(statusPriority("candidate"));
  });
});

describe("computePrimaryParents", () => {
  const weighted = (parent_id: string, child_id: string, extra: Partial<LayoutLink> = {}): LayoutLink => ({
    parent_id,
    child_id,
    confidence: 0.5,
    ...extra,
  });

  it("picks the higher-priority status when parents tie otherwise", () => {
    const nodes = [node("weak"), node("strong"), node("child")];
    const links = [
      weighted("weak", "child", { provenance_status: "related", confidence: 0.9 }),
      weighted("strong", "child", { provenance_status: "validated", confidence: 0.1 }),
    ];
    const primary = computePrimaryParents(nodes, links);
    expect(primary.get("child")).toBe("strong");
  });

  it("falls back to confidence when status ties", () => {
    const nodes = [node("low"), node("high"), node("child")];
    const links = [
      weighted("low", "child", { provenance_status: "validated", confidence: 0.2 }),
      weighted("high", "child", { provenance_status: "validated", confidence: 0.8 }),
    ];
    const primary = computePrimaryParents(nodes, links);
    expect(primary.get("child")).toBe("high");
  });

  it("keeps every accepted edge as data even though only one parent is chosen for layout", () => {
    const nodes = [node("A"), node("B"), node("child")];
    const links = [
      weighted("A", "child", { provenance_status: "validated" }),
      weighted("B", "child", { provenance_status: "related" }),
    ];
    const primary = computePrimaryParents(nodes, links);
    // Only one primary parent for layout, but both source edges were supplied and neither was
    // mutated or dropped — this function only picks a favourite, it never deletes an edge.
    expect(primary.get("child")).toBe("A");
    expect(links).toHaveLength(2);
  });

  it("is deterministic across repeated calls and independent of input order", () => {
    const nodes = [node("A"), node("B"), node("child")];
    const links = [
      weighted("A", "child", { provenance_status: "validated" }),
      weighted("B", "child", { provenance_status: "validated" }),
    ];
    const forward = computePrimaryParents(nodes, links);
    const reversed = computePrimaryParents([...nodes].reverse(), [...links].reverse());
    expect(forward.get("child")).toBe(reversed.get("child"));
    expect(computePrimaryParents(nodes, links).get("child")).toBe(forward.get("child"));
  });

  it("never leaves a cycle in the chosen primary-parent structure", () => {
    const nodes = [node("A"), node("B")];
    const links = [weighted("A", "B"), weighted("B", "A")];
    const primary = computePrimaryParents(nodes, links);
    // Follow each node's primary-parent chain; it must terminate at null, never loop.
    for (const start of ["A", "B"]) {
      const seen = new Set<string>();
      let current: string | null = start;
      while (current !== null) {
        expect(seen.has(current)).toBe(false);
        seen.add(current);
        current = primary.get(current) ?? null;
      }
    }
  });

  it("gives roots (no incoming edges) a null primary parent", () => {
    const nodes = [node("root"), node("child")];
    const links = [weighted("root", "child")];
    const primary = computePrimaryParents(nodes, links);
    expect(primary.get("root")).toBeNull();
    expect(primary.get("child")).toBe("root");
  });
});
