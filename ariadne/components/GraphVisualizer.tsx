"use client";

import React, { useRef, useCallback, useEffect, useMemo, useState } from "react";
import ForceGraph, { type ForceGraphMethods } from "react-force-graph-2d";
import {
  X,
  ExternalLink,
  AlertTriangle,
  BrainCircuit,
  Sprout,
  Clock,
  ArrowDown,
  GitBranch,
  FilterX,
  Maximize2,
  ZoomIn,
  ZoomOut,
  MoveRight,
} from "lucide-react";
import {
  ROLE_COLOR,
  ROLE_LABEL,
  endpointId,
  type GraphData,
  type GraphLink,
  type GraphNode,
} from "@/lib/graph";
import { displayTitle, formatDate, formatTimestamp, percent } from "@/lib/format";
import { computeProvenanceLayout } from "@/lib/layout";
import { ConfidenceBar, Drawer, Field, StringList } from "./panel-ui";
import RejectedEvidencePanel, { type EvidenceTab } from "./RejectedEvidencePanel";

/** What each `temporal.ordering` value actually licenses us to claim. */
const ORDERING_NOTE: Record<string, string> = {
  strict: "The parent's publication time precedes the child's.",
  "same-time": "Both documents carry the same publication time; order is not separable from timestamps alone.",
  "from-link":
    "Order was inferred from link evidence, not from a reliable publication timestamp.",
  unknown: "Publication order could not be established from the available timestamps.",
};

