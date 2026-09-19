"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// DYNAMICALLY import the graph to prevent Next.js SSR crashes
const GraphVisualizer = dynamic(() => import("@/components/GraphVisualizer"), {
  ssr: false,
  loading: () => <p>Loading physics engine...</p>,
});

export default function TreePage() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q"); // The seed URL or topic from landing page

  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Initializing Ariadne Protocol...");

  useEffect(() => {
    if (!query) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fake status updates for a better UX while backend works
        setTimeout(() => setStatus("Deploying Browserbase spiders..."), 2000);
        setTimeout(() => setStatus("Analyzing text via GPTZero..."), 5000);
        setTimeout(() => setStatus("Extracting hallucinations..."), 8000);

        // Fetch to your Python backend
        const response = await fetch(`http://localhost:8000/api/trace?query=${encodeURIComponent(query)}`);
        const data = await response.json();
        
        setGraphData(data);
      } catch (error) {
        console.error("Failed to fetch graph data:", error);
        setStatus("Error: Failed to trace network.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [query]);

  return (
    <main className="w-full h-screen bg-black text-white overflow-hidden relative">
      {/* Header Overlay */}
      <div className="absolute top-0 left-0 w-full p-6 z-10 pointer-events-none flex justify-between items-center">
        <h2 className="text-2xl font-bold tracking-tighter text-white/80">
          Ariadne <span className="text-gray-500 font-normal">/</span> Trace
        </h2>
        <div className="text-sm text-gray-400 bg-white/5 px-4 py-2 rounded-full border border-white/10 backdrop-blur-md">
          Target: <span className="text-white">{query}</span>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex flex-col items-center justify-center w-full h-full space-y-6">
          <Loader2 className="w-12 h-12 text-white animate-spin opacity-50" />
          <p className="text-lg text-gray-400 animate-pulse">{status}</p>
        </div>
      )}

      {/* Graph Render */}
      {!loading && graphData && (
        <div className="w-full h-full cursor-grab active:cursor-grabbing">
          <GraphVisualizer data={graphData} />
        </div>
      )}
    </main>
  );
}