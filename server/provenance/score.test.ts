import { describe, expect, it } from "vitest";
import { Edge } from "../../shared/schema";
import { seedCase } from "../test-helpers";
import { scoreParents, toEdge, type ProvenanceDoc } from "./score";

const seed = seedCase();
const FAKE_CASES = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];

/** The Cohen/Bard chain exactly as the fixture records it: short descriptive excerpts. */
function fixtureDocs(): ProvenanceDoc[] {
  return seed.chain.map((node) => ({ id: node.id, url: node.url, timestamp: node.timestamp, text: node.excerpt }));
}

function doc(id: string): ProvenanceDoc {
  return fixtureDocs().find((candidate) => candidate.id === id)!;
}

/**
 * The same chain with document text that carries the fabricated citations, as the pages
 * themselves would, plus the controlled-target article downstream of the filing.
 */
function withCitations(): { docs: ProvenanceDoc[]; article: ProvenanceDoc } {
  const cites = `${FAKE_CASES.join(", ")}`;
  const docs = fixtureDocs().map((candidate) =>
    candidate.id === "court-finding" ? candidate : { ...candidate, text: `${candidate.text} Cited: ${cites}.` },
  );
  const motion = docs.find((candidate) => candidate.id === "schwartz-motion")!;
  motion.text += " Early termination is warranted given the defendant's exemplary post-release conduct and community service.";
  const article: ProvenanceDoc = {
    id: "docket-digest",
    url: "http://localhost:4100/articles/cohen-supervised-release",
    timestamp: "2023-12-01T12:00:00Z",
    text: `The motion relies on ${cites}. Early termination is warranted given the defendant's exemplary post-release conduct and community service, it argues.`,
    links: [motion.url!],
  };
  return { docs, article };
}

describe("provenance scoring", () => {
  it("never treats a later document as a parent", () => {
    const result = scoreParents(doc("schwartz-motion"), fixtureDocs(), { knownMutations: FAKE_CASES });
    const later = result.candidates.find((candidate) => candidate.candidate_id === "court-finding")!;
    expect(later.eligible).toBe(false);
    expect(later.confidence).toBe(0);
    expect(result.parent_id).not.toBe("court-finding");
  });

  it("keeps confidence low on the fixture's descriptive excerpts, which share no distinctive evidence", () => {
    // The fixture's 0.99 edges come from the court record, not from text. Text alone must not reproduce them.
    for (const node of seed.chain.slice(1)) {
      const earlier = fixtureDocs().filter((candidate) => candidate.id !== node.id);
      const result = scoreParents(doc(node.id), earlier, { knownMutations: FAKE_CASES });
      expect(result.confidence).toBeLessThanOrEqual(0.25);
      expect(result.type).toBe("similarity");
    }
  });

  it("does not let high textual similarity alone create a confident propagation claim", () => {
    const base = "Cohen asked the court to end supervised release early, citing his compliance and conduct.";
    const target: ProvenanceDoc = { id: "t", timestamp: "2023-12-02T00:00:00Z", text: base };
    const lookalike: ProvenanceDoc = { id: "c", timestamp: "2023-12-01T00:00:00Z", text: `${base} Reported.` };
    const result = scoreParents(target, [lookalike]);
    expect(result.candidates[0]!.signals.similarity).toBeGreaterThan(0.8);
    expect(result.confidence).toBeLessThanOrEqual(0.25);
    expect(result.type).toBe("similarity");
  });

  it("identifies the filing as the article's parent from the link and the shared fabricated citations", () => {
    const { docs, article } = withCitations();
    const result = scoreParents(article, docs, { knownMutations: FAKE_CASES });
    expect(result.parent_id).toBe("schwartz-motion");
    expect(result.type).toBe("propagation");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.confidence).toBeLessThan(1);
    expect(result.basis).toContain("links to");
    expect(result.basis).toContain("united states v. figueroa-florez");
  });

  it("discounts a mutation that every earlier candidate shares and flags ambiguity", () => {
    const { docs } = withCitations();
    const target = docs.find((candidate) => candidate.id === "schwartz-motion")!;
    const earlier = docs.filter((candidate) => candidate.id !== "schwartz-motion");
    const result = scoreParents({ ...target, text: `Cited: ${FAKE_CASES.join(", ")}.` }, earlier, {
      knownMutations: FAKE_CASES,
    });
    // bard-generation and cohen-emails both carry the citations, so neither can be singled out.
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.basis).toMatch(/ambiguous|other earlier candidate/);
  });

  it("caps confidence when timestamps cannot order the documents", () => {
    const { docs } = withCitations();
    const emails = docs.find((candidate) => candidate.id === "cohen-emails")!;
    const bard = docs.find((candidate) => candidate.id === "bard-generation")!;
    expect(emails.timestamp).toBe(bard.timestamp);
    const result = scoreParents(emails, [bard], { knownMutations: FAKE_CASES });
    expect(result.parent_id).toBe("bard-generation");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.basis).toContain("same timestamp");
  });

  it("is deterministic and produces a contract-valid edge", () => {
    const { docs, article } = withCitations();
    const a = scoreParents(article, docs, { knownMutations: FAKE_CASES });
    const b = scoreParents(article, [...docs].reverse(), { knownMutations: FAKE_CASES });
    expect(a).toEqual(b);
    expect(() => Edge.parse(toEdge(a))).not.toThrow();
  });

  it("returns no parent when there are no earlier documents", () => {
    const result = scoreParents(doc("bard-generation"), fixtureDocs().slice(1));
    expect(result.parent_id).toBeNull();
    expect(toEdge(result)).toBeNull();
  });
});
