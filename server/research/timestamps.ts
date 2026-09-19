import type { z } from "zod";
import { TimestampConfidence as TimestampConfidenceSchema, TimestampSource as TimestampSourceSchema } from "../../shared/tree";

export type TimestampSource = z.infer<typeof TimestampSourceSchema>;
export type TimestampConfidence = z.infer<typeof TimestampConfidenceSchema>;

/** A date signal kept separate until source priority and conflict checks are complete. */
export interface TimestampEvidence {
  timestamp: string;
  source: TimestampSource;
  confidence: TimestampConfidence;
}

export interface SelectedTimestamp {
  timestamp: string | null;
  source: TimestampSource;
  confidence: TimestampConfidence;
  /** Present when strong date evidence disagrees. Link conflicts are added downstream. */
  conflict: string | null;
}

const DAY_MS = 86_400_000;
const MIN_YEAR = 1990;
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validEpoch(time: number): boolean {
  if (!Number.isFinite(time)) return false;
  const year = new Date(time).getUTCFullYear();
  return year >= MIN_YEAR && time <= Date.now() + DAY_MS;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return validEpoch(time) ? parsed.toISOString() : null;
}

/**
 * Converts only unambiguous, labelled or structured date values to UTC. Bare numeric month/day
 * strings are deliberately rejected; callers handling a docket header can use the narrowly
 * scoped `parseUnambiguousUsNumericDate` below.
 */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return validEpoch(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return isoDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));

  const namedDate = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (namedDate) {
    const month = MONTHS[namedDate[1]!.toLowerCase()];
    return month ? isoDate(Number(namedDate[3]), month, Number(namedDate[2])) : null;
  }

  // ISO timestamps and written dates are structured. Do not hand slash-delimited numeric values
  // to Date.parse: its locale-dependent interpretation would manufacture a date.
  if (/^\d{4}-\d{2}-\d{2}T/i.test(trimmed) || /[A-Za-z]/.test(trimmed)) {
    const time = Date.parse(trimmed);
    return validEpoch(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

/**
 * Federal court headers conventionally use U.S. month/day/year ordering. We still accept one only
 * when its day is above 12, leaving values such as `04/05/23` undated rather than guessing.
 */
export function parseUnambiguousUsNumericDate(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day <= 12) return null;
  const rawYear = match[3]!;
  const numericYear = Number(rawYear);
  const year = rawYear.length === 2 ? (numericYear <= 68 ? 2000 + numericYear : 1900 + numericYear) : numericYear;
  return isoDate(year, month, day);
}

export function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function priority(evidence: TimestampEvidence): number {
  switch (evidence.source) {
    case "meta":
      return 700;
    case "json-ld":
      return 690;
    case "time-element":
      return 680;
    case "pdf-metadata":
      return 670;
    case "court-filing-header":
      return 660;
    case "document-publication-label":
      return 500;
    case "url":
      return 200;
    case "search-result":
      return 100;
    case "none":
      return 0;
  }
}

function conflictDescription(evidence: TimestampEvidence[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of evidence) {
    const value = `${item.source} (${dateKey(item.timestamp)})`;
    if (!seen.has(value)) {
      seen.add(value);
      parts.push(value);
    }
  }
  return `conflicting strong timestamp evidence: ${parts.join(", ")}`;
}

/**
 * Resolve date evidence after all sources are available. Multiple strong calendar dates leave the
 * document undated instead of selecting one. Weak URL/search hints can never outrank a filing or
 * structured timestamp.
 */
export function selectTimestampEvidence(evidence: TimestampEvidence[]): SelectedTimestamp {
  const usable = evidence.filter((item) => item.source !== "none");
  const strongDates = new Set(usable.filter((item) => item.confidence === "strong").map((item) => dateKey(item.timestamp)));
  if (strongDates.size > 1) {
    return {
      timestamp: null,
      source: "none",
      confidence: "none",
      conflict: conflictDescription(usable.filter((item) => item.confidence === "strong")),
    };
  }
  if (usable.length === 0) return { timestamp: null, source: "none", confidence: "none", conflict: null };

  const selected = [...usable].sort(
    (a, b) => priority(b) - priority(a) || a.source.localeCompare(b.source) || a.timestamp.localeCompare(b.timestamp),
  )[0]!;
  return { timestamp: selected.timestamp, source: selected.source, confidence: selected.confidence, conflict: null };
}

/** Date-shaped URL paths are intentionally weak evidence and only serve as a last fallback. */
export function urlTimestampEvidence(url: string): TimestampEvidence | null {
  try {
    const match = new URL(url).pathname.match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
    if (!match) return null;
    const timestamp = toIso(`${match[1]}-${match[2]}-${match[3]}`);
    return timestamp ? { timestamp, source: "url", confidence: "weak" } : null;
  } catch {
    return null;
  }
}
