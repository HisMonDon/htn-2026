import { describe, expect, it } from "vitest";
import { computeProvenanceLayout, LAYER_GAP, type LayoutLink, type LayoutNode } from "./layout";

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
});
