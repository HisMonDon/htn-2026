/** Display formatters shared by the graph inspectors. Presentation only — no reinterpretation. */

import type { GraphNode } from "./graph";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );
}

/** Title, then publisher, then URL. Never invents a label the backend did not supply. */
export function displayTitle(node: GraphNode): string {
  return node.title.trim() || node.publisher.trim() || node.url;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toUTCString();
}

/** Compact UTC date, e.g. "Dec 13, 2023". */
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatDate(value: string | null): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : DATE_FORMAT.format(new Date(parsed));
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface PassagePreview {
  text: string;
  truncated: boolean;
}

/** Keep the inspector scannable while preserving the complete extraction behind disclosure. */
export function passagePreview(value: string, maxSentences = 4, maxCharacters = 720): PassagePreview {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return { text: "", truncated: false };

  const sentences = (normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [normalized])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const selected = sentences.slice(0, Math.max(1, Math.min(5, maxSentences)));

  while (selected.length > 2 && selected.join(" ").length > maxCharacters) selected.pop();

  let text = selected.join(" ");
  if (text.length > maxCharacters) {
    const boundary = text.lastIndexOf(" ", maxCharacters);
    text = `${text.slice(0, boundary > 0 ? boundary : maxCharacters).trimEnd()}…`;
  }

  return { text, truncated: text !== normalized };
}

/** Host of a URL for a readable heading. Derived from the URL, not invented metadata. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