/** Endpoint summary: resolved node when we have one, bare id when we do not. */
function Endpoint({ id, node, role }: { id: string | null; node: GraphNode | undefined; role: string }) {
  return (
    <div className="bg-white/5 rounded-lg border border-white/10 px-3 py-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{role}</p>
      {node ? (
        <>
          <p className="text-sm text-gray-100 leading-snug">{displayTitle(node)}</p>
          <p className="text-xs text-gray-500">{node.publisher || "unknown publisher"}</p>
          <a
            href={node.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-blue-400 hover:text-blue-300 underline break-all inline-flex items-center mt-1"
          >
            <ExternalLink size={11} className="mr-1 shrink-0" />
            {node.url}
          </a>
        </>
      ) : (
        <p className="text-sm text-gray-400 break-all">{id ?? "unknown node"}</p>
      )}
    </div>
  );
}

const EDGE_COLOR = "#f2da51";
const SELECTED_EDGE_COLOR = "#ffffff";
/** Padding (px) left around the lineage when fitting it to the viewport. */
const FIT_PADDING = 130;
/** Small graphs would otherwise be fitted to a comically large zoom. */
const MAX_INITIAL_ZOOM = 2.6;
const CARD_WIDTH = 194;
const CARD_HEIGHT = 80;
const CARD_RADIUS = 10;

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function fitText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text.trimEnd()}…`;
}

function titleLines(context: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = lines.length === 1 ? words.slice(index).join(" ") : word;
      if (lines.length === 1) break;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  return lines.slice(0, 2).map((line) => fitText(context, line, maxWidth));
}

export default function GraphVisualizer({ data }: { data: GraphData }) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  // Exactly one of these is ever set; the panel renders whichever it is.
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<GraphLink | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<GraphLink | null>(null);
  // The rejected-evidence drawer shares the right edge, so it is exclusive with the inspectors.
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("rejected");

  const nodesById = useMemo(() => new Map(data.nodes.map((node) => [node.id, node])), [data.nodes]);

  const focusId = hoveredNode?.id ?? selectedNode?.id ?? null;

  /** Every ancestor and descendant of the focused source, used to isolate its complete lineage. */
  const focusedNodeIds = useMemo(() => {
    if (!focusId) return null;
    const parents = new Map<string, Set<string>>(data.nodes.map((node) => [node.id, new Set()]));
    const children = new Map<string, Set<string>>(data.nodes.map((node) => [node.id, new Set()]));
    for (const link of data.links) {
      const parent = endpointId(link.source) ?? link.parent_id;
      const child = endpointId(link.target) ?? link.child_id;
      if (!parent || !child) continue;
      parents.get(child)?.add(parent);
      children.get(parent)?.add(child);
    }

    const lineage = new Set([focusId]);
    const walk = (relationships: Map<string, Set<string>>) => {
      const queue = [focusId];
      for (let index = 0; index < queue.length; index += 1) {
        for (const next of relationships.get(queue[index]!) ?? []) {
          if (lineage.has(next)) continue;
          lineage.add(next);
          queue.push(next);
        }
      }
    };
    walk(parents);
    walk(children);
    return lineage;
  }, [data.links, data.nodes, focusId]);

  /**
   * Pin every node to its deterministic layer position before the simulation runs. Fresh copies
   * rather than in-place edits: the props stay untouched, and re-copying the links keeps their
   * endpoints as ids so force-graph re-resolves them against this render's node objects.
   */
  const positioned = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => {
    const positions = computeProvenanceLayout(data.nodes, data.links);
    const nodes = data.nodes.map((node) => {
      const point = positions.get(node.id);
      return point ? { ...node, fx: point.x, fy: point.y, x: point.x, y: point.y } : { ...node };
    });
    const links = data.links.map((link) => ({
      ...link,
      source: endpointId(link.source) ?? link.parent_id,
      target: endpointId(link.target) ?? link.child_id,
    }));
    return { nodes, links };
  }, [data]);

  const fitToView = useCallback(() => {
    const graph = fgRef.current;
    if (!graph) return;
    graph.zoomToFit(400, FIT_PADDING);
    // zoomToFit happily magnifies a three-node lineage; keep it legible instead.
    window.setTimeout(() => {
      const current = fgRef.current;
      if (current && current.zoom() > MAX_INITIAL_ZOOM) current.zoom(MAX_INITIAL_ZOOM, 200);
    }, 450);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const graph = fgRef.current;
    if (!graph) return;
    graph.zoom(Math.max(0.35, Math.min(5, graph.zoom() * factor)), 280);
  }, []);

  // Positions are fixed, so one fit after layout is enough; re-fit when a new tree arrives.
  useEffect(() => {
    const timer = window.setTimeout(fitToView, 100);
    return () => window.clearTimeout(timer);
  }, [positioned, fitToView]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (fgRef.current && node.x !== undefined && node.y !== undefined) {
      const graph = fgRef.current;
      graph.centerAt(node.x + 90, node.y, 650);
      graph.zoom(Math.max(graph.zoom(), 1.25), 650);
    }
    setEvidencePanelOpen(false);
    setSelectedLink(null);
    setSelectedNode(node);
  }, []);

  const handleLinkClick = useCallback((link: GraphLink) => {
    setEvidencePanelOpen(false);
    setSelectedNode(null);
    setSelectedLink(link);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
    setEvidencePanelOpen(false);
  }, []);

  const openEvidencePanel = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
    setEvidencePanelOpen(true);
  }, []);

  // Endpoints are read through endpointId(): the simulation swaps ids for node objects.
  const parentId = selectedLink ? endpointId(selectedLink.source) ?? selectedLink.parent_id : null;
  const childId = selectedLink ? endpointId(selectedLink.target) ?? selectedLink.child_id : null;
  const parentNode = parentId ? nodesById.get(parentId) : undefined;
  const childNode = childId ? nodesById.get(childId) : undefined;

  const panelOpen = Boolean(selectedNode || selectedLink);

  const isFocusedLink = useCallback(
    (link: GraphLink) => {
      if (!focusedNodeIds) return false;
      const source = endpointId(link.source) ?? link.parent_id;
      const target = endpointId(link.target) ?? link.child_id;
      return Boolean(source && target && focusedNodeIds.has(source) && focusedNodeIds.has(target));
    },
    [focusedNodeIds]
  );

  const paintNode = useCallback(
    (node: GraphNode, context: CanvasRenderingContext2D) => {
      if (node.x === undefined || node.y === undefined) return;
      const x = node.x - CARD_WIDTH / 2;
      const y = node.y - CARD_HEIGHT / 2;
      const roleColor = ROLE_COLOR[node.role];
      const selected = selectedNode?.id === node.id;
      const hovered = hoveredNode?.id === node.id;
      const related = !focusedNodeIds || focusedNodeIds.has(node.id);

      context.save();
      context.globalAlpha = related ? 1 : 0.17;

      if (selected || hovered || node.is_root || node.is_seed) {
        context.shadowColor = selected || hovered ? roleColor : `${roleColor}88`;
        context.shadowBlur = selected || hovered ? 20 : 11;
      }

      const fill = context.createLinearGradient(x, y, x + CARD_WIDTH, y + CARD_HEIGHT);
      fill.addColorStop(0, selected || hovered ? "rgba(37, 24, 50, 0.98)" : "rgba(23, 16, 33, 0.96)");
      fill.addColorStop(1, selected || hovered ? "rgba(17, 12, 27, 0.98)" : "rgba(10, 8, 17, 0.96)");
      roundedRect(context, x, y, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS);
      context.fillStyle = fill;
      context.fill();
      context.shadowBlur = 0;
      context.lineWidth = selected || hovered ? 1.5 : 0.75;
      context.strokeStyle = selected || hovered ? roleColor : "rgba(230, 215, 242, 0.2)";
      context.stroke();

      context.save();
      roundedRect(context, x, y, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS);
      context.clip();
      context.fillStyle = roleColor;
      context.fillRect(x, y, selected || hovered ? 3 : 2, CARD_HEIGHT);
      const sheen = context.createLinearGradient(x, y, x + CARD_WIDTH, y);
      sheen.addColorStop(0, `${roleColor}1e`);
      sheen.addColorStop(0.52, "rgba(255,255,255,0.018)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = sheen;
      context.fillRect(x, y, CARD_WIDTH, CARD_HEIGHT);
      context.restore();

      context.textBaseline = "middle";
      context.font = "500 6.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillStyle = roleColor;
      const publisher = (node.publisher || "unknown source").toUpperCase();
      context.fillText(fitText(context, publisher, 118), x + 13, y + 14);

      context.textAlign = "right";
      context.fillStyle = "rgba(227, 215, 237, 0.48)";
      context.fillText(formatDate(node.timestamp).toUpperCase(), x + CARD_WIDTH - 12, y + 14);

      context.textAlign = "left";
      context.font = "500 9.5px Geist, ui-sans-serif, system-ui, sans-serif";
      context.fillStyle = "rgba(251, 248, 253, 0.94)";
      const lines = titleLines(context, displayTitle(node), CARD_WIDTH - 26);
      lines.forEach((line, index) => context.fillText(line, x + 13, y + 35 + index * 12));

      context.font = "500 6.2px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillStyle = "rgba(221, 207, 232, 0.42)";
      context.fillText(ROLE_LABEL[node.role].toUpperCase(), x + 13, y + CARD_HEIGHT - 10);

      context.beginPath();
      context.arc(x + CARD_WIDTH - 14, y + CARD_HEIGHT - 10, selected || hovered ? 3.2 : 2.4, 0, Math.PI * 2);
      context.fillStyle = roleColor;
      context.fill();
      context.restore();
    },
    [focusedNodeIds, hoveredNode?.id, selectedNode?.id]
  );

  const paintNodePointerArea = useCallback(
    (node: GraphNode, color: string, context: CanvasRenderingContext2D) => {
      if (node.x === undefined || node.y === undefined) return;
      roundedRect(
        context,
        node.x - CARD_WIDTH / 2,
        node.y - CARD_HEIGHT / 2,
        CARD_WIDTH,
        CARD_HEIGHT,
        CARD_RADIUS
      );
      context.fillStyle = color;
      context.fill();
    },
    []
  );

  return (
    <div className="relative w-full h-full">
      <ForceGraph<GraphNode, GraphLink>
        ref={fgRef}
        graphData={positioned}
        // Coordinates are pinned, so no relaxation is needed or wanted.
        cooldownTicks={0}
        onEngineStop={fitToView}
        // Dragging a node would silently break the temporal reading of the layout.
        enableNodeDrag={false}
        nodeLabel={() => ""}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => "replace"}
        nodePointerAreaPaint={paintNodePointerArea}
        onNodeHover={(node) => setHoveredNode(node ?? null)}
        linkLabel={(link) => `${percent(link.confidence)} · ${link.type}`}
        linkColor={(link) => {
          if (link === selectedLink) return SELECTED_EDGE_COLOR;
          if (focusedNodeIds && !isFocusedLink(link)) return "rgba(155, 125, 179, 0.07)";
          if (isFocusedLink(link)) return `rgba(247, 202, 111, ${0.52 + 0.42 * link.confidence})`;
          return `rgba(223, 171, 84, ${0.24 + 0.38 * link.confidence})`;
        }}
        linkWidth={(link) => {
          const base = 0.8 + 1.35 * link.confidence;
          if (link === selectedLink) return base + 2.2;
          if (link === hoveredLink || isFocusedLink(link)) return base + 0.9;
          return base;
        }}
        linkCurvature={0.045}
        // Widen the pick radius so thin, low-confidence edges are still clickable.
        linkHoverPrecision={6}
        onNodeClick={handleNodeClick}
        onLinkClick={handleLinkClick}
        onLinkHover={(link) => setHoveredLink(link ?? null)}
        onBackgroundClick={handleBackgroundClick}
        backgroundColor="rgba(0,0,0,0)"
        // Arrow sits at the child end: parent (source) -> child (target).
        linkDirectionalArrowLength={5.5}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={(link) =>
          link === selectedLink || isFocusedLink(link) ? "rgba(255, 221, 145, 0.95)" : "rgba(223, 171, 84, 0.58)"
        }
        linkDirectionalParticles={(link) => (link === selectedLink || link === hoveredLink ? 2 : 0)}
        linkDirectionalParticleColor={() => "#ffe4a3"}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleWidth={2.4}
      />

      <div className="absolute top-[5.65rem] left-6 z-20 flex items-center gap-2 rounded-xl border border-white/8 bg-[#0c0914]/65 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35 backdrop-blur-xl pointer-events-none">
        <span className="text-[#e6bd6a]">Origins</span>
        <MoveRight size={13} strokeWidth={1.5} />
        <span>Propagation</span>
      </div>

      <div className="absolute top-[5.65rem] right-6 z-30 flex items-center gap-1 rounded-xl border border-white/8 bg-[#0c0914]/72 p-1.5 text-white/60 shadow-2xl backdrop-blur-xl">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.35)}
          className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]"
        >
          <ZoomIn size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomBy(0.74)}
          className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]"
        >
          <ZoomOut size={16} strokeWidth={1.5} />
        </button>
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button
          type="button"
          aria-label="Fit graph to view"
          onClick={fitToView}
          className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]"
        >
          <Maximize2 size={15} strokeWidth={1.5} />
        </button>
      </div>

      {/* Opens the rejected-evidence drawer; sits under it so the two never fight. */}
      <button
        onClick={openEvidencePanel}
        className="absolute bottom-6 right-6 z-40 rounded-xl border border-white/10 bg-[#0c0914]/78 px-4 py-2.5 text-left shadow-2xl backdrop-blur-xl transition-colors hover:border-[#e6bd6a]/25 hover:bg-[#1a1024]/90"
      >
        <span className="flex items-center text-sm text-white/75">
          <FilterX size={15} className="mr-2 text-[#d5ad61]" />
          Rejected Evidence
        </span>
        <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-wider text-white/30">
          {data.rejectedEdges.length} rejected &middot; {data.excludedCandidates.length} excluded
        </span>
      </button>

      <RejectedEvidencePanel
        open={evidencePanelOpen}
        tab={evidenceTab}
        onTabChange={setEvidenceTab}
        onClose={() => setEvidencePanelOpen(false)}
        rejectedEdges={data.rejectedEdges}
        excludedCandidates={data.excludedCandidates}
        nodesById={nodesById}
      />

      {/* The Side Panel - renders the selected node OR the selected edge, never both. */}
      <Drawer open={panelOpen}>
        {selectedNode && (
          <div className="flex flex-col h-full space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3
                className="text-sm font-semibold tracking-wide uppercase flex items-center"
                style={{ color: ROLE_COLOR[selectedNode.role] }}
              >
                {selectedNode.role === "conflict" ? (
                  <AlertTriangle size={18} className="mr-2" />
                ) : selectedNode.is_seed || selectedNode.is_root ? (
                  <Sprout size={18} className="mr-2" />
                ) : (
                  <ExternalLink size={18} className="mr-2" />
                )}
                {ROLE_LABEL[selectedNode.role]}
              </h3>
              <button
                onClick={() => setSelectedNode(null)}
                className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <Field label="Title">{displayTitle(selectedNode)}</Field>

            <Field label="Publisher">{selectedNode.publisher || <span className="text-gray-500">unknown</span>}</Field>

            <Field label="Source URL">
              <a
                href={selectedNode.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-400 hover:text-blue-300 underline break-all"
              >
                {selectedNode.url}
              </a>
            </Field>

            <Field label="Published">
              <div className="flex items-center">
                <Clock size={14} className="mr-2 text-gray-500 shrink-0" />
                <span>
                  {formatTimestamp(selectedNode.timestamp)}
                  <span className="text-gray-500">
                    {" "}(via {selectedNode.timestamp_source}; {selectedNode.timestamp_confidence} confidence)
                  </span>
                </span>
              </div>
              {selectedNode.earliest_possible && selectedNode.earliest_possible !== selectedNode.timestamp && (
                <p className="text-xs text-gray-500 mt-1">
                  Earliest possible: {formatTimestamp(selectedNode.earliest_possible)}
                </p>
              )}
            </Field>

            {selectedNode.timestamp_conflict && (
              <div className="bg-amber-500/10 p-4 rounded-xl border border-amber-500/30">
                <p className="text-xs text-amber-400 uppercase font-semibold mb-2">Timestamp conflict</p>
                <p className="text-sm text-gray-200">{selectedNode.timestamp_conflict}</p>
              </div>
            )}

            <Field label="Passage">
              {selectedNode.passage ? (
                <p className="italic leading-relaxed text-gray-300">{selectedNode.passage}</p>
              ) : (
                <span className="text-gray-500">none captured</span>
              )}
            </Field>

            <Field label="Fabricated citations">
              <StringList items={selectedNode.fabricated_citations} empty="none recorded" />
            </Field>

            <Field label="Mutations">
              <StringList items={selectedNode.mutations} empty="none recorded" />
            </Field>

            <Field label="Discovered via">
              <StringList items={selectedNode.discovered_via} empty="unknown" />
            </Field>

            <Field label="Seed">{selectedNode.is_seed ? "yes" : "no"}</Field>

            <div className="bg-white/5 p-4 rounded-xl border border-white/10">
              <p className="text-xs text-gray-400 uppercase mb-2 flex items-center">
                <BrainCircuit size={16} className="mr-2" /> AI-origin evidence
              </p>
              {selectedNode.ai_evidence ? (
                <div className="space-y-2 text-sm text-gray-200">
                  <p>
                    <span className="text-gray-500">Provider:</span> {selectedNode.ai_evidence.provider}
                  </p>
                  <p>
                    <span className="text-gray-500">Label:</span> {selectedNode.ai_evidence.label}
                  </p>
                  <p>
                    <span className="text-gray-500">Reported AI probability:</span>{" "}
                    {selectedNode.ai_evidence.ai_probability.toFixed(2)}
                  </p>
                  <p className="text-xs text-gray-500">Checked {formatTimestamp(selectedNode.ai_evidence.checked_at)}</p>
                  {selectedNode.ai_evidence.flagged_passages.length > 0 && (
                    <div className="pt-1">
                      <p className="text-gray-500 text-xs uppercase mb-1">Flagged passages</p>
                      <StringList items={selectedNode.ai_evidence.flagged_passages} empty="none" />
                    </div>
                  )}
                  <p className="text-xs text-gray-600 pt-1">Supplementary evidence only; not a verdict on the claim.</p>
                </div>
              ) : (
                <p className="text-sm text-gray-500">AI-origin evidence: not available</p>
              )}
            </div>
          </div>
        )}

        {selectedLink && (
          <div className="flex flex-col h-full space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className="text-sm font-semibold tracking-wide uppercase flex items-center text-yellow-300">
                <GitBranch size={18} className="mr-2" />
                {selectedLink.type === "propagation" ? "Propagation Evidence" : "Similarity Evidence"}
              </h3>
              <button
                onClick={() => setSelectedLink(null)}
                className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* parent -> child, in backend order */}
            <div className="space-y-2">
              <Endpoint id={parentId} node={parentNode} role="Parent" />
              <div className="flex justify-center text-gray-600">
                <ArrowDown size={18} />
              </div>
              <Endpoint id={childId} node={childNode} role="Child" />
            </div>

            <Field label="Confidence">
              <div className="space-y-2">
                <p className="text-2xl font-semibold text-yellow-300">{percent(selectedLink.confidence)}</p>
                <ConfidenceBar value={selectedLink.confidence} color={EDGE_COLOR} />
              </div>
            </Field>

            {/* Verbatim from the deterministic scorer - not reworded. */}
            <Field label="Basis">
              <p className="bg-white/5 p-3 rounded-lg border border-white/10 leading-relaxed">{selectedLink.basis}</p>
            </Field>

            <div className="space-y-4 border-t border-white/10 pt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Evidence breakdown</p>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-1 tracking-wide">Explicit source relationship</p>
                {selectedLink.explicit_link ? (
                  <p className="text-sm text-emerald-400">&#10003; Explicit link/reference detected</p>
                ) : (
                  <p className="text-sm text-gray-400">No explicit link detected</p>
                )}
              </div>

              <Field label="Shared distinctive mutations">
                <StringList items={selectedLink.shared_mutations} empty="No shared distinctive mutations" />
              </Field>

              <Field label="Rare copied phrasing">
                Rare shared phrases: <span className="text-white">{selectedLink.rare_shared_phrases}</span>
              </Field>

              <Field label="Similarity">
                <div className="space-y-2">
                  <p>
                    Text similarity: <span className="text-white">{percent(selectedLink.similarity)}</span>
                  </p>
                  <ConfidenceBar value={selectedLink.similarity} color="#64748b" />
                  <p className="text-xs text-gray-500">
                    One signal among several. Similar wording does not by itself establish copying — shared sources or
                    common phrasing can produce it.
                  </p>
                </div>
              </Field>
            </div>

            <div className="space-y-2 border-t border-white/10 pt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Temporal evidence</p>
              <div className="text-sm text-gray-200 space-y-1">
                <p>
                  <span className="text-gray-500">Parent:</span> {formatDate(selectedLink.temporal.parent_time)}
                </p>
                <p>
                  <span className="text-gray-500">Child:</span> {formatDate(selectedLink.temporal.child_time)}
                </p>
                <p>
                  <span className="text-gray-500">Gap:</span>{" "}
                  {selectedLink.temporal.gap_days === null ? (
                    <span className="text-gray-500">unknown</span>
                  ) : (
                    `${selectedLink.temporal.gap_days} day${Math.abs(selectedLink.temporal.gap_days) === 1 ? "" : "s"}`
                  )}
                </p>
                <p>
                  <span className="text-gray-500">Ordering:</span> {selectedLink.temporal.ordering}
                </p>
              </div>
              <p className="text-xs text-gray-500">
                {ORDERING_NOTE[selectedLink.temporal.ordering] ?? "Ordering evidence is unavailable."}
              </p>
            </div>

            {selectedLink.alternatives.length > 0 && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Alternative parents considered</p>
                <p className="text-xs text-gray-600">
                  Scored against this child but not accepted; they are not drawn on the graph.
                </p>
                <div className="space-y-2">
                  {selectedLink.alternatives.map((alternative, index) => {
                    const candidate = nodesById.get(alternative.candidate_id);
                    return (
                      <div
                        key={`${alternative.candidate_id}-${index}`}
                        className="bg-white/5 rounded-lg border border-white/10 px-3 py-2 space-y-1"
                      >
                        <p className="text-sm text-gray-100 leading-snug">
                          {candidate ? displayTitle(candidate) : alternative.candidate_id}
                        </p>
                        {candidate && <p className="text-xs text-gray-500">{candidate.publisher}</p>}
                        <p className="text-xs text-gray-400">Confidence: {percent(alternative.confidence)}</p>
                        <p className="text-xs text-gray-400">Reason: {alternative.reason}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
