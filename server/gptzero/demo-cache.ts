import { createHash } from "node:crypto";
import demoCacheFixture from "./fixtures/demo-cache.json" with { type: "json" };
import type { BibliographyScanResponse } from "./bibliography";

/**
 * Offline stand-in for a real Bibliography Scan response, seeded once from a real successful live
 * call (see `server/gptzero/fixtures/demo-cache.json`). Used only when the live API is unreachable
 * or rate-limited; never returned in place of a live result that succeeded.
 */
export interface DemoCacheEntry {
  schemaVersion: number;
  capturedAt: string;
  inputHash: string;
  response: BibliographyScanResponse;
}

const entries: DemoCacheEntry[] = [demoCacheFixture as DemoCacheEntry];

/** Deterministic cache key for one scan input. No LLM, no network. */
export function demoCacheKey(documentText: string): string {
  return createHash("sha256").update(documentText).digest("hex");
}

export function lookupDemoCache(documentText: string): DemoCacheEntry | null {
  const key = demoCacheKey(documentText);
  return entries.find((entry) => entry.inputHash === key) ?? null;
}
