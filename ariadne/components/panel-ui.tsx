"use client";

import React from "react";
import { X, ExternalLink } from "lucide-react";
import PixelCard from "./PixelCard";
import { pixelPalette } from "@/lib/pixel-card-colors";

/** Shared chrome for the right-side inspectors, so they read as one interface. */

/** A bordered content block whose border and hover-pixel colour both read as `color` — the type of thing it holds. */
export function TypedCard({
  color,
  className = "",
  children,
}: {
  color: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <PixelCard
      colors={pixelPalette(color)}
      noFocus
      className={className}
      style={
        {
          "--pixel-card-border": `${color}4d`,
          "--pixel-card-border-hover": `${color}b3`,
          "--pixel-card-active-color": `${color}33`,
        } as React.CSSProperties
      }
    >
      {children}
    </PixelCard>
  );
}

export function Drawer({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={`absolute top-0 right-0 z-50 h-full w-96 overflow-y-auto border-l border-[#e6bd6a]/15 bg-[#0b0712]/92 p-6 text-white shadow-[-24px_0_80px_rgba(0,0,0,0.38)] backdrop-blur-2xl transition-transform duration-300 ease-in-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  icon,
  color,
  onClose,
}: {
  title: string;
  icon: React.ReactNode;
  color?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/10 pb-4">
      <h3
        className="text-sm font-semibold tracking-wide uppercase flex items-center"
        style={color ? { color } : undefined}
      >
        <span className="mr-2 flex items-center">{icon}</span>
        {title}
      </h3>
      <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/20 rounded-full transition-colors">
        <X size={18} />
      </button>
    </div>
  );
}

/** One labelled block in a side panel. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase mb-1 tracking-wide">{label}</p>
      <div className="text-sm text-gray-200 break-words">{children}</div>
    </div>
  );
}

export function StringList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-gray-500">{empty}</span>;
  return (
    <ul className="list-disc list-inside space-y-1">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

export function ConfidenceBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-xs text-blue-400 hover:text-blue-300 underline break-all inline-flex items-center"
    >
      <ExternalLink size={11} className="mr-1 shrink-0" />
      {url}
    </a>
  );
}
