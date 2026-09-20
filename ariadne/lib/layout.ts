/**
 * Deterministic layered layout for the provenance graph.
 *
 * Provenance direction is authoritative: x comes from topological depth over accepted edges,
 * so a child is never drawn left of its parent, whatever its timestamp claims. Timestamps only
 * break ties vertically inside a layer. Pure and React-free so it can be exercised directly.
 */

import { endpointId, type GraphLink, type GraphNode, type ProvenanceStatus } from "./graph";

export interface Point {
  x: number;
  y: number;
}

/** Horizontal distance between depth layers. */
export const LAYER_GAP = 310;
/** Vertical distance between nodes sharing a layer. */
export const NODE_GAP = 122;
/** Vertical gutter between separate root subtrees / disconnected nodes. */
export const COMPONENT_GAP = 190;

/**
 * Layout priority for picking a node's single primary parent, per the product spec:
 * validated > probable > citation/reference (explicit direction) > related > candidate.
 * Lower number wins. Anything unrecognized sorts after candidate so it never outranks a
 * real status.
 */
const STATUS_PRIORITY: Record<ProvenanceStatus, number> = {
  validated: 0,
  probable: 1,
  citation: 2,
  related: 3,
  candidate: 4,
};

export function statusPriority(status: string | undefined): number {
  if (status && status in STATUS_PRIORITY) return STATUS_PRIORITY[status as ProvenanceStatus];
  return Object.keys(STATUS_PRIORITY).length;
}

/** Minimal node shape the layout needs; GraphNode satisfies it. */
export type LayoutNode = Pick<GraphNode, "id" | "title" | "publisher" | "timestamp" | "timestamp_conflict"> &
  Partial<Pick<GraphNode, "is_root" | "is_seed">>;

/** Minimal link shape the layout needs; GraphLink satisfies it. */
export type LayoutLink = Pick<GraphLink, "parent_id" | "child_id"> &
  Partial<Pick<GraphLink, "source" | "target" | "confidence" | "provenance_status">>;

interface Edge {
  parent: string;
  child: string;
}

/**
 * A node's timestamp is only usable for ordering when it parses and the backend did not flag a
 * conflict on it. Conflicted nodes fall back to title/id ordering and keep their amber role.
 */
