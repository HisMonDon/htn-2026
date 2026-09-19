"use client";

import React, { useRef, useCallback } from "react";
import ForceGraph from "react-force-graph-2d";

export default function GraphVisualizer({ data }: { data: any }) {
  const fgRef = useRef<any>(null);

  // Determine node color based on type and GPTZero score
  const getNodeColor = (node: any) => {
    if (node.type === "hallucination") return "#ef4444"; // Red for fake claims
    
    // Gradient for articles based on AI probability (0 to 1)
    if (node.aiScore > 0.8) return "#f97316"; // Orange (High AI prob)
    if (node.aiScore > 0.4) return "#eab308"; // Yellow (Mixed)
    return "#22c55e"; // Green (Likely Human)
  };

  const handleNodeClick = useCallback((node: any) => {
    // Zoom in on the clicked node
    if (fgRef.current) {
      fgRef.current.centerAt(node.x, node.y, 1000);
      fgRef.current.zoom(8, 2000);
    }
    
    // You could also open a side-panel here with the article text/summary
    console.log("Node clicked:", node);
  }, []);

  return (
    <ForceGraph
      ref={fgRef}
      graphData={data}
      nodeLabel="title"
      nodeColor={getNodeColor}
      nodeRelSize={2}
      linkColor={() => "rgba(255, 255, 255, 0.2)"}
      linkWidth={1.5}
      onNodeClick={handleNodeClick}
      backgroundColor="#000000"
    />
  );
}