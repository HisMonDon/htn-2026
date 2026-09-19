"use client";

import React, { useRef, useCallback, useState } from "react";
import ForceGraph from "react-force-graph-2d";
import { X, ExternalLink, AlertTriangle, BrainCircuit } from "lucide-react";

export default function GraphVisualizer({ data }: { data: any }) {
  const fgRef = useRef<any>(null);
  
  // State to track the clicked node
  const [selectedNode, setSelectedNode] = useState<any>(null);

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
    
    // Set the node data to open the side panel
    setSelectedNode(node);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    // Close the side panel when clicking empty space
    setSelectedNode(null);
  }, []);

  return (
    <div className="relative w-full h-full">
      {/* The Graph */}
      <ForceGraph
        ref={fgRef}
        graphData={data}
        nodeLabel="title"
        nodeColor={getNodeColor}
        nodeRelSize={1.5}
        linkColor={() => "rgba(242, 218, 81, 0.4)"}
        linkWidth={1.5}
        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        backgroundColor="#000000"
        linkDirectionalArrowLength={3}
      />

      {/* The Side Panel */}
      <div 
        className={`absolute top-0 right-0 h-full w-96 bg-black/80 backdrop-blur-xl border-l border-white/10 p-6 text-white transition-transform duration-300 ease-in-out z-50 overflow-y-auto ${
          selectedNode ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {selectedNode && (
          <div className="flex flex-col h-full space-y-6">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className="text-lg font-semibold tracking-wide text-gray-200 uppercase flex items-center">
                {selectedNode.type === "article" ? (
                  <><ExternalLink size={18} className="mr-2 text-blue-400" /> Article Details</>
                ) : (
                  <><AlertTriangle size={18} className="mr-2 text-red-500" /> Detected Claim</>
                )}
              </h3>
              <button 
                onClick={() => setSelectedNode(null)}
                className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content Based on Node Type */}
            {selectedNode.type === "article" && (
              <div className="space-y-6">
                <div>
                  <p className="text-sm text-gray-500 uppercase mb-1">Source URL</p>
                  <a 
                    href={selectedNode.id} 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline break-all text-sm"
                  >
                    {selectedNode.id}
                  </a>
                </div>

                <div className="bg-white/5 p-4 rounded-xl border border-white/10">
                  <p className="text-sm text-gray-400 uppercase mb-2 flex items-center">
                    <BrainCircuit size={16} className="mr-2" /> GPTZero Analysis
                  </p>
                  <div className="flex items-end justify-between mb-2">
                    <span className="text-3xl font-bold" style={{ color: getNodeColor(selectedNode) }}>
                      {(selectedNode.aiScore * 100).toFixed(1)}%
                    </span>
                    <span className="text-sm text-gray-500 mb-1">AI Generated</span>
                  </div>
                  
                  {/* Progress Bar */}
                  <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div 
                      className="h-full rounded-full transition-all duration-1000"
                      style={{ 
                        width: `${selectedNode.aiScore * 100}%`,
                        backgroundColor: getNodeColor(selectedNode)
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {selectedNode.type === "hallucination" && (
              <div className="space-y-6">
                <div className="bg-red-500/10 p-4 rounded-xl border border-red-500/30">
                  <p className="text-sm text-red-400 uppercase font-semibold mb-2">Flagged AI Text</p>
                  <p className="text-gray-200 leading-relaxed italic text-lg">
                    "{selectedNode.full_text || selectedNode.title}"
                  </p>
                </div>
                <p className="text-sm text-gray-400">
                  This exact sentence was heavily flagged by GPTZero as synthetic generation and is acting as a spreader node in this network.
                </p>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}