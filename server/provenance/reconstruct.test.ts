import { describe, expect, it } from "vitest";
import type { ProvenanceEdgeValidation } from "../../shared/provenance-validation";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { validateProvenanceEdge } from "./validator";
import { reconstructValidatedProvenance } from "./reconstruct";

const FABRICATED = ["Alpha v. Beta", "Gamma v. Delta"];
const now = () => new Date("2026-09-19T12:00:00Z");

function doc(id: string, day: number, links: string[] = [], suffix = ""): CandidateDocument {
  return extractDocument({
    url: `https://${id}.example/story`,
    html: `<html><head><title>${id}</title><meta property="article:published_time" content="2024-01-${String(day).padStart(2, "0")}T00:00:00Z"></head><body><article><p>Alpha v. Beta and Gamma v. Delta support relief. ${suffix}</p>${links.map((link) => `<a href="${link}">source</a>`).join("")}</article></body></html>`,
    fabricated: FABRICATED,
    claimTerms: ["relief"],
    discoveredVia: "test",
  });
}

function validate(parent: CandidateDocument, child: CandidateDocument, corpus: CandidateDocument[]) {
  return validateProvenanceEdge({ parent, child, corpus, referenceUrl: parent.url, now });
}

describe("validated provenance reconstruction", () => {
  it("retains multiple validated parents and computes transitive ancestry", () => {
    const origin = doc("origin", 1, [], "The original described narrow relief.");
    const branchA = doc("branch-a", 2, [origin.url], "The report broadened the requested relief.");
    const branchB = doc("branch-b", 3, [origin.url], "The report attributed the request to counsel.");
    const merge = doc("merge", 4, [branchA.url, branchB.url], "The summary combined both accounts.");
    const documents = [origin, branchA, branchB, merge];
    const validations = [
      validate(origin, branchA, documents),
      validate(origin, branchB, documents),
      validate(branchA, merge, documents),
      validate(branchB, merge, documents),
    ];

    const dag = reconstructValidatedProvenance(documents, validations);
    expect(dag.root_ids).toEqual([origin.id]);
    expect(dag.edges.filter((edge) => edge.child_id === merge.id).map((edge) => edge.parent_id).sort()).toEqual(
      [branchA.id, branchB.id].sort(),
    );
    expect(dag.ancestry[merge.id]).toEqual([branchA.id, branchB.id, origin.id].sort());
    expect(dag.edges.every((edge) => edge.claim_mutations.length > 0)).toBe(true);
  });

  it("keeps rejected validation evidence off the graph", () => {
    const parent = doc("parent", 1);
    const child = doc("child", 2, [], "A wholly different account appeared later.");
    const validation = validateProvenanceEdge({
      parent: { ...parent, fabricated_citations: [], text: "Unrelated weather almanac." },
      child: { ...child, fabricated_citations: [], outbound_links: [] },
      now,
    });
    const dag = reconstructValidatedProvenance([parent, child], [validation]);
    expect(dag.edges).toEqual([]);
    expect(dag.rejected_edges).toEqual([
      expect.objectContaining({ parent_id: parent.id, child_id: child.id, reason: expect.any(String) }),
    ]);
    expect(dag.root_ids).toEqual([parent.id, child.id]);
  });

  it("defensively rejects an accepted record whose chronology no longer orders its nodes", () => {
    const earlier = doc("earlier", 1, [], "The first account described narrow relief.");
    const later = doc("later", 2, [earlier.url], "The later account added broader relief.");
    const valid = validate(earlier, later, [earlier, later]);
    const forged = {
      ...valid,
      parent_id: later.id,
      child_id: earlier.id,
      graph_edge: valid.graph_edge ? { ...valid.graph_edge, parent_id: later.id, child_id: earlier.id } : null,
    } as ProvenanceEdgeValidation;

    const dag = reconstructValidatedProvenance([earlier, later], [forged]);
    expect(dag.edges).toEqual([]);
    expect(dag.rejected_edges[0]?.reason).toContain("no defensible parent-before-child order");
  });
});
