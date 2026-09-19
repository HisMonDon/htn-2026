"use client";

import React, { useRef, useCallback, useMemo, useState } from "react";
import ForceGraph, { type ForceGraphMethods } from "react-force-graph-2d";
import { X, ExternalLink, AlertTriangle, BrainCircuit, Sprout, Clock, ArrowDown, GitBranch } from "lucide-react";
import {
  ROLE_COLOR,
  ROLE_LABEL,
  endpointId,
  type GraphData,
  type GraphLink,
  type GraphNode,
} from "@/lib/graph";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );
}

function displayTitle(node: GraphNode): string {
  return node.title.trim() || node.publisher.trim() || node.url;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toUTCString();
}

/** Compact UTC date for the temporal block, e.g. "Dec 13, 2023". */
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string | null): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : DATE_FORMAT.format(new Date(parsed));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** What each `temporal.ordering` value actually licenses us to claim. */
const ORDERING_NOTE: Record<string, string> = {
  strict: "The parent's publication time precedes the child's.",
  "same-time": "Both documents carry the same publication time; order is not separable from timestamps alone.",
  "from-link":
    "Order was inferred from link evidence, not from a reliable publication timestamp.",
  unknown: "Publication order could not be established from the available timestamps.",
};

/** One labelled block in the side panel. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase mb-1 tracking-wide">{label}</p>
      <div className="text-sm text-gray-200 break-words">{children}</div>
    </div>
  );
}

function StringList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-gray-500">{empty}</span>;
  return (
    <ul className="list-disc list-inside space-y-1">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function ConfidenceBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

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

export default function GraphVisualizer({ data }: { data: GraphData }) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  // Exactly one of these is ever set; the panel renders whichever it is.
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<GraphLink | null>(null);
  const [hoveredLink, setHoveredLink] = useState<GraphLink | null>(null);

  const nodesById = useMemo(() => new Map(data.nodes.map((node) => [node.id, node])), [data.nodes]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (fgRef.current && node.x !== undefined && node.y !== undefined) {
      fgRef.current.centerAt(node.x, node.y, 1000);
      fgRef.current.zoom(8, 2000);
    }
    setSelectedLink(null);
    setSelectedNode(node);
  }, []);

  const handleLinkClick = useCallback((link: GraphLink) => {
    setSelectedNode(null);
    setSelectedLink(link);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
  }, []);

  // Endpoints are read through endpointId(): the simulation swaps ids for node objects.
  const parentId = selectedLink ? endpointId(selectedLink.source) ?? selectedLink.parent_id : null;
  const childId = selectedLink ? endpointId(selectedLink.target) ?? selectedLink.child_id : null;
  const parentNode = parentId ? nodesById.get(parentId) : undefined;
  const childNode = childId ? nodesById.get(childId) : undefined;

  const panelOpen = Boolean(selectedNode || selectedLink);

  return (
    <div className="relative w-full h-full">
      <ForceGraph<GraphNode, GraphLink>
        ref={fgRef}
        graphData={data}
        nodeLabel={(node) => `${escapeHtml(displayTitle(node))}<br/><i>${escapeHtml(node.publisher)}</i>`}
        nodeColor={(node) => ROLE_COLOR[node.role]}
        // Roots read as larger even when amber marks a timestamp conflict.
        nodeVal={(node) => (node.is_root || node.is_seed ? 4 : 1.5)}
        nodeRelSize={1.5}
        // Hover-only label, so edges stay legible without permanent text.
        linkLabel={(link) => `${percent(link.confidence)} &bull; ${escapeHtml(link.type)}`}
        linkColor={(link) =>
          link === selectedLink ? SELECTED_EDGE_COLOR : `rgba(242, 218, 81, ${0.25 + 0.55 * link.confidence})`
        }
        linkWidth={(link) => {
          const base = 0.75 + 2 * link.confidence;
          if (link === selectedLink) return base + 3;
          if (link === hoveredLink) return base + 1.5;
          return base;
        }}
        // Widen the pick radius so thin, low-confidence edges are still clickable.
        linkHoverPrecision={6}
        onNodeClick={handleNodeClick}
        onLinkClick={handleLinkClick}
        onLinkHover={(link) => setHoveredLink(link ?? null)}
        onBackgroundClick={handleBackgroundClick}
        backgroundColor="#000000"
        // Arrow sits at the child end: parent (source) -> child (target).
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
      />

      {/* The Side Panel - renders the selected node OR the selected edge, never both. */}
      <div
        className={`absolute top-0 right-0 h-full w-96 bg-black/80 backdrop-blur-xl border-l border-white/10 p-6 text-white transition-transform duration-300 ease-in-out z-50 overflow-y-auto ${
          panelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
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
                  <span className="text-gray-500"> (via {selectedNode.timestamp_source})</span>
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
      </div>
    </div>
  );
}
