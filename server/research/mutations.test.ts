import { describe, expect, it } from "vitest";
import { extractDocument, type CandidateDocument } from "./extract";
import { analyzeClaimMutations } from "./mutations";

const FABRICATED = ["Alpha v. Beta", "Gamma v. Delta"];

function document(id: string, passage: string): CandidateDocument {
  return extractDocument({
    url: `https://${id}.example/story`,
    html: `<html><head><title>${id}</title><meta property="article:published_time" content="2024-01-01T00:00:00Z"></head><body><article><p>${passage}</p></article></body></html>`,
    fabricated: FABRICATED,
    claimTerms: ["court", "relief"],
    discoveredVia: "test",
  });
}

describe("claim mutation analysis", () => {
  it("does not call punctuation, case, or sentence reordering a mutation", () => {
    const parent = document("parent", "The court granted relief. Counsel verified the citations.");
    const child = document("child", "Counsel verified the citations! The court granted relief");
    expect(analyzeClaimMutations(parent, child)).toEqual([]);
  });

  it("describes related wording as a reframed claim", () => {
    const parent = document("parent", "The court granted relief after sustained rehabilitation.");
    const child = document("child", "The court approved relief because rehabilitation was sustained.");
    expect(analyzeClaimMutations(parent, child)).toEqual([
      expect.objectContaining({
        type: "reframed",
        before: expect.stringContaining("granted relief"),
        after: expect.stringContaining("approved relief"),
        summary: expect.stringContaining("Reframed"),
      }),
    ]);
  });

  it("reports unmatched assertions as additions and omissions", () => {
    const parent = document("parent", "The court granted relief. Counsel verified every citation.");
    const child = document("child", "The court granted relief. The ruling created binding precedent.");
    expect(analyzeClaimMutations(parent, child)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "added", after: expect.stringContaining("binding precedent") }),
        expect.objectContaining({ type: "omitted", before: expect.stringContaining("verified every citation") }),
      ]),
    );
  });

  it("detects a changed citation even when the surrounding claim stays the same", () => {
    const parent = document("parent", "Alpha v. Beta supports relief from supervision.");
    const child = document("child", "Gamma v. Delta supports relief from supervision.");
    expect(analyzeClaimMutations(parent, child)).toEqual([
      expect.objectContaining({ type: "reframed", before: expect.stringContaining("Alpha"), after: expect.stringContaining("Gamma") }),
    ]);
  });
});
