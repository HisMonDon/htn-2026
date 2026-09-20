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

/**
 * The backend's actual provenance-strength vocabulary (see `AriadneEdge.status` in
 * shared/ariadne.ts), preserved through to the graph edge instead of collapsing everything
 * accepted into "validated". Used only to pick a layout's primary parent and to choose
 * primary/secondary edge styling — never to alter what the backend actually asserted.
 * Priority for layout purposes: validated > probable > citation > related > candidate.
 */
export type ProvenanceStatus = "validated" | "probable" | "citation" | "related" | "candidate";

/**
 * Independent from provenance: whether a related/cited document semantically agrees with the
 * submitted claim. Optional and backend-supplied only — the frontend never infers this itself.
 * Absent on every edge until the backend starts populating it.
 */
export type ClaimRelationship = "supports" | "contradicts" | "modifies" | "extends" | "unrelated";

export interface GraphNode extends LineageTreeNode {
  /** Listed in `tree.root_ids` — the top of a reconstructed propagation chain. */
  is_root: boolean;
  /** This root's position in `tree.root_ids`. Lets the layout honor a declared root order ahead of timestamp. Undefined for non-root nodes. */
  root_order?: number;
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
   * "validated": an accepted compatibility-tree edge. "candidate": a discovery-only match between a
   * fetched source and the submitted text, carried by the backend as `status: "candidate"`.
   */
  backend_status: "validated" | "candidate";
  /** Presentation semantics derived from the backend node kind, never a validation result. */
  kind: EdgeKind;
  /**
   * The backend's real provenance status for this edge when it can be recovered from the full
   * `edges` response (validated/probable/related/citation/candidate). Falls back to "validated"
   * when no matching backend edge is found, matching this edge's prior default treatment.
   */
  provenance_status: ProvenanceStatus;
  /** Present only when the backend supplies it. See `ClaimRelationship`. */
  claim_relationship?: ClaimRelationship;
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

const COMMON_WORDS = new Set(
  "that this with from were have which their there would could about into than them then been also such when what says said will only very much more most some other these those".split(" "),
);

function distinctiveWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter((word) => !COMMON_WORDS.has(word));
}

/**
 * How much of the submitted text's distinctive wording a fetched source repeats (0-1). This is
 * Ariadne's own plain text comparison, shown as a candidate's "match strength". It ranks nothing,
 * gates nothing, and is not provenance confidence: acceptance is decided only by the backend validator.
 */
export function candidateStrength(submittedText: string, sourceText: string): number {
  const wanted = distinctiveWords(submittedText);
  if (wanted.length === 0) return 0;
  const present = new Set(distinctiveWords(sourceText));
  return Math.round((wanted.filter((word) => present.has(word)).length / wanted.length) * 100) / 100;
}

/** Shown on a candidate match: it is a proposal that a source relates to the text, never a verdict. */
function candidateBasis(strength: number): string {
  return `Proposed as an upstream source for the submitted text. ${Math.round(strength * 100)}% of the submitted text's distinctive words appear in this source's matched passage (a plain text comparison). Discovery only: this is not validated provenance.`;
}

/**
 * `backendNodes` is the response's full document list. The compatibility `tree` keeps only nodes
 * touched by a validated edge, so a fetched source matched to the submitted text (a backend
 * `status: "candidate"` edge) is otherwise invisible. Those matches are added here as candidate
 * nodes and links; they carry no confidence and never count as validated provenance. Their strength is a plain text overlap (see `candidateStrength`).
 */
