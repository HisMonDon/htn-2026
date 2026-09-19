import { describe, expect, it } from "vitest";
import rawCandidates from "../../data/cohen-bard-candidates.json";
import { MockDocumentIndex, type ProvenanceDocument } from "./document-index";
import { reconstructLineage } from "./tree";

const FAKE_CASES = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const corpus = rawCandidates as ProvenanceDocument[];

function pair(edge: { source: string; target: string }): string {
  return `${edge.source}->${edge.target}`;
}

describe("lineage reconstruction", () => {
  it("reconstructs the Cohen/Bard validation chain from a noisy candidate pool", async () => {
    const index = new MockDocumentIndex([...corpus].reverse());
    const seed = corpus.find((document) => document.id === "schwartz-motion")!;
    const result = await reconstructLineage(seed, index, { knownMutations: FAKE_CASES, limit: 20 });

    expect(result.discovery.candidate_count).toBe(corpus.length);
    expect(result.edges.map(pair)).toEqual([
      "bard-generation->cohen-emails",
      "cohen-emails->schwartz-motion",
      "schwartz-motion->court-finding",
    ]);
    expect(result.edges.every((edge) => edge.confidence >= 0.5)).toBe(true);
    expect(result.edges.every((edge) => edge.basis.length > 0)).toBe(true);
    expect(result.edges.every((edge) => edge.shared_mutations.length === 3)).toBe(true);
  });

  it("keeps distractors out of the accepted graph and explains rejections", async () => {
    const index = new MockDocumentIndex(corpus);
    const seed = corpus.find((document) => document.id === "schwartz-motion")!;
    const result = await reconstructLineage(seed, index, { knownMutations: FAKE_CASES, limit: 20 });

    const distractors = new Set([
      "early-termination-guide",
      "ortiz-name-collision",
      "near-copy-without-citations",
      "late-generic-summary",
    ]);
    expect(result.edges.some((edge) => distractors.has(edge.source) || distractors.has(edge.target))).toBe(false);
    expect(
      result.rejected_edges.some(
        (edge) =>
          edge.source === "late-generic-summary" &&
          edge.target === "schwartz-motion" &&
          edge.eligible === false &&
          edge.reason.includes("published after"),
      ),
    ).toBe(true);
    expect(
      result.rejected_edges.some(
        (edge) =>
          edge.source === "near-copy-without-citations" &&
          edge.reason.includes("not enough to claim propagation"),
      ),
    ).toBe(true);
  });

  it("is deterministic regardless of candidate insertion order", async () => {
    const seed = corpus.find((document) => document.id === "schwartz-motion")!;
    const a = await reconstructLineage(seed, new MockDocumentIndex(corpus), {
      knownMutations: FAKE_CASES,
      limit: 20,
    });
    const b = await reconstructLineage(seed, new MockDocumentIndex([...corpus].reverse()), {
      knownMutations: FAKE_CASES,
      limit: 20,
    });
    expect(a).toEqual(b);
  });
});
