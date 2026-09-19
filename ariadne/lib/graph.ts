/**
 * Adapts the backend's LineageTree into the `{ nodes, links }` shape react-force-graph-2d
 * wants. Frontend-only: the backend response is never mutated, and every backend field is
 * carried through so later UI work can inspect the full evidence.
 */

import type {
  BackendEdge,
  ExcludedCandidate,
  LineageTree,
  LineageTreeEdge,
  LineageTreeNode,
  RejectedEdge,
} from "./api";

/** How a node is drawn. Provenance role only — this is not a truth classification. */
export type NodeRole = "seed" | "candidate" | "root" | "conflict" | "discovered";
export type EdgeKind = "candidate_match" | "validated_provenance";

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
  /** The accepted compatibility-tree edge's state in the backend response. */
  backend_status: "validated";
  /** Presentation semantics derived from the backend node kind, never a validation result. */
  kind: EdgeKind;
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

export interface GraphLegendItem {
  label: "Seed" | "Candidate source" | "Validated provenance" | "Timestamp conflict" | "Rejected";
  mark: "seed" | "candidate" | "validated" | "conflict" | "rejected";
}

/** Provenance role, not a truth judgement: nothing here says "fake" or "human-written". */
export const ROLE_COLOR: Record<NodeRole, string> = {
  seed: "#60a5fa", // blue - the claim we started from
  candidate: "#7dd3fc", // cyan - fetched source matched to submitted text
  root: "#a78bfa", // violet - origin of a reconstructed chain
  conflict: "#f59e0b", // amber - its dates do not add up
  discovered: "#94a3b8", // slate - ordinary discovered document
};

export const ROLE_LABEL: Record<NodeRole, string> = {
  seed: "Seed",
  candidate: "Candidate source",
  root: "Chain root",
  conflict: "Timestamp conflict",
  discovered: "Discovered",
};

/** Legend entries are data-driven so the UI never advertises an absent state. */
export function graphLegendItems(data: GraphData): GraphLegendItem[] {
  const items: GraphLegendItem[] = [];
  if (data.nodes.some((node) => node.is_seed)) items.push({ label: "Seed", mark: "seed" });
  if (data.links.some((link) => link.kind === "candidate_match")) {
    items.push({ label: "Candidate source", mark: "candidate" });
  }
  if (data.links.some((link) => link.kind === "validated_provenance")) {
    items.push({ label: "Validated provenance", mark: "validated" });
  }
  if (data.nodes.some((node) => node.role === "conflict")) {
    items.push({ label: "Timestamp conflict", mark: "conflict" });
  }
  if (data.rejectedEdges.length > 0) items.push({ label: "Rejected", mark: "rejected" });
  return items;
}

/**
 * A node's role drives its colour. Conflict wins over root so a dated-inconsistent node is
 * never silently painted as a clean origin; size still marks roots (see GraphVisualizer).
 */
export function hasTimestampConflict(node: Pick<LineageTreeNode, "timestamp_conflict">): boolean {
  return Boolean(node.timestamp_conflict?.trim());
}

export function isSubmittedNode(node: Pick<LineageTreeNode, "source_kind">): boolean {
  return node.source_kind === "submitted";
}

function roleOf(node: LineageTreeNode, isRoot: boolean, isCandidate: boolean): NodeRole {
  if (hasTimestampConflict(node)) return "conflict";
  if (node.is_seed) return "seed";
  if (isCandidate) return "candidate";
  if (isRoot) return "root";
  return "discovered";
}

export function toGraphData(tree: LineageTree, backendEdges: BackendEdge[] = []): GraphData {
  const rootIds = new Set(tree.root_ids);
  const rawNodesById = new Map(tree.nodes.map((node) => [node.id, node]));
  const candidateIds = new Set<string>();

  for (const edge of tree.edges) {
    const parent = rawNodesById.get(edge.parent_id);
    const child = rawNodesById.get(edge.child_id);
    if (parent?.source_kind === "submitted" && child?.source_kind === "fetched") candidateIds.add(child.id);
    if (child?.source_kind === "submitted" && parent?.source_kind === "fetched") candidateIds.add(parent.id);
  }

  const nodes: GraphNode[] = tree.nodes.map((node) => {
    const is_root = rootIds.has(node.id);
    // Shallow copy: the force simulation writes x/y/vx/vy onto whatever it is handed.
    return { ...node, is_root, role: roleOf(node, is_root, candidateIds.has(node.id)) };
  });

  const known = new Set(nodes.map((node) => node.id));
  const backendByEndpoints = new Map(
    backendEdges
      .filter((edge): edge is Extract<BackendEdge, { status: "validated" }> => edge.status === "validated")
      .map((edge) => [`${edge.source}\u0000${edge.target}`, edge])
  );

  // Accepted edges only. `tree.rejected_edges` stays out of the provenance graph.
  const links: GraphLink[] = tree.edges
    .filter((edge) => known.has(edge.parent_id) && known.has(edge.child_id))
    .map((edge) => {
      const parent = rawNodesById.get(edge.parent_id);
      const child = rawNodesById.get(edge.child_id);
      const touchesSubmission = parent?.source_kind === "submitted" || child?.source_kind === "submitted";
      const backendEdge = backendByEndpoints.get(`${edge.parent_id}\u0000${edge.child_id}`);

      return {
        ...edge,
        source: edge.parent_id,
        target: edge.child_id,
        backend_status: backendEdge?.status ?? "validated",
        kind: touchesSubmission ? "candidate_match" : "validated_provenance",
      };
    });

  return { nodes, links, rejectedEdges: tree.rejected_edges, excludedCandidates: tree.excluded };
}

/** Tolerates force-graph swapping link endpoints from ids to node objects after layout. */
export function endpointId(endpoint: GraphLink["source"] | GraphNode | undefined): string | null {
  if (typeof endpoint === "string") return endpoint;
  if (endpoint && typeof endpoint === "object" && "id" in endpoint) return endpoint.id;
  return null;
}
