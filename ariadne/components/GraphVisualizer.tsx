"use client";

import React, { useRef, useCallback, useState } from "react";
import ForceGraph, { type ForceGraphMethods } from "react-force-graph-2d";
import { X, ExternalLink, AlertTriangle, BrainCircuit, Sprout, Clock } from "lucide-react";
import { ROLE_COLOR, ROLE_LABEL, type GraphData, type GraphLink, type GraphNode } from "@/lib/graph";

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

export default function GraphVisualizer({ data }: { data: GraphData }) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (fgRef.current && node.x !== undefined && node.y !== undefined) {
      fgRef.current.centerAt(node.x, node.y, 1000);
      fgRef.current.zoom(8, 2000);
    }
    setSelectedNode(node);
  }, []);

  const handleBackgroundClick = useCallback(() => setSelectedNode(null), []);

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
        linkColor={(link) => `rgba(242, 218, 81, ${0.25 + 0.55 * link.confidence})`}
        linkWidth={(link) => 0.75 + 2 * link.confidence}
        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        backgroundColor="#000000"
        // Arrow sits at the child end: parent (source) -> child (target).
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
      />

      {/* The Side Panel */}
      <div
        className={`absolute top-0 right-0 h-full w-96 bg-black/80 backdrop-blur-xl border-l border-white/10 p-6 text-white transition-transform duration-300 ease-in-out z-50 overflow-y-auto ${
          selectedNode ? "translate-x-0" : "translate-x-full"
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
                rel="noreferrer"
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
      </div>
    </div>
  );
}