function sortTime(node: LayoutNode): number | null {
  if (node.timestamp_conflict) return null;
  if (!node.timestamp) return null;
  const parsed = Date.parse(node.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function labelOf(node: LayoutNode): string {
  return (node.title || node.publisher || node.id).toLowerCase();
}

/** Resolve endpoints tolerantly: the force simulation may have swapped ids for node objects. */
function edgesOf(links: readonly LayoutLink[], ids: ReadonlySet<string>): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const link of links) {
    const parent = endpointId(link.source) ?? link.parent_id;
    const child = endpointId(link.target) ?? link.child_id;
    if (!parent || !child || parent === child) continue;
    if (!ids.has(parent) || !ids.has(child)) continue;
    const key = `${parent} ${child}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ parent, child });
  }
  return edges;
}

/**
 * Longest-path depth over every edge, primary and secondary alike. Not used for final layout
 * (that comes only from primary parents), only as a deterministic tie-breaker below: between two
 * otherwise-equal candidate parents, prefer the one already further along its own chain so a
 * child never lands on the same layer as one of its own parents.
 */
function structuralDepths(ids: readonly string[], edges: readonly Edge[]): Map<string, number> {
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const { parent, child } of edges) {
    children.get(parent)!.push(child);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }
  for (const list of children.values()) list.sort();

  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  const resolved = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    resolved.add(id);
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1));
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  const stranded = ids.filter((id) => !resolved.has(id));
  if (stranded.length > 0) {
    let deepest = 0;
    for (const id of resolved) deepest = Math.max(deepest, depth.get(id) ?? 0);
    for (const id of stranded) depth.set(id, deepest + 1);
  }
  return depth;
}

/**
 * Picks at most one primary parent per node — a pure layout concept, not a mutation of the
 * underlying graph. Every other incoming/outgoing edge stays in `links` untouched and is
 * rendered as a secondary crosslink (see GraphVisualizer's primary/secondary edge styling).
 *
 * Selection order, most to least preferred:
 *   1. Provenance status strength: validated > probable > citation > related > candidate.
 *   2. Higher confidence (Ariadne's own evidence score, never provider/search ranking).
 *   3. Earlier trustworthy parent timestamp (chronology).
 *   4. Parent already deeper in the overall DAG (keeps a child off the same layer as its own parent).
 *   5. Lexicographically smaller parent id, for a total deterministic order.
 *
 * If following chosen primary parents would form a cycle (possible once related/candidate
 * crosslinks are in the running), the cycle is broken deterministically by promoting one node
 * in it back to a root; the edge that would have closed the loop simply stays secondary.
 */
export function computePrimaryParents(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[]
): Map<string, string | null> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set(byId.keys());
  const structural = structuralDepths([...ids], edgesOf(links, ids));

  const candidatesByChild = new Map<string, { parent: string; status?: string; confidence: number }[]>();
  const seen = new Set<string>();
  for (const link of links) {
    const parent = endpointId(link.source) ?? link.parent_id;
    const child = endpointId(link.target) ?? link.child_id;
    if (!parent || !child || parent === child) continue;
    if (!ids.has(parent) || !ids.has(child)) continue;
    const key = `${parent} -> ${child}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = candidatesByChild.get(child) ?? [];
    list.push({ parent, status: link.provenance_status, confidence: link.confidence ?? 0 });
    candidatesByChild.set(child, list);
  }

  const primary = new Map<string, string | null>([...ids].map((id) => [id, null]));
  for (const [child, candidates] of candidatesByChild) {
    candidates.sort((a, b) => {
      const priorityDiff = statusPriority(a.status) - statusPriority(b.status);
      if (priorityDiff !== 0) return priorityDiff;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      const timeA = sortTime(byId.get(a.parent)!);
      const timeB = sortTime(byId.get(b.parent)!);
      if (timeA !== null && timeB !== null && timeA !== timeB) return timeA - timeB;
      if (timeA !== null && timeB === null) return -1;
      if (timeA === null && timeB !== null) return 1;
      const depthDiff = (structural.get(b.parent) ?? 0) - (structural.get(a.parent) ?? 0);
      if (depthDiff !== 0) return depthDiff;
      return a.parent.localeCompare(b.parent);
    });
    primary.set(child, candidates[0]!.parent);
  }

  // Break cycles deterministically: walk each node's primary-parent chain; if it loops back on
  // itself, demote the lexicographically smallest id in the loop back to a root.
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of [...ids].sort()) {
    if (state.get(start) === 2) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && state.get(current) !== 2) {
      if (state.get(current) === 1) {
        const cycleStart = path.indexOf(current);
        const cycle = path.slice(cycleStart);
        const breakAt = [...cycle].sort()[0]!;
        primary.set(breakAt, null);
        break;
      }
      state.set(current, 1);
      path.push(current);
      current = primary.get(current) ?? null;
    }
    for (const id of path) state.set(id, 2);
  }

  return primary;
}

/** Depth is strictly the primary-parent tree's generation: roots are 0, everyone else is their primary parent's depth + 1. */
function computeDepthsFromPrimary(ids: readonly string[], primary: ReadonlyMap<string, string | null>): Map<string, number> {
  const childrenOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  const roots: string[] = [];
  for (const id of ids) {
    const parent = primary.get(id) ?? null;
    if (parent === null) roots.push(id);
    else childrenOf.get(parent)!.push(id);
  }
  for (const list of childrenOf.values()) list.sort();

  const depth = new Map<string, number>();
  const queue = [...roots].sort();
  for (const id of queue) depth.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const child of childrenOf.get(id) ?? []) {
      if (depth.has(child)) continue;
      depth.set(child, depth.get(id)! + 1);
      queue.push(child);
    }
  }

  // Should not happen once cycles are broken above, but stay total just in case.
  const stray = ids.filter((id) => !depth.has(id));
  if (stray.length > 0) {
    const deepest = Math.max(0, ...[...depth.values()]);
    for (const id of stray) depth.set(id, deepest + 1);
  }
  return depth;
}

