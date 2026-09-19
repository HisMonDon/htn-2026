import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard: scoring and acceptance code must never reference `SourceReference.metadata`.
 * `AuditMetadata` (see `providers/types.ts`) already makes a `.metadata.someField` read a compile
 * error, but this test also blocks a bare `.metadata` reference (e.g. re-exporting it, passing it
 * through, or widening the type with a cast) from being reintroduced into these files.
 */
const GUARDED_FILES = ["./edges.ts", "./traversal.ts", "../provenance/validator.ts"] as const;

function read(relativeToThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), "utf8");
}

describe("metadata isolation static guard", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} never references .metadata`, () => {
      const source = read(file);
      expect(source).not.toMatch(/\.metadata\b/);
    });
  }
});
