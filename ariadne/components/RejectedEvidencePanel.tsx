"use client";

import React from "react";
import { ArrowDown, FilterX } from "lucide-react";
import type { ExcludedCandidate, RejectedEdge } from "@/lib/api";
import type { GraphNode } from "@/lib/graph";
import { displayTitle, hostOf, percent } from "@/lib/format";
import { ConfidenceBar, Drawer, Field, PanelHeader, SourceLink } from "./panel-ui";

export type EvidenceTab = "rejected" | "excluded";

const REJECTED_COLOR = "#94a3b8";

/** Endpoint of a rejected relationship: the resolved node when we have it, else the raw id. */
function Endpoint({ role, id, node }: { role: string; id: string; node: GraphNode | undefined }) {
  return (
    <div className="bg-white/5 rounded-lg border border-white/10 px-3 py-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{role}</p>
      {node ? (
        <>
          <p className="text-sm text-gray-100 leading-snug">{displayTitle(node)}</p>
          {node.publisher && <p className="text-xs text-gray-500">{node.publisher}</p>}
          <div className="mt-1">
            <SourceLink url={node.url} />
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-400 break-all">{id}</p>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 rounded-lg text-xs tracking-wide transition-colors border ${
        active
          ? "bg-white/10 border-white/20 text-gray-100"
          : "bg-transparent border-white/5 text-gray-500 hover:text-gray-300 hover:bg-white/5"
      }`}
    >
      {label}
      <span className="ml-1.5 text-gray-500">{count}</span>
    </button>
  );
}

export default function RejectedEvidencePanel({
  open,
  tab,
  onTabChange,
  onClose,
  rejectedEdges,
  excludedCandidates,
  nodesById,
}: {
  open: boolean;
  tab: EvidenceTab;
  onTabChange: (tab: EvidenceTab) => void;
  onClose: () => void;
  rejectedEdges: RejectedEdge[];
  excludedCandidates: ExcludedCandidate[];
  nodesById: Map<string, GraphNode>;
}) {
  return (
    <Drawer open={open}>
      <div className="flex flex-col space-y-5">
        <PanelHeader
          title="Rejected Evidence"
          icon={<FilterX size={18} />}
          color={REJECTED_COLOR}
          onClose={onClose}
        />

        <p className="text-xs text-gray-500 leading-relaxed">
          Nothing here is on the graph. The graph carries accepted provenance only; these are the candidates the
          scorer considered and set aside.
        </p>

        <div className="flex gap-2">
          <TabButton
            active={tab === "rejected"}
            label="Rejected relationships"
            count={rejectedEdges.length}
            onClick={() => onTabChange("rejected")}
          />
          <TabButton
            active={tab === "excluded"}
            label="Excluded sources"
            count={excludedCandidates.length}
            onClick={() => onTabChange("excluded")}
          />
        </div>

        {tab === "rejected" && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 leading-relaxed border-l-2 border-white/10 pl-3">
              A candidate relationship between two documents was scored, but the evidence was not strong enough to
              accept it as provenance. It is not drawn as a graph link.
            </p>

            {rejectedEdges.length === 0 ? (
              <p className="text-sm text-gray-500">No rejected relationships were recorded.</p>
            ) : (
              rejectedEdges.map((edge, index) => (
                <div
                  key={`${edge.parent_id}-${edge.child_id}-${index}`}
                  className="bg-white/5 rounded-xl border border-white/10 p-4 space-y-3"
                >
                  <Endpoint role="Parent" id={edge.parent_id} node={nodesById.get(edge.parent_id)} />
                  <div className="flex items-center justify-center text-[10px] text-gray-600 uppercase tracking-wide">
                    <ArrowDown size={14} className="mr-1.5" />
                    attempted provenance relationship
                  </div>
                  <Endpoint role="Child" id={edge.child_id} node={nodesById.get(edge.child_id)} />

                  <Field label="Confidence">
                    <div className="space-y-1.5">
                      <p className="text-lg font-semibold text-gray-300">{percent(edge.confidence)}</p>
                      <ConfidenceBar value={edge.confidence} color={REJECTED_COLOR} />
                    </div>
                  </Field>

                  {/* Verbatim from the deterministic scorer. */}
                  <Field label="Reason">
                    <p className="leading-relaxed">{edge.reason}</p>
                  </Field>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "excluded" && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 leading-relaxed border-l-2 border-white/10 pl-3">
              A page was discovered during research but does not belong to this lineage, so it is not part of the
              graph at all.
            </p>

            {excludedCandidates.length === 0 ? (
              <p className="text-sm text-gray-500">No discovered sources were excluded.</p>
            ) : (
              excludedCandidates.map((candidate, index) => {
                const node = nodesById.get(candidate.id);
                // Heading falls back to the URL's host, then the raw id - nothing invented.
                const heading = node ? displayTitle(node) : hostOf(candidate.url) ?? candidate.id;
                return (
                  <div
                    key={`${candidate.id}-${index}`}
                    className="bg-white/5 rounded-xl border border-white/10 p-4 space-y-2"
                  >
                    <p className="text-sm text-gray-100 leading-snug">{heading}</p>
                    {candidate.url ? (
                      <SourceLink url={candidate.url} />
                    ) : (
                      <p className="text-xs text-gray-500">No URL recorded</p>
                    )}
                    <p className="text-[11px] text-gray-600 break-all">id {candidate.id}</p>
                    <Field label="Reason">
                      <p className="leading-relaxed">{candidate.reason}</p>
                    </Field>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