/** Weakly connected components, so separate root subtrees get their own horizontal band. */
function components(ids: readonly string[], edges: readonly Edge[]): string[][] {
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { parent, child } of edges) {
    neighbours.get(parent)!.push(child);
    neighbours.get(child)!.push(parent);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const start of [...ids].sort()) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    seen.add(start);
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head]!;
      group.push(id);
      for (const next of (neighbours.get(id) ?? []).slice().sort()) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    groups.push(group.sort());
  }
  // Largest lineage first; lone discovered pages end up below it. Ties break on id for stability.
  return groups.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

/**
 * Assigns every node a fixed position. Same input always yields the same output — no randomness,
 * no dependence on iteration order of the caller's arrays.
 */
export function computeProvenanceLayout(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[]
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = [...byId.keys()];
  const edges = edgesOf(links, new Set(ids));
  // Depth comes only from each node's single primary parent (req. 2/3): a node is never drawn
  // deeper because of a secondary crosslink, so multi-parent convergence (several sources into
  // one later document) draws as a coherent converging structure instead of a star.
  const primaryParents = computePrimaryParents(nodes, links);
  const depth = computeDepthsFromPrimary(ids, primaryParents);

  const parentsOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { parent, child } of edges) parentsOf.get(child)!.push(parent);

  let bandTop = 0;
  for (const group of components(ids, edges)) {
    const layers = new Map<number, string[]>();
    for (const id of group) {
      const layer = depth.get(id) ?? 0;
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer)!.push(id);
    }

    const tallest = Math.max(...[...layers.values()].map((layer) => layer.length));
    const bandHeight = (tallest - 1) * NODE_GAP;

    for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
      const members = layers.get(layer)!;
      members.sort((a, b) => {
        const nodeA = byId.get(a)!;
        const nodeB = byId.get(b)!;

        // 1. Sit near your parents, to keep branches from crossing.
        const barycentre = (id: string) => {
          const placed = (parentsOf.get(id) ?? []).map((p) => positions.get(p)?.y).filter((y) => y !== undefined);
          return placed.length === 0 ? null : placed.reduce((sum, y) => sum + y!, 0) / placed.length;
        };
        const byA = barycentre(a);
        const byB = barycentre(b);
        if (byA !== null && byB !== null && byA !== byB) return byA - byB;
        if (byA === null && byB !== null) return -1;
        if (byA !== null && byB === null) return 1;

        // 2. Roots and seeds lead their layer.
        const rank = (node: LayoutNode) => (node.is_seed ? 0 : node.is_root ? 1 : 2);
        if (rank(nodeA) !== rank(nodeB)) return rank(nodeA) - rank(nodeB);

        // 3. Earlier trustworthy timestamp, then label, then id — all deterministic.
        const timeA = sortTime(nodeA);
        const timeB = sortTime(nodeB);
        if (timeA !== null && timeB !== null && timeA !== timeB) return timeA - timeB;
        if (timeA !== null && timeB === null) return -1;
        if (timeA === null && timeB !== null) return 1;

        const labelDiff = labelOf(nodeA).localeCompare(labelOf(nodeB));
        return labelDiff !== 0 ? labelDiff : a.localeCompare(b);
      });

      const span = (members.length - 1) * NODE_GAP;
      members.forEach((id, index) => {
        positions.set(id, {
          x: layer * LAYER_GAP,
          y: bandTop + (bandHeight - span) / 2 + index * NODE_GAP,
        });
      });
    }

    bandTop += bandHeight + COMPONENT_GAP;
  }

  // Centre the whole drawing on the origin so the initial viewport is balanced.
  const points = [...positions.values()];
  const midX = (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2;
  const midY = (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
  for (const [id, point] of positions) positions.set(id, { x: point.x - midX, y: point.y - midY });

  return positions;
}
