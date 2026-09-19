/**
 * Adapts the backend's LineageTree into the `{ nodes, links }` shape react-force-graph-2d
 * wants. Frontend-only: the backend response is never mutated, and every backend field is
 * carried through so later UI work can inspect the full evidence.
 */

import type {
  ExcludedCandidate,
  LineageTree,
  LineageTreeEdge,
  LineageTreeNode,
  RejectedEdge,
} from "./api";

/** How a node is drawn. Provenance role only — this is not a truth classification. */
export type NodeRole = "seed" | "root" | "conflict" | "discovered";

export interface GraphNode extends LineageTreeNode {
  /** Listed in `tree.root_ids` — the top of a reconstructed propagation chain. */
  is_root: boolean;
  role: NodeRole;
  /** Written by the force simulation at runtime. */
  x?: number;
  y?: number;
  /** Pinned by the deterministic provenance layout (see lib/layout.ts). */
  fx?: number;
  fy?: number;
}

export interface GraphLink extends LineageTreeEdge {
  /**
   * parent_id — provenance flows source -> target. Set as an id; the force simulation
   * swaps in the node object once laid out, so read it through `endpointId()`.
   */
  source: string | GraphNode;
  /** child_id — see `source`. */
  target: string | GraphNode;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  /**
   * Relationships that were scored but not accepted. Deliberately absent from `links`:
   * the graph shows accepted provenance only. Surfaced in the rejected-evidence panel.
   */
  rejectedEdges: RejectedEdge[];
  /** Pages discovered during research but left out of this lineage, with the backend's reason. */
  excludedCandidates: ExcludedCandidate[];
}

/** Provenance role, not a truth judgement: nothing here says "fake" or "human-written". */
export const ROLE_COLOR: Record<NodeRole, string> = {
  seed: "#60a5fa", // blue - the claim we started from
  root: "#a78bfa", // violet - origin of a reconstructed chain
  conflict: "#f59e0b", // amber - its dates do not add up
  discovered: "#94a3b8", // slate - ordinary discovered document
};

export const ROLE_LABEL: Record<NodeRole, string> = {
  seed: "Seed",
  root: "Chain root",
  conflict: "Timestamp conflict",
  discovered: "Discovered",
};

/**
 * A node's role drives its colour. Conflict wins over root so a dated-inconsistent node is
 * never silently painted as a clean origin; size still marks roots (see GraphVisualizer).
 */
function roleOf(node: LineageTreeNode, isRoot: boolean): NodeRole {
  if (node.timestamp_conflict) return "conflict";
  if (node.is_seed) return "seed";
  if (isRoot) return "root";
  return "discovered";
}

export function toGraphData(tree: LineageTree): GraphData {
  const rootIds = new Set(tree.root_ids);

  const nodes: GraphNode[] = tree.nodes.map((node) => {
    const is_root = rootIds.has(node.id);
    // Shallow copy: the force simulation writes x/y/vx/vy onto whatever it is handed.
    return { ...node, is_root, role: roleOf(node, is_root) };
  });

  const known = new Set(nodes.map((node) => node.id));

  // Accepted edges only. `tree.rejected_edges` stays out of the provenance graph.
  const links: GraphLink[] = tree.edges
    .filter((edge) => known.has(edge.parent_id) && known.has(edge.child_id))
    .map((edge) => ({ ...edge, source: edge.parent_id, target: edge.child_id }));

  return { nodes, links, rejectedEdges: tree.rejected_edges, excludedCandidates: tree.excluded };
}

/** Tolerates force-graph swapping link endpoints from ids to node objects after layout. */
export function endpointId(endpoint: GraphLink["source"] | GraphNode | undefined): string | null {
  if (typeof endpoint === "string") return endpoint;
  if (endpoint && typeof endpoint === "object" && "id" in endpoint) return endpoint.id;
  return null;
}