export function toGraphData(tree: LineageTree, backendEdges: BackendEdge[] = [], backendNodes: LineageTreeNode[] = []): GraphData {
  const rootIds = new Set(tree.root_ids);
  const rootOrder = new Map(tree.root_ids.map((id, index) => [id, index]));
  const treeNodeIds = new Set(tree.nodes.map((node) => node.id));
  const backendNodesById = new Map(backendNodes.map((node) => [node.id, node]));

  const candidateEdges: Array<{ source: string; target: string }> = [];
  for (const edge of backendEdges) {
    if (edge.status !== "candidate" || edge.source === null) continue;
    // Both ends must be real documents, and the target must already be on the graph (the submitted text).
    if (!treeNodeIds.has(edge.target) || !(treeNodeIds.has(edge.source) || backendNodesById.has(edge.source))) continue;
    if (candidateEdges.some((known) => known.source === edge.source && known.target === edge.target)) continue;
    candidateEdges.push({ source: edge.source, target: edge.target });
  }
  const promoted = [...new Set(candidateEdges.map((edge) => edge.source))]
    .filter((id) => !treeNodeIds.has(id))
    .map((id) => backendNodesById.get(id)!);
  const graphTreeNodes = [...tree.nodes, ...promoted];

  const rawNodesById = new Map(graphTreeNodes.map((node) => [node.id, node]));
  const candidateIds = new Set<string>(candidateEdges.map((edge) => edge.source));

  for (const edge of tree.edges) {
    const parent = rawNodesById.get(edge.parent_id);
    const child = rawNodesById.get(edge.child_id);
    if (parent?.source_kind === "submitted" && child?.source_kind === "fetched") candidateIds.add(child.id);
    if (child?.source_kind === "submitted" && parent?.source_kind === "fetched") candidateIds.add(parent.id);
  }

  const nodes: GraphNode[] = graphTreeNodes.map((node) => {
    const is_root = rootIds.has(node.id);
    // Shallow copy: the force simulation writes x/y/vx/vy onto whatever it is handed.
    return {
      ...node,
      is_root,
      ...(is_root ? { root_order: rootOrder.get(node.id) } : {}),
      role: roleOf(node, is_root, candidateIds.has(node.id)),
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const backendByEndpoints = new Map(
    backendEdges
      .filter((edge) => edge.status !== "candidate" && edge.status !== "rejected")
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

      const claimRelationship = (backendEdge as { claim_relationship?: ClaimRelationship } | undefined)?.claim_relationship;
      const provenanceStatus = (backendEdge?.status as ProvenanceStatus | undefined) ?? "validated";

      return {
        ...edge,
        source: edge.parent_id,
        target: edge.child_id,
        // "probable"/"related" are accepted-but-thinner-evidence statuses; they still count as
        // "validated" for the existing binary backend_status contract (candidate vs. everything else).
        backend_status: "validated",
        provenance_status: provenanceStatus,
        ...(claimRelationship ? { claim_relationship: claimRelationship } : {}),
        kind: touchesSubmission ? "candidate_match" : "validated_provenance",
      };
    });

  const promotedIds = new Set(promoted.map((node) => node.id));
  for (const { source, target } of candidateEdges) {
    const sourceNode = rawNodesById.get(source);
    const strength = candidateStrength(tree.seed.claim, `${sourceNode?.title ?? ""} ${sourceNode?.passage ?? ""}`);
    links.push({
      parent_id: source,
      child_id: target,
      type: "similarity",
      confidence: strength,
      basis: candidateBasis(strength),
      shared_mutations: [],
      claim_mutations: [],
      explicit_link: false,
      rare_shared_phrases: 0,
      similarity: strength,
      temporal: { parent_time: rawNodesById.get(source)?.timestamp ?? null, child_time: null, gap_days: null, ordering: "unknown" },
      alternatives: [],
      source,
      target,
      backend_status: "candidate",
      provenance_status: "candidate",
      kind: "candidate_match",
    });
  }

  return {
    nodes,
    links,
    rejectedEdges: tree.rejected_edges,
    excludedCandidates: tree.excluded.filter((excluded) => !promotedIds.has(excluded.id)),
  };
}

/** Tolerates force-graph swapping link endpoints from ids to node objects after layout. */
export function endpointId(endpoint: GraphLink["source"] | GraphNode | undefined): string | null {
  if (typeof endpoint === "string") return endpoint;
  if (endpoint && typeof endpoint === "object" && "id" in endpoint) return endpoint.id;
  return null;
}
