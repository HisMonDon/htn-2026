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
  hasTimestampConflict,
  isSubmittedNode,
  type GraphData,
  type GraphLink,
  type GraphNode,
} from "@/lib/graph";
import { displayTitle, formatDate, formatTimestamp, passagePreview, percent } from "@/lib/format";
import { computePrimaryParents, computeProvenanceLayout, LAYER_GAP, NODE_GAP } from "@/lib/layout";
import { ConfidenceBar, Drawer, Field, StringList, TypedCard } from "./panel-ui";
import RejectedEvidencePanel, { type EvidenceTab } from "./RejectedEvidencePanel";

const ORDERING_NOTE: Record<string, string> = {
  strict: "The parent's publication time precedes the child's.",
  "same-time": "Both documents carry the same publication time; order is not separable from timestamps alone.",
  "from-link": "Order was inferred from link evidence, not from a reliable publication timestamp.",
  unknown: "Publication order could not be established from the available timestamps.",
};

/**
 * Provenance strength — how sure Ariadne is that this edge is a real propagation link — never a
 * statement about whether the linked document agrees with the claim. See `ClaimRelationship`
 * below for that independent axis.
 */
const PROVENANCE_STATUS_LABEL: Record<string, string> = {
  validated: "Validated",
  probable: "Probable",
  related: "Related (investigative crosslink)",
  citation: "Citation",
  candidate: "Candidate match",
};

const PROVENANCE_STATUS_NOTE: Record<string, string> = {
  probable: "Meaningful provenance evidence exists, but it falls below the strict validated threshold.",
  related: "A meaningfully connected document worth investigating. Not a provenance claim, and excluded from mutation analysis.",
  citation: "Recovered from a citation graph (e.g. Semantic Scholar), not from Ariadne's own scoring.",
};

/**
 * Whether a related/cited document semantically agrees with the claim — independent of how
 * strong its provenance link is. Only rendered when the backend supplies it; never inferred here.
 */
const CLAIM_RELATIONSHIP_LABEL: Record<string, string> = {
  supports: "Supports the claim",
  contradicts: "Contradicts the claim",
  modifies: "Modifies the claim",
  extends: "Extends the claim",
  unrelated: "Unrelated to the claim",
};

const UNKNOWN_COLOR = "#6b7280";

