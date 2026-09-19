"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2, AlertTriangle } from "lucide-react";
import { createResearch } from "@/lib/api";
import { toGraphData, ROLE_COLOR, ROLE_LABEL, type GraphData, type NodeRole } from "@/lib/graph";

const ROLE_LEGEND = (Object.keys(ROLE_LABEL) as NodeRole[]).map((role) => ({
  label: ROLE_LABEL[role],
  color: ROLE_COLOR[role],
}));

// DYNAMICALLY import the graph to prevent Next.js SSR crashes
const GraphVisualizer = dynamic(() => import("@/components/GraphVisualizer"), {
  ssr: false,
  loading: () => <p className="p-6 text-gray-400">Loading physics engine...</p>,
});

type Phase = "idle" | "researching" | "done" | "error";

function TreeView() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q"); // The claim typed on the landing page

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [researchId, setResearchId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Initializing Ariadne Protocol...");

  useEffect(() => {
    if (!query) return; // stays "idle"; the render guards on `query` too

    const controller = new AbortController();
    // Status updates so the wait reads as progress; the backend runs as one request.
    const timers = [
      setTimeout(() => setStatus("Deploying research spiders..."), 2000),
      setTimeout(() => setStatus("Scoring candidate parents..."), 5000),
      setTimeout(() => setStatus("Reconstructing propagation tree..."), 8000),
    ];

    const run = async () => {
      setPhase("researching");
      setError(null);
      setStatus("Initializing Ariadne Protocol...");
      try {
        const result = await createResearch(query, { signal: controller.signal });
        setResearchId(result.id);
        setGraphData(toGraphData(result.tree));
        setPhase("done");
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Research request failed:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setPhase("error");
      }
    };

    run();

    return () => {
      controller.abort();
      timers.forEach(clearTimeout);
    };
  }, [query]);

  return (
    <main className="w-full h-screen bg-black text-white overflow-hidden relative">
      {/* Header Overlay */}
      <div className="absolute top-0 left-0 w-full p-6 z-10 pointer-events-none flex justify-between items-center">
        <h2 className="text-2xl font-bold tracking-tighter text-white/80">
          Ariadne <span className="text-gray-500 font-normal">/</span> Trace
        </h2>
        <div className="text-sm text-gray-400 bg-white/5 px-4 py-2 rounded-full border border-white/10 backdrop-blur-md">
          Target: <span className="text-white">{query ?? "none"}</span>
          {researchId && <span className="ml-3 text-xs text-gray-600">id {researchId.slice(0, 8)}</span>}
        </div>
      </div>

      {/* Role legend - provenance roles, not a truth classification. */}
      {query && phase === "done" && (
        <div className="absolute bottom-6 left-6 z-10 flex flex-wrap gap-4 text-xs text-gray-400 bg-black/60 px-4 py-2 rounded-full border border-white/10 backdrop-blur-md">
          {ROLE_LEGEND.map(({ label, color }) => (
            <span key={label} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      {!query && (
        <div className="flex items-center justify-center w-full h-full">
          <p className="text-lg text-gray-400">No claim provided. Start from the home page.</p>
        </div>
      )}

      {query && phase !== "done" && phase !== "error" && (
        <div className="flex flex-col items-center justify-center w-full h-full space-y-6">
          <Loader2 className="w-12 h-12 text-white animate-spin opacity-50" />
          <p className="text-lg text-gray-400 animate-pulse">{status}</p>
        </div>
      )}

      {query && phase === "error" && (
        <div className="flex flex-col items-center justify-center w-full h-full space-y-4 px-6">
          <AlertTriangle className="w-12 h-12 text-red-500" />
          <p className="text-lg text-red-400">Failed to trace network.</p>
          <p className="text-sm text-gray-500 max-w-xl text-center break-words">{error}</p>
        </div>
      )}

      {/* Graph Render */}
      {query && phase === "done" && graphData && (
        <div className="w-full h-full cursor-grab active:cursor-grabbing">
          <GraphVisualizer data={graphData} />
        </div>
      )}
    </main>
  );
}

export default function TreePage() {
  return (
    <Suspense
      fallback={
        <main className="flex items-center justify-center w-full h-screen bg-black text-white">
          <Loader2 className="w-12 h-12 animate-spin opacity-50" />
        </main>
      }
    >
      <TreeView />
    </Suspense>
  );
}
