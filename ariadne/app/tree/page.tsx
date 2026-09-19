"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2, AlertTriangle, Route } from "lucide-react";
import { createResearch } from "@/lib/api";
import { toGraphData, ROLE_COLOR, ROLE_LABEL, type GraphData, type NodeRole } from "@/lib/graph";
import AriadneBackdrop from "@/components/AriadneBackdrop";
import styles from "./tree.module.css";

const ROLE_LEGEND = (Object.keys(ROLE_LABEL) as NodeRole[]).map((role) => ({
  label: ROLE_LABEL[role],
  color: ROLE_COLOR[role],
}));

// DYNAMICALLY import the graph to prevent Next.js SSR crashes
const GraphVisualizer = dynamic(() => import("@/components/GraphVisualizer"), {
  ssr: false,
  loading: () => <p className={styles.stateText}>Unspooling the thread...</p>,
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
    <main className={styles.workspace}>
      <AriadneBackdrop />

      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <Route size={19} strokeWidth={1.45} />
          </div>
          <div>
            <p className={styles.eyebrow}>Provenance map</p>
            <h1 className={styles.title}>
              ariadne <span>/ trace</span>
            </h1>
          </div>
        </div>
        <div className={styles.target}>
          <span className={styles.targetLabel}>Following</span>
          <span>{query ?? "No claim selected"}</span>
          {researchId && <span className={styles.targetId}>#{researchId.slice(0, 8)}</span>}
        </div>
      </header>

      {/* Role legend - provenance roles, not a truth classification. */}
      {query && phase === "done" && (
        <div className={styles.legend}>
          {ROLE_LEGEND.map(({ label, color }) => (
            <span key={label} className="flex items-center gap-2">
              <span className={styles.legendDot} style={{ backgroundColor: color, color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      {!query && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}><Route size={27} strokeWidth={1.3} /></div>
          <p className={styles.stateText}>No thread to follow yet.</p>
          <p className={styles.stateMeta}>Start from the home page and give Ariadne a claim to trace.</p>
        </div>
      )}

      {query && phase !== "done" && phase !== "error" && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}>
            <Loader2 className="animate-spin" size={27} strokeWidth={1.35} />
          </div>
          <p className={styles.stateText}>{status}</p>
          <p className={styles.stateMeta}>Searching for sources, dates, and the relationships between them.</p>
        </div>
      )}

      {query && phase === "error" && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}><AlertTriangle size={27} strokeWidth={1.35} /></div>
          <p className={styles.stateText}>The thread broke before the map was complete.</p>
          <p className={styles.stateMeta}>{error}</p>
        </div>
      )}

      {/* Graph Render */}
      {query && phase === "done" && graphData && (
        <div className={styles.graphRegion}>
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
        <main className={styles.workspace}>
          <AriadneBackdrop />
          <div className={styles.stateCard}>
            <div className={styles.stateIcon}><Loader2 className="animate-spin" size={27} /></div>
          </div>
        </main>
      }
    >
      <TreeView />
    </Suspense>
  );
}