function Endpoint({ id, node, role }: { id: string | null; node: GraphNode | undefined; role: string }) {
  return (
    <TypedCard color={node ? ROLE_COLOR[node.role] : UNKNOWN_COLOR} className="px-3 py-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{role}</p>
      {node ? (
        <>
          <p className="text-sm text-gray-100 leading-snug">{displayTitle(node)}</p>
          <p className="text-xs text-gray-500">{node.publisher || "unknown publisher"}</p>
          {isSubmittedNode(node) ? (
            <p className="mt-1 text-xs text-blue-300/75">User-submitted text</p>
          ) : (
            <a
              href={node.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-blue-400 hover:text-blue-300 underline break-all inline-flex items-center mt-1"
            >
              <ExternalLink size={11} className="mr-1 shrink-0" />
              {node.url}
            </a>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-400 break-all">{id ?? "unknown node"}</p>
      )}
    </TypedCard>
  );
}

const EDGE_COLOR = "#f2da51";
const SELECTED_EDGE_COLOR = "#ffffff";
const FIT_PADDING = 130;
const MAX_INITIAL_ZOOM = 2.6;
const CARD_WIDTH = 194;
const CARD_HEIGHT = 80;
const CARD_RADIUS = 10;

/**
 * Canvas equivalent of React Bits' SpecularButton controls. Pass this as the
 * `specular` prop to tune every provenance card without changing its content
 * or graph behaviour.
 */
export interface GraphNodeSpecularSettings {
  /** One rim colour for every card. Omit it to retain each node role's colour. */
  color?: string;
  /** The low-light edge colour. Omit it to retain each node role's colour. */
  baseColor?: string;
  intensity?: number;
  shineSize?: number;
  shineFade?: number;
  thickness?: number;
  speed?: number;
  /** How quickly the rim light catches up with pointer movement. */
  sensitivity?: number;
  followMouse?: boolean;
  proximity?: number;
  autoAnimate?: boolean;
}

export const DEFAULT_GRAPH_NODE_SPECULAR = {
  intensity: 1.15,
  shineSize: 10,
  shineFade: 40,
  thickness: 1.15,
  speed: 0.35,
  sensitivity: 1,
  followMouse: true,
  proximity: 250,
  autoAnimate: false,
} satisfies Required<Omit<GraphNodeSpecularSettings, "color" | "baseColor">>;

type GraphVisualizerProps = {
  data: GraphData;
  specular?: GraphNodeSpecularSettings;
  /** Optional per-node color override, keyed by node id, for demos that carry their own color coding. */
  nodeAccentColors?: Record<string, string>;
};

type GraphPointerPosition = { x: number; y: number };

function Passage({ value }: { value: string }) {
  const preview = passagePreview(value);

  if (!preview.text) return <span className="text-gray-500">none captured</span>;

  return (
    <div className="space-y-3">
      <p className="italic leading-relaxed text-gray-300">{preview.text}</p>
      {preview.truncated && (
        <details className="group rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2">
          <summary className="cursor-pointer list-none text-xs text-blue-300/75 transition-colors hover:text-blue-200">
            <span className="group-open:hidden">View full extracted passage</span>
            <span className="hidden group-open:inline">Hide full extracted passage</span>
          </summary>
          <p className="mt-3 whitespace-pre-wrap border-t border-white/8 pt-3 text-sm italic leading-relaxed text-gray-400">
            {value}
          </p>
        </details>
      )}
    </div>
  );
}

// Render helpers
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const safeR = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeR, y);
  ctx.lineTo(x + w - safeR, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + safeR);
  ctx.lineTo(x + w, y + h - safeR);
  ctx.quadraticCurveTo(x + w, y + h, x + w - safeR, y + h);
  ctx.lineTo(x + safeR, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - safeR);
  ctx.lineTo(x, y + safeR);
  ctx.quadraticCurveTo(x, y, x + safeR, y);
  ctx.closePath();
}

/** Tints a card's dark background toward a demo-supplied accent color instead of the usual role hue. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function smoothRange(value: number, start: number, end: number) {
  if (start === end) return value >= end ? 1 : 0;
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function shortestAngleDelta(from: number, to: number) {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function specularStrength(normalAngle: number, lightAngle: number, shineSize: number, shineFade: number) {
  const alignment = Math.abs(Math.cos(normalAngle - lightAngle));
  const phi = Math.acos(Math.max(0, Math.min(1, alignment)));
  const size = (Math.max(0, shineSize) * Math.PI) / 180;
  const fade = (Math.max(0, shineFade) * Math.PI) / 180;
  return 1 - smoothRange(phi, Math.max(0, size - fade), size + fade + 0.0001);
}

function drawSpecularRim(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  {
    color,
    baseColor,
    intensity,
    shineSize,
    shineFade,
    thickness,
    angle,
  }: {
    color: string;
    baseColor: string;
    intensity: number;
    shineSize: number;
    shineFade: number;
    thickness: number;
    angle: number;
  }
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  const lineWidth = Math.max(0.25, thickness);

  context.save();
  context.setLineDash([]);
  context.lineCap = "round";
  context.lineWidth = lineWidth;
  context.strokeStyle = baseColor;
  context.globalAlpha *= 0.42;
  roundedRect(context, x, y, width, height, safeRadius);
  context.stroke();
  context.restore();

  if (intensity <= 0) return;

  const drawSegment = (fromX: number, fromY: number, toX: number, toY: number, normalAngle: number) => {
    const strength = specularStrength(normalAngle, angle, shineSize, shineFade) * intensity;
    if (strength <= 0.001) return;
    context.save();
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.strokeStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 4 + 7 * strength;
    context.globalAlpha *= Math.min(1, strength);
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.restore();
  };

  drawSegment(x + safeRadius, y, x + width - safeRadius, y, -Math.PI / 2);
  drawSegment(x + width, y + safeRadius, x + width, y + height - safeRadius, 0);
  drawSegment(x + width - safeRadius, y + height, x + safeRadius, y + height, Math.PI / 2);
  drawSegment(x, y + height - safeRadius, x, y + safeRadius, Math.PI);

  const corners = [
    { x: x + width - safeRadius, y: y + safeRadius, start: -Math.PI / 2 },
    { x: x + width - safeRadius, y: y + height - safeRadius, start: 0 },
    { x: x + safeRadius, y: y + height - safeRadius, start: Math.PI / 2 },
    { x: x + safeRadius, y: y + safeRadius, start: Math.PI },
  ];

  for (const corner of corners) {
    for (let step = 0; step < 6; step++) {
      const start = corner.start + (Math.PI / 2) * (step / 6);
      const end = corner.start + (Math.PI / 2) * ((step + 1) / 6);
      const strength = specularStrength((start + end) / 2, angle, shineSize, shineFade) * intensity;
      if (strength <= 0.001) continue;
      context.save();
      context.lineWidth = lineWidth;
      context.strokeStyle = color;
      context.shadowColor = color;
      context.shadowBlur = 4 + 7 * strength;
      context.globalAlpha *= Math.min(1, strength);
      context.beginPath();
      context.arc(corner.x, corner.y, safeRadius, start, end);
      context.stroke();
      context.restore();
    }
  }
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, points: number, inset: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? radius : radius * inset;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
  }
  ctx.closePath();
  ctx.fill();
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
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = lines.length === 1 ? words.slice(words.indexOf(word)).join(" ") : word;
      if (lines.length === 1) break;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  return lines.slice(0, 2).map((line) => fitText(context, line, maxWidth));
}

/**
 * A crosslink whose endpoints sit almost side by side vertically but many columns apart
 * horizontally would otherwise draw as a shallow diagonal that cuts straight through every card
 * in between. Past this horizontal/vertical ratio, route it below the row band instead: dip down
 * clear of any card, travel across, then rise straight into the target from underneath.
 */
const LONG_CROSSLINK_MIN_SPAN = LAYER_GAP * 2;
const LONG_CROSSLINK_MAX_VERTICAL_GAP = NODE_GAP * 1.5;
const LONG_CROSSLINK_DIP = NODE_GAP * 2.1;

function isLongFlatCrosslink(source: { x: number; y: number }, target: { x: number; y: number }) {
  return (
    Math.abs(target.x - source.x) > LONG_CROSSLINK_MIN_SPAN &&
    Math.abs(target.y - source.y) < LONG_CROSSLINK_MAX_VERTICAL_GAP
  );
}

// Spline calculation helpers
function getSplinePoints(source: { x: number; y: number }, target: { x: number; y: number }, detour = false) {
  if (detour) {
    // Dip below both endpoints, cross underneath the intervening columns, then rise straight up
    // into the target — an underneath detour instead of a diagonal drawn through the middle.
    const dip = Math.max(source.y, target.y) + LONG_CROSSLINK_DIP;
    const dx = Math.max(Math.abs(target.x - source.x) * 0.25, 45);
    return [
      { x: source.x, y: source.y },
      { x: source.x + dx, y: dip },
      { x: target.x, y: dip },
      { x: target.x, y: target.y },
    ] as const;
  }
  const dx = Math.max(Math.abs(target.x - source.x) * 0.45, 45);
  return [
    { x: source.x, y: source.y },
    { x: source.x + dx, y: source.y },
    { x: target.x - dx, y: target.y },
    { x: target.x, y: target.y },
  ] as const;
}

function getBezierPoint(t: number, p0: any, p1: any, p2: any, p3: any) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  return {
    x: mt * mt2 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t * t2 * p3.x,
    y: mt * mt2 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t * t2 * p3.y,
  };
}

function getBezierAngle(t: number, p0: any, p1: any, p2: any, p3: any) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  const dx = 3 * mt2 * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t2 * (p3.x - p2.x);
  const dy = 3 * mt2 * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t2 * (p3.y - p2.y);
  return Math.atan2(dy, dx);
}

// Smooth camera easing: C^2 continuous 5th-order polynomial smoothstep
function smoothStepCamera(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export default function GraphVisualizer({ data, specular, nodeAccentColors }: GraphVisualizerProps) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<GraphPointerPosition | null>(null);
  const specularRefreshFrame = useRef<number | null>(null);
  
  const [animPhase, setAnimPhase] = useState<"sequence" | "complete">("sequence");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<GraphLink | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<GraphLink | null>(null);
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("rejected");
  const [specularPointer, setSpecularPointer] = useState<GraphPointerPosition | null>(null);

  const specularSettings = useMemo(
    () => ({ ...DEFAULT_GRAPH_NODE_SPECULAR, ...specular }),
    [specular]
  );

  const requestSpecularRefresh = useCallback(() => {
    if (specularRefreshFrame.current !== null) return;
    specularRefreshFrame.current = requestAnimationFrame(() => {
      specularRefreshFrame.current = null;
      // Store the newest sampled point once per frame. This updates the canvas
      // callback without asking React to render for every browser pointer event.
      setSpecularPointer(pointerRef.current);
    });
  }, []);

  useEffect(() => () => {
    if (specularRefreshFrame.current !== null) cancelAnimationFrame(specularRefreshFrame.current);
  }, []);

  const handleGraphPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const graph = fgRef.current;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!graph || !bounds) return;
    pointerRef.current = graph.screen2GraphCoords(event.clientX - bounds.left, event.clientY - bounds.top);
    requestSpecularRefresh();
  }, [requestSpecularRefresh]);

  const handleGraphPointerLeave = useCallback(() => {
    pointerRef.current = null;
    requestSpecularRefresh();
  }, [requestSpecularRefresh]);

  const nodesById = useMemo(() => new Map(data.nodes.map((node) => [node.id, node])), [data.nodes]);
  const focusId = hoveredNode?.id ?? selectedNode?.id ?? null;

  const focusedNodeIds = useMemo(() => {
    if (!focusId) return null;
    const parents = new Map<string, Set<string>>(data.nodes.map((n) => [n.id, new Set()]));
    const children = new Map<string, Set<string>>(data.nodes.map((n) => [n.id, new Set()]));
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
      for (let i = 0; i < queue.length; i++) {
        for (const next of relationships.get(queue[i]!) ?? []) {
          if (!lineage.has(next)) { lineage.add(next); queue.push(next); }
        }
      }
    };
    walk(parents);
    walk(children);
    return lineage;
  }, [data.links, data.nodes, focusId]);

  const positioned = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => {
    const positions = computeProvenanceLayout(data.nodes, data.links);
    const nodes = data.nodes.map((n) => {
      const point = positions.get(n.id);
      return point ? { ...n, fx: point.x, fy: point.y, x: point.x, y: point.y } : { ...n };
    });
    const links = data.links.map((l) => ({
      ...l,
      source: endpointId(l.source) ?? l.parent_id,
      target: endpointId(l.target) ?? l.child_id,
    }));
    return { nodes, links };
  }, [data]);

  /**
   * The same primary-parent choice the layout used to assign depth (lib/layout.ts), reused here
   * purely for edge styling: an edge that is somebody's chosen primary parent draws as the
   * strong hierarchy line; every other accepted edge — a second/third parent, a related or
   * citation crosslink — draws as a secondary crosslink. No graph data changes; this only
   * decides which line gets which paint.
   */
  const primaryEdgeKeys = useMemo(() => {
    const primaryParents = computePrimaryParents(data.nodes, data.links);
    const keys = new Set<string>();
    for (const [child, parent] of primaryParents) {
      if (parent) keys.add(`${parent} ${child}`);
    }
    return keys;
  }, [data.nodes, data.links]);

  const isPrimaryLink = useCallback(
    (link: GraphLink) => {
      const parent = endpointId(link.source) ?? link.parent_id;
      const child = endpointId(link.target) ?? link.child_id;
      if (!parent || !child) return false;
      return primaryEdgeKeys.has(`${parent} ${child}`);
    },
    [primaryEdgeKeys]
  );

  // Cinematic sequence controller
  const seqState = useRef({
    state: "focus",
    startTime: 0,
    startCam: { x: 0, y: 0, z: 1 },
    targetCam: { x: 0, y: 0, z: 1 },
    frameId: 0,
  });

  useEffect(() => {
    if (!wrapperRef.current || !fgRef.current || positioned.nodes.length === 0) return;

    const graph = fgRef.current;
    const wrap = wrapperRef.current;
    const { width, height } = wrap.getBoundingClientRect();

    const rootNode = positioned.nodes.find((n) => n.is_root || n.is_seed) || positioned.nodes[0];
    const rootX = rootNode?.x ?? 0;
    const rootY = rootNode?.y ?? 0;

    const minX = Math.min(...positioned.nodes.map((n) => n.x ?? 0));
    const maxX = Math.max(...positioned.nodes.map((n) => n.x ?? 0));
    const minY = Math.min(...positioned.nodes.map((n) => n.y ?? 0));
    const maxY = Math.max(...positioned.nodes.map((n) => n.y ?? 0));

    const targetX = (minX + maxX) / 2;
    const targetY = (minY + maxY) / 2;

    const dy = Math.max(maxY - minY + FIT_PADDING * 2, 1);
    
    // Fit vertically, but allow horizontal overflow to maintain constant column depths.
    // Cap zoom-out at 0.65 to ensure text and nodes don't shrink away on massive trees.
    const targetZ = Math.max(0.65, Math.min(height / dy, MAX_INITIAL_ZOOM));

    seqState.current = {
      ...seqState.current,
      state: "focus",
      startCam: { x: rootX, y: rootY, z: 3.5 },
      targetCam: { x: targetX, y: targetY, z: targetZ },
    };

    graph.centerAt(rootX, rootY, 0);
    graph.zoom(3.5, 0);

    // Initial mask centered on the screen, offset +60px to right so the central star 
    // is safely enclosed in the visible (black) gradient area.
    wrap.style.maskImage = `linear-gradient(to right, black calc(50% + 60px), transparent calc(50% + 160px))`;

    // Fast 400ms focus time before panning begins
    const timer = setTimeout(() => {
      seqState.current.state = "pan";
      seqState.current.startTime = performance.now();
    }, 400);

    const tick = (now: number) => {
      const s = seqState.current;

      if (s.state === "pan") {
        const t = Math.min(1, (now - s.startTime) / 3500); 
        const eased = smoothStepCamera(t);
        const cx = s.startCam.x + (s.targetCam.x - s.startCam.x) * eased;
        const cy = s.startCam.y + (s.targetCam.y - s.startCam.y) * eased;
        const cz = s.startCam.z + (s.targetCam.z - s.startCam.z) * eased;

        graph.centerAt(cx, cy, 0);
        graph.zoom(cz, 0);

        // Keep the mask stationed at the center for the first half to unspool the thread.
        // Then smoothly sweep it to the far right (+150%) to reveal the leaf nodes.
        const maskT = Math.max(0, (t - 0.5) / 0.5); 
        const maskEased = maskT * maskT * (3 - 2 * maskT);
        const wipeVal = 50 + 100 * maskEased;
        
        const cssMask = `linear-gradient(to right, black calc(${wipeVal}% + 60px), transparent calc(${wipeVal}% + 160px))`;
        wrap.style.maskImage = cssMask;

        if (t === 1) {
          s.state = "complete";
          wrap.style.maskImage = "";
          setAnimPhase("complete");
        }
      }

      if (s.state !== "complete") {
        s.frameId = requestAnimationFrame(tick);
      }
    };

    seqState.current.frameId = requestAnimationFrame(tick);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(seqState.current.frameId);
    };
  }, [positioned]);

  const fitToView = useCallback(() => {
    const graph = fgRef.current;
    if (!graph) return;
    graph.zoomToFit(400, FIT_PADDING);
    setTimeout(() => { if (graph.zoom() > MAX_INITIAL_ZOOM) graph.zoom(MAX_INITIAL_ZOOM, 200); }, 450);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const graph = fgRef.current;
    if (graph) graph.zoom(Math.max(0.35, Math.min(5, graph.zoom() * factor)), 280);
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (animPhase !== "complete") return;
    if (fgRef.current && node.x !== undefined && node.y !== undefined) {
      const graph = fgRef.current;
      graph.centerAt(node.x + 90, node.y, 650);
      graph.zoom(Math.max(graph.zoom(), 1.25), 650);
    }
    setEvidencePanelOpen(false);
    setSelectedLink(null);
    setSelectedNode(node);
  }, [animPhase]);

  const handleLinkClick = useCallback((link: GraphLink) => {
    if (animPhase !== "complete") return;
    setEvidencePanelOpen(false);
    setSelectedNode(null);
    setSelectedLink(link);
  }, [animPhase]);

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

  const parentId = selectedLink ? endpointId(selectedLink.source) ?? selectedLink.parent_id : null;
  const childId = selectedLink ? endpointId(selectedLink.target) ?? selectedLink.child_id : null;
  const parentNode = parentId ? nodesById.get(parentId) : undefined;
  const childNode = childId ? nodesById.get(childId) : undefined;
  const panelOpen = Boolean(selectedNode || selectedLink);
  const selectedNodeSubmitted = selectedNode ? isSubmittedNode(selectedNode) : false;
  const selectedNodeHasTimestampConflict = selectedNode ? hasTimestampConflict(selectedNode) : false;
  const selectedLinkIsCandidate = selectedLink?.kind === "candidate_match";

  const isFocusedLink = useCallback(
    (link: GraphLink) => {
      if (!focusedNodeIds) return false;
      const src = endpointId(link.source) ?? link.parent_id;
      const tgt = endpointId(link.target) ?? link.child_id;
      return Boolean(src && tgt && focusedNodeIds.has(src) && focusedNodeIds.has(tgt));
    },
    [focusedNodeIds]
  );

  const paintNode = useCallback(
    (node: GraphNode, context: CanvasRenderingContext2D) => {
      if (node.x === undefined || node.y === undefined) return;
      
      const a = (node as any).__anim || { hover: 0, pop: 0, flash: 0 };
      (node as any).__anim = a;
      a.specularAngle ??= 2.4;
      a.specularBrightness ??= 0;
      a.specularUpdatedAt ??= performance.now();

      const isHovered = selectedNode?.id === node.id || hoveredNode?.id === node.id;
      const related = !focusedNodeIds || focusedNodeIds.has(node.id);
      const submitted = isSubmittedNode(node);

      // Smooth interpolations - rate reduced to 0.08 for buttery soft transitions
      a.hover += ((isHovered ? 1 : 0) - a.hover) * 0.08;
      
      const targetPop = animPhase === "complete" ? 1 : 0;
      if (targetPop === 1 && a.pop === 0 && a.flash === 0) a.flash = 1;
      a.pop += (targetPop - a.pop) * 0.12;
      a.flash *= 0.90;

      const roleColor = nodeAccentColors?.[node.id] ?? ROLE_COLOR[node.role];
      const cx = node.x;
      const cy = node.y;
      const cardScale = 0.8 + 0.2 * a.pop + 0.04 * a.hover;
      const pointer = specularPointer;
      const now = performance.now();
      const dt = Math.min((now - a.specularUpdatedAt) / 1000, 0.05);
      a.specularUpdatedAt = now;
      const idleAngle = 2.4 + now * 0.001 * specularSettings.speed;
      let proximity = 0;
      let pointerAngle = idleAngle;

      if (pointer) {
        const localX = pointer.x - cx;
        const localY = pointer.y - cy;
        const halfWidth = (CARD_WIDTH * cardScale) / 2;
        const halfHeight = (CARD_HEIGHT * cardScale) / 2;
        const dx = Math.max(Math.abs(localX) - halfWidth, 0);
        const dy = Math.max(Math.abs(localY) - halfHeight, 0);
        const distance = Math.hypot(dx, dy);
        proximity = smoothRange(1 - distance / Math.max(specularSettings.proximity, 1), 0, 1);
        pointerAngle = distance === 0
          ? Math.atan2(2 / CARD_HEIGHT, -2 / CARD_WIDTH) + (localX / halfWidth) * 0.3 - (localY / halfHeight) * 0.15
          : Math.atan2(-localY, localX);
      }

      const targetAngle = specularSettings.followMouse && pointer ? pointerAngle : idleAngle;
      const response = 1 - Math.exp(-dt * 7 * Math.max(0.01, specularSettings.sensitivity));
      a.specularAngle += shortestAngleDelta(a.specularAngle, targetAngle) * response;
      const targetBrightness = specularSettings.autoAnimate ? 1 : proximity;
      a.specularBrightness += (targetBrightness - a.specularBrightness) * (1 - Math.exp(-dt * 8 * Math.max(0.01, specularSettings.sensitivity)));

      context.save();
      context.globalAlpha = related ? 1 : 0.17;
      context.shadowColor = isHovered ? roleColor : `${roleColor}88`;
      context.shadowBlur = 10 + a.hover * 15;

      if (a.pop < 0.99) {
        context.save();
        context.globalAlpha = (related ? 1 : 0.17) * (1 - a.pop);
        context.fillStyle = roleColor;
        
        if (node.is_root || node.is_seed) {
          context.shadowColor = "#ffffff";
          context.fillStyle = "#ffffff";
          drawStar(context, cx, cy, 14, 5, 0.4);
        } else {
          context.beginPath();
          context.arc(cx, cy, 8, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }

      if (a.pop > 0.01) {
        context.save();
        context.globalAlpha = (related ? 1 : 0.17) * a.pop;
        context.translate(cx, cy);
        
        // Slight organic scale bump when hovered
        context.scale(cardScale, cardScale);

        const x = -CARD_WIDTH / 2;
        const y = -CARD_HEIGHT / 2;
        const cardRadius = submitted ? 18 : CARD_RADIUS;

        const accentColor = nodeAccentColors?.[node.id];
        const fill = context.createLinearGradient(x, y, x + CARD_WIDTH, y + CARD_HEIGHT);
        fill.addColorStop(
          0,
          accentColor
            ? hexToRgba(accentColor, a.hover > 0.5 ? 0.42 : 0.34)
            : submitted
              ? (a.hover > 0.5 ? "rgba(25, 49, 82, 0.98)" : "rgba(17, 35, 62, 0.96)")
              : (a.hover > 0.5 ? "rgba(37, 24, 50, 0.98)" : "rgba(23, 16, 33, 0.96)")
        );
        fill.addColorStop(
          1,
          accentColor
            ? hexToRgba(accentColor, a.hover > 0.5 ? 0.24 : 0.18)
            : submitted
              ? (a.hover > 0.5 ? "rgba(13, 28, 52, 0.98)" : "rgba(9, 21, 40, 0.96)")
              : (a.hover > 0.5 ? "rgba(17, 12, 27, 0.98)" : "rgba(10, 8, 17, 0.96)")
        );
        
        roundedRect(context, x, y, CARD_WIDTH, CARD_HEIGHT, cardRadius);
        context.fillStyle = fill;
        context.fill();
        context.shadowBlur = 0;
        drawSpecularRim(context, x, y, CARD_WIDTH, CARD_HEIGHT, cardRadius, {
          color: specularSettings.color ?? roleColor,
          baseColor: specularSettings.baseColor ?? roleColor,
          intensity: specularSettings.intensity * a.specularBrightness,
          shineSize: specularSettings.shineSize,
          shineFade: specularSettings.shineFade,
          thickness: specularSettings.thickness + a.hover * 0.35,
          angle: a.specularAngle,
        });

        context.save();
        roundedRect(context, x, y, CARD_WIDTH, CARD_HEIGHT, cardRadius);
        context.clip();
        if (!submitted) {
          context.fillStyle = roleColor;
          context.fillRect(x, y, 2 + a.hover * 1.5, CARD_HEIGHT);
        }
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
        context.fillText(fitText(context, (node.publisher || "unknown").toUpperCase(), 118), x + 13, y + 14);

        context.textAlign = "right";
        context.fillStyle = "rgba(227, 215, 237, 0.48)";
        const dateLabel = hasTimestampConflict(node) && !node.timestamp
          ? "CONFLICTING DATES"
          : formatDate(node.timestamp).toUpperCase();
        if (!submitted) context.fillText(dateLabel, x + CARD_WIDTH - 12, y + 14);

        context.textAlign = "left";
        context.font = "500 9.5px Geist, ui-sans-serif, system-ui, sans-serif";
        context.fillStyle = "rgba(251, 248, 253, 0.94)";
        titleLines(context, displayTitle(node), CARD_WIDTH - 26).forEach((l, i) => context.fillText(l, x + 13, y + 35 + i * 12));

        context.font = "500 6.2px ui-monospace, SFMono-Regular, Menlo, monospace";
        context.fillStyle = "rgba(221, 207, 232, 0.42)";
        context.fillText(ROLE_LABEL[node.role].toUpperCase(), x + 13, y + CARD_HEIGHT - 10);

        context.beginPath();
        context.arc(x + CARD_WIDTH - 14, y + CARD_HEIGHT - 10, 2.4 + a.hover * 1.2, 0, Math.PI * 2);
        context.fillStyle = roleColor;
        context.fill();

        if (a.flash > 0.01) {
          roundedRect(context, x, y, CARD_WIDTH, CARD_HEIGHT, cardRadius);
          context.fillStyle = `rgba(255,255,255, ${a.flash * 0.8})`;
          context.fill();
        }
        
        context.restore();
      }

      context.restore();
    },
    [animPhase, focusedNodeIds, hoveredNode?.id, selectedNode?.id, specularPointer, specularSettings, nodeAccentColors]
  );

  const paintNodePointerArea = useCallback(
    (node: GraphNode, color: string, context: CanvasRenderingContext2D) => {
      if (node.x === undefined || node.y === undefined) return;
      if (animPhase !== "complete") {
        context.beginPath();
        context.arc(node.x, node.y, 14, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        return;
      }
      roundedRect(
        context,
        node.x - CARD_WIDTH / 2,
        node.y - CARD_HEIGHT / 2,
        CARD_WIDTH,
        CARD_HEIGHT,
        isSubmittedNode(node) ? 18 : CARD_RADIUS
      );
      context.fillStyle = color;
      context.fill();
    },
    [animPhase]
  );

  const paintLinkPointerArea = useCallback(
    (link: GraphLink, color: string, context: CanvasRenderingContext2D) => {
      if (animPhase !== "complete") return;
      const source = link.source as unknown as GraphNode;
      const target = link.target as unknown as GraphNode;
      if (source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return;

      const detour = !isPrimaryLink(link) && link.kind !== "candidate_match" &&
        isLongFlatCrosslink({ x: source.x, y: source.y }, { x: target.x, y: target.y });
      const [p0, p1, p2, p3] = getSplinePoints(
        { x: source.x, y: source.y },
        { x: target.x, y: target.y },
        detour
      );
      context.beginPath();
      context.moveTo(p0.x, p0.y);
      context.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      context.lineWidth = 14;
      context.strokeStyle = color;
      context.stroke();
    },
    [animPhase, isPrimaryLink]
  );

  const paintLink = useCallback(
    (link: GraphLink, context: CanvasRenderingContext2D) => {
      const source = link.source as unknown as GraphNode;
      const target = link.target as unknown as GraphNode;
      if (source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return;

      const a = (link as any).__anim || { hover: 0, pop: 0 };
      (link as any).__anim = a;

      const isHovered = link === selectedLink || link === hoveredLink || isFocusedLink(link);
      const candidateMatch = link.kind === "candidate_match";
      // Secondary crosslinks: an accepted edge that isn't anyone's chosen layout parent — a second
      // or third source into the same document, a related/citation link, etc. Kept fully in the
      // graph, just painted lighter so the primary hierarchy reads clearly (req. 4).
      const secondary = !candidateMatch && !isPrimaryLink(link);
      a.hover += ((isHovered ? 1 : 0) - a.hover) * 0.08;
      a.pop += ((animPhase === "complete" ? 1 : 0) - a.pop) * 0.12;

      let strokeColor = candidateMatch
        ? `rgba(125, 211, 252, ${0.18 + 0.28 * link.confidence})`
        : secondary
          ? `rgba(180, 150, 200, ${0.16 + 0.22 * link.confidence})`
          : `rgba(223, 171, 84, ${0.34 + 0.46 * link.confidence})`;
      if (link === selectedLink) strokeColor = SELECTED_EDGE_COLOR;
      else if (focusedNodeIds && !isFocusedLink(link)) strokeColor = "rgba(155, 125, 179, 0.07)";
      else if (isFocusedLink(link)) {
        strokeColor = candidateMatch
          ? `rgba(186, 230, 253, ${0.46 + 0.36 * link.confidence})`
          : secondary
            ? `rgba(216, 191, 232, ${0.4 + 0.3 * link.confidence})`
            : `rgba(247, 202, 111, ${0.58 + 0.38 * link.confidence})`;
      }

      const baseWidth = candidateMatch || secondary ? 0.55 + 0.7 * link.confidence : 1 + 1.5 * link.confidence;
      const targetWidth = baseWidth * (0.6 + 0.4 * a.pop) + (0.9 + (link === selectedLink ? 1.3 : 0)) * a.hover;

      const detour = secondary && isLongFlatCrosslink({ x: source.x, y: source.y }, { x: target.x, y: target.y });
      const [p0, p1, p2, p3] = getSplinePoints(
        { x: source.x, y: source.y },
        { x: target.x, y: target.y },
        detour
      );

      context.beginPath();
      context.moveTo(p0.x, p0.y);
      context.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      context.lineWidth = targetWidth;
      context.strokeStyle = strokeColor;
      context.lineCap = "round";
      context.setLineDash(candidateMatch ? [5, 5] : secondary ? [2, 4] : []);
      context.stroke();
      context.setLineDash([]);

      if (a.pop > 0.01) {
        context.save();
        context.globalAlpha = a.pop;
        const arrowRelPos = 0.92;
        const arrowPoint = getBezierPoint(arrowRelPos, p0, p1, p2, p3);
        const arrowAngle = getBezierAngle(arrowRelPos, p0, p1, p2, p3);
        const arrowColor = candidateMatch
          ? (link === selectedLink || isFocusedLink(link) ? "rgba(224, 242, 254, 0.9)" : "rgba(125, 211, 252, 0.48)")
          : secondary
            ? (link === selectedLink || isFocusedLink(link) ? "rgba(224, 208, 236, 0.85)" : "rgba(180, 150, 200, 0.4)")
            : (link === selectedLink || isFocusedLink(link) ? "rgba(255, 221, 145, 0.95)" : "rgba(223, 171, 84, 0.68)");

        context.translate(arrowPoint.x, arrowPoint.y);
        context.rotate(arrowAngle);
        context.beginPath();
        context.moveTo(0, 0);
        context.lineTo(-5.5, 2.2);
        context.lineTo(-4.4, 0);
        context.lineTo(-5.5, -2.2);
        context.closePath();
        context.fillStyle = arrowColor;
        context.fill();
        context.restore();

        if (a.hover > 0.3) {
          const time = performance.now();
          context.fillStyle = candidateMatch
            ? `rgba(186, 230, 253, ${a.hover})`
            : `rgba(255, 228, 163, ${a.hover})`;
          for (let i = 0; i < 2; i++) {
            const t = ((time * 0.0006) + i / 2) % 1;
            const pt = getBezierPoint(t, p0, p1, p2, p3);
            context.beginPath();
            context.arc(pt.x, pt.y, 1.2 * a.hover, 0, Math.PI * 2);
            context.fill();
          }
        }
      }
    },
    [animPhase, selectedLink, hoveredLink, focusedNodeIds, isFocusedLink, isPrimaryLink]
  );

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div
        ref={wrapperRef}
        className="absolute inset-0"
        onPointerMove={handleGraphPointerMove}
        onPointerLeave={handleGraphPointerLeave}
      >
        <ForceGraph<GraphNode, GraphLink>
          ref={fgRef}
          graphData={positioned}
          cooldownTicks={Infinity}
          d3AlphaDecay={0}
          d3VelocityDecay={1}
          enableNodeDrag={false}
          enableZoomInteraction={animPhase === "complete"}
          enablePanInteraction={animPhase === "complete"}
          nodeLabel={() => ""}
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => "replace"}
          nodePointerAreaPaint={paintNodePointerArea}
          onNodeHover={(node) => animPhase === "complete" && setHoveredNode(node ?? null)}
          linkLabel={(link) => {
            if (animPhase !== "complete") return "";
            const statusLabel = PROVENANCE_STATUS_LABEL[link.provenance_status] ?? "Validated provenance";
            const secondaryNote = link.kind !== "candidate_match" && !isPrimaryLink(link) ? " (secondary crosslink)" : "";
            return `${statusLabel}${secondaryNote} · ${percent(link.confidence)}`;
          }}
          linkCanvasObject={paintLink}
          linkCanvasObjectMode={() => "replace"}
          linkPointerAreaPaint={paintLinkPointerArea}
          linkHoverPrecision={6}
          linkDirectionalParticles={0}
          onNodeClick={(node) => handleNodeClick(node)}
          onLinkClick={(link) => handleLinkClick(link)}
          onLinkHover={(link) => animPhase === "complete" && setHoveredLink(link ?? null)}
          onBackgroundClick={handleBackgroundClick}
          backgroundColor="rgba(0,0,0,0)"
        />
      </div>

      <div
        className={`absolute top-[5.65rem] left-6 z-20 flex items-center gap-2 rounded-xl border border-white/8 bg-[#0c0914]/65 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35 backdrop-blur-xl pointer-events-none transition-opacity duration-1000 delay-300 ${
          animPhase === "complete" ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className="text-[#e6bd6a]">Origins</span>
        <MoveRight size={13} strokeWidth={1.5} />
        <span>Propagation</span>
      </div>

      <div
        className={`absolute top-[5.65rem] right-6 z-30 flex items-center gap-1 rounded-xl border border-white/8 bg-[#0c0914]/72 p-1.5 text-white/60 shadow-2xl backdrop-blur-xl transition-all duration-1000 delay-300 ${
          animPhase === "complete" ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.35)} className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]">
          <ZoomIn size={16} strokeWidth={1.5} />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.74)} className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]">
          <ZoomOut size={16} strokeWidth={1.5} />
        </button>
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" aria-label="Fit graph to view" onClick={fitToView} className="rounded-lg p-2 transition-colors hover:bg-white/10 hover:text-[#f0ca79]">
          <Maximize2 size={15} strokeWidth={1.5} />
        </button>
      </div>

      <button
        onClick={openEvidencePanel}
        className={`absolute bottom-6 right-6 z-40 rounded-xl border border-white/10 bg-[#0c0914]/78 px-4 py-2.5 text-left shadow-2xl backdrop-blur-xl transition-all duration-1000 delay-500 hover:border-[#e6bd6a]/25 hover:bg-[#1a1024]/90 ${
          animPhase === "complete" ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"
        }`}
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

      <Drawer open={panelOpen}>
        {selectedNode && (
          <div className="flex flex-col h-full space-y-5">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className="text-sm font-semibold tracking-wide uppercase flex items-center" style={{ color: ROLE_COLOR[selectedNode.role] }}>
                {selectedNode.role === "conflict" ? <AlertTriangle size={18} className="mr-2" /> : (selectedNode.is_seed || selectedNode.is_root) ? <Sprout size={18} className="mr-2" /> : <ExternalLink size={18} className="mr-2" />}
                {ROLE_LABEL[selectedNode.role]}
              </h3>
              <button onClick={() => setSelectedNode(null)} className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors"><X size={18} /></button>
            </div>
            <Field label="Title">{displayTitle(selectedNode)}</Field>
            {selectedNodeSubmitted ? (
              <Field label="Source"><span className="text-blue-200/80">User-submitted text</span></Field>
            ) : (
              <>
                <Field label="Publisher">{selectedNode.publisher || <span className="text-gray-500">unknown</span>}</Field>
                <Field label="Source URL"><a href={selectedNode.url} target="_blank" rel="noreferrer noopener" className="text-blue-400 hover:text-blue-300 underline break-all">{selectedNode.url}</a></Field>
              </>
            )}
            <Field label="Published">
              <div className="flex items-center">
                <Clock size={14} className="mr-2 text-gray-500 shrink-0" />
                <span>{selectedNode.timestamp ? formatTimestamp(selectedNode.timestamp) : "Unknown"}</span>
              </div>
              {(selectedNode.timestamp_source !== "none" || selectedNode.earliest_possible || selectedNodeHasTimestampConflict) && (
                <details className="group mt-2 text-xs text-gray-500">
                  <summary className="cursor-pointer list-none text-gray-500 transition-colors hover:text-gray-300">
                    <span className="group-open:hidden">Technical timestamp details</span>
                    <span className="hidden group-open:inline">Hide timestamp details</span>
                  </summary>
                  <div className="mt-2 space-y-1 border-l border-white/10 pl-3">
                    <p>Source: {selectedNode.timestamp_source}</p>
                    <p>Confidence: {selectedNode.timestamp_confidence}</p>
                    {selectedNode.earliest_possible && selectedNode.earliest_possible !== selectedNode.timestamp && (
                      <p>Earliest possible: {formatTimestamp(selectedNode.earliest_possible)}</p>
                    )}
                    {selectedNodeHasTimestampConflict && <p>{selectedNode.timestamp_conflict}</p>}
                  </div>
                </details>
              )}
            </Field>
            {selectedNodeHasTimestampConflict && (
              <TypedCard color={ROLE_COLOR.conflict} className="p-4">
                <p className="text-xs text-amber-400 uppercase font-semibold mb-2">Timestamp conflict</p>
                <p className="text-sm text-gray-200">Conflicting publication-date signals were detected.</p>
              </TypedCard>
            )}
            <Field label="Matched passage"><Passage value={selectedNode.passage} /></Field>
            <Field label="Fabricated citations"><StringList items={selectedNode.fabricated_citations} empty="none recorded" /></Field>
            <Field label="Mutations"><StringList items={selectedNode.mutations} empty="none recorded" /></Field>
            <Field label="Discovered via"><StringList items={selectedNode.discovered_via} empty="unknown" /></Field>
            <Field label="Seed">{selectedNode.is_seed ? "yes" : "no"}</Field>
            <TypedCard color={UNKNOWN_COLOR} className="p-4">
              <p className="text-xs text-gray-400 uppercase mb-2 flex items-center"><BrainCircuit size={16} className="mr-2" /> AI-origin evidence</p>
              {selectedNode.ai_evidence ? (
                <div className="space-y-2 text-sm text-gray-200">
                  <p><span className="text-gray-500">Provider:</span> {selectedNode.ai_evidence.provider}</p>
                  <p><span className="text-gray-500">Label:</span> {selectedNode.ai_evidence.label}</p>
                  <p><span className="text-gray-500">Reported AI probability:</span> {selectedNode.ai_evidence.ai_probability.toFixed(2)}</p>
                  <p className="text-xs text-gray-500">Checked {formatTimestamp(selectedNode.ai_evidence.checked_at)}</p>
                  {selectedNode.ai_evidence.flagged_passages.length > 0 && (
                    <div className="pt-1">
                      <p className="text-gray-500 text-xs uppercase mb-1">Flagged passages</p>
                      <StringList items={selectedNode.ai_evidence.flagged_passages} empty="none" />
                    </div>
                  )}
                  <p className="text-xs text-gray-600 pt-1">Supplementary evidence only; not a verdict on the claim.</p>
                </div>
              ) : <p className="text-sm text-gray-500">AI-origin evidence: not available</p>}
            </TypedCard>
          </div>
        )}

        {selectedLink && (
          <div className="flex flex-col h-full space-y-5">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className={`text-sm font-semibold tracking-wide uppercase flex items-center ${selectedLinkIsCandidate ? "text-sky-300" : "text-yellow-300"}`}>
                <GitBranch size={18} className="mr-2" />
                {selectedLinkIsCandidate
                  ? "Candidate Source Match"
                  : selectedLink.type === "propagation"
                    ? "Validated Provenance"
                    : "Validated Similarity"}
              </h3>
              <button onClick={() => setSelectedLink(null)} className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors"><X size={18} /></button>
            </div>
            <div className="space-y-2">
              <Endpoint
                id={parentId}
                node={parentNode}
                role={selectedLinkIsCandidate && parentNode && !isSubmittedNode(parentNode) ? "Candidate source" : "Parent"}
              />
              <div className="flex justify-center text-gray-600"><ArrowDown size={18} /></div>
              <Endpoint
                id={childId}
                node={childNode}
                role={selectedLinkIsCandidate && childNode && isSubmittedNode(childNode) ? "Submitted claim" : "Child"}
              />
            </div>
            {selectedLinkIsCandidate && (
              <p className="rounded-xl border border-sky-300/15 bg-sky-300/[0.06] px-4 py-3 text-sm leading-relaxed text-sky-100/75">
                This edge records a source match to the submitted claim. It does not assert publication-to-publication provenance.
              </p>
            )}
            {selectedLink.provenance_status && selectedLink.provenance_status !== "validated" && (
              <Field label="Provenance status">
                <p>{PROVENANCE_STATUS_LABEL[selectedLink.provenance_status] ?? selectedLink.provenance_status}</p>
                {PROVENANCE_STATUS_NOTE[selectedLink.provenance_status] && (
                  <p className="mt-1 text-xs text-gray-500">{PROVENANCE_STATUS_NOTE[selectedLink.provenance_status]}</p>
                )}
              </Field>
            )}
            {selectedLink.claim_relationship && (
              <Field label="Claim relationship">
                <p>{CLAIM_RELATIONSHIP_LABEL[selectedLink.claim_relationship] ?? selectedLink.claim_relationship}</p>
                <p className="mt-1 text-xs text-gray-500">
                  Independent of provenance: this describes semantic agreement with the claim, not how this document was linked to it.
                </p>
              </Field>
            )}
            <Field label={selectedLinkIsCandidate ? "Match strength" : "Confidence"}>
              <div className="space-y-2">
                <p className={`text-2xl font-semibold ${selectedLinkIsCandidate ? "text-sky-300" : "text-yellow-300"}`}>{percent(selectedLink.confidence)}</p>
                <ConfidenceBar value={selectedLink.confidence} color={selectedLinkIsCandidate ? "#7dd3fc" : EDGE_COLOR} />
              </div>
            </Field>
            <Field label="Basis"><p className="bg-white/5 p-3 rounded-lg border border-white/10 leading-relaxed">{selectedLink.basis}</p></Field>
            <div className="space-y-4 border-t border-white/10 pt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Evidence breakdown</p>
              <div>
                <p className="text-xs text-gray-500 uppercase mb-1 tracking-wide">Explicit source relationship</p>
                {selectedLink.explicit_link ? <p className="text-sm text-emerald-400">&#10003; Explicit link/reference detected</p> : <p className="text-sm text-gray-400">No explicit link detected</p>}
              </div>
              <Field label="Shared distinctive mutations"><StringList items={selectedLink.shared_mutations} empty="No shared distinctive mutations" /></Field>

              <Field label="Claim changes">
                {selectedLink.claim_mutations.length === 0 ? (
                  <span className="text-gray-500">No material wording change detected in the claim passage</span>
                ) : (
                  <div className="space-y-2">
                    {selectedLink.claim_mutations.map((mutation, index) => (
                      <TypedCard key={`${mutation.type}-${index}`} color={EDGE_COLOR} className="px-3 py-2">
                        <p className="mb-1 text-[10px] uppercase tracking-wide text-yellow-300/75">
                          {mutation.type}
                        </p>
                        <p className="text-sm leading-relaxed text-gray-200">{mutation.summary}</p>
                      </TypedCard>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="Rare copied phrasing">Rare shared phrases: <span className="text-white">{selectedLink.rare_shared_phrases}</span></Field>
              <Field label="Similarity">
                <div className="space-y-2">
                  <p>Text similarity: <span className="text-white">{percent(selectedLink.similarity)}</span></p>
                  <ConfidenceBar value={selectedLink.similarity} color="#64748b" />
                  <p className="text-xs text-gray-500">One signal among several. Similar wording does not by itself establish copying — shared sources or common phrasing can produce it.</p>
                </div>
              </Field>
            </div>
            {!selectedLinkIsCandidate && <div className="space-y-2 border-t border-white/10 pt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Temporal evidence</p>
              <div className="text-sm text-gray-200 space-y-1">
                <p><span className="text-gray-500">Parent:</span> {formatDate(selectedLink.temporal.parent_time)}</p>
                <p><span className="text-gray-500">Child:</span> {formatDate(selectedLink.temporal.child_time)}</p>
                <p><span className="text-gray-500">Gap:</span> {selectedLink.temporal.gap_days === null ? <span className="text-gray-500">unknown</span> : `${selectedLink.temporal.gap_days} day${Math.abs(selectedLink.temporal.gap_days) === 1 ? "" : "s"}`}</p>
                <p><span className="text-gray-500">Ordering:</span> {selectedLink.temporal.ordering}</p>
              </div>
              <p className="text-xs text-gray-500">{ORDERING_NOTE[selectedLink.temporal.ordering] ?? "Ordering evidence is unavailable."}</p>
            </div>}
            {selectedLink.alternatives.length > 0 && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Alternative parents considered</p>
                <p className="text-xs text-gray-600">Scored against this child but not accepted; they are not drawn on the graph.</p>
                <div className="space-y-2">
                  {selectedLink.alternatives.map((alt, i) => {
                    const c = nodesById.get(alt.candidate_id);
                    return (
                      <TypedCard
                        key={`${alt.candidate_id}-${i}`}
                        color={c ? ROLE_COLOR[c.role] : UNKNOWN_COLOR}
                        className="px-3 py-2 space-y-1"
                      >
                        <p className="text-sm text-gray-100 leading-snug">{c ? displayTitle(c) : alt.candidate_id}</p>
                        {c && <p className="text-xs text-gray-500">{c.publisher}</p>}
                        <p className="text-xs text-gray-400">Confidence: {percent(alt.confidence)}</p>
                        <p className="text-xs text-gray-400">Reason: {alt.reason}</p>
                      </TypedCard>
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
