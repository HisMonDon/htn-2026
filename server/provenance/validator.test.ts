import { describe, expect, it } from "vitest";
import { ProvenanceProposal } from "../gptzero/proposal";
import { contentFingerprint } from "../research/fingerprint";
import type { CandidateDocument } from "../research/extract";
import { TreeEdge } from "../../shared/tree";
import { validateProposedEdge, validateProvenanceEdge } from "./validator";

const now = () => new Date("2026-09-19T12:00:00Z");

const UPSTREAM_SENTENCE =
  "The Second Circuit held in Varghese v. China Southern Airlines that a tolling agreement suspends the limitations period for an untimely wrongful death claim.";

function doc(id: string, overrides: Partial<CandidateDocument> & { text: string }): CandidateDocument {
  const fingerprint = contentFingerprint(overrides.text);
  return {
    id,
    canonical_id: `sha256:${fingerprint}`,
    content_fingerprint: fingerprint,
    url: `https://${id}.example/page`,
    mirror_urls: [],
    publisher: id,
    title: `${id} report`,
    timestamp: "2023-05-01T00:00:00.000Z",
    timestamp_source: "meta",
    timestamp_confidence: "strong",
    timestamp_conflict: null,
    passage: overrides.text,
    outbound_links: [],
    case_names: [],
    fabricated_citations: [],
    citation_variants: [],
    discovered_via: ["test"],
    ...overrides,
  };
}

/** The upstream filing: first to carry the invented citation. */
function upstream(overrides: Partial<CandidateDocument> = {}): CandidateDocument {
  return doc("court-brief", {
    url: "https://court.example/brief",
    publisher: "Court Records",
    title: "Brief in Support of Rehearing",
    timestamp: "2023-05-01T00:00:00.000Z",
    text: `${UPSTREAM_SENTENCE} The panel relied on Shaboon v. Egyptair for the same proposition, and the court described the holding as controlling.`,
    fabricated_citations: ["Varghese v. China Southern Airlines", "Shaboon v. Egyptair"],
    ...overrides,
  });
}

/** The downstream blog post: links to the filing and repeats it. */
function downstream(overrides: Partial<CandidateDocument> = {}): CandidateDocument {
  return doc("law-blog", {
    url: "https://law-blog.example/post",
    publisher: "Law Blog",
    title: "What the panel actually said",
    timestamp: "2023-06-01T00:00:00.000Z",
    text: `As filed last month, ${UPSTREAM_SENTENCE} The filing is available in full at https://court.example/brief.`,
    passage: UPSTREAM_SENTENCE,
    outbound_links: ["https://court.example/brief"],
    fabricated_citations: ["Varghese v. China Southern Airlines", "Shaboon v. Egyptair"],
    ...overrides,
  });
}

function proposal(overrides: Record<string, unknown> = {}): ProvenanceProposal {
  return ProvenanceProposal.parse({
    proposer: "gptzero",
    source_url: "https://law-blog.example/post",
    suspicious_claim: UPSTREAM_SENTENCE,
    evidence_span: UPSTREAM_SENTENCE,
    proposed_upstream: { url: "https://court.example/brief", citation: "Varghese v. China Southern Airlines" },
    confidence: 0.97,
    metadata: {
      label: "ai",
      document_ai_probability: 0.93,
      sentence_ai_probability: 0.97,
      checked_at: "2026-09-19T12:00:00.000Z",
    },
    raw_evidence: null,
    ...overrides,
  });
}

describe("validateProvenanceEdge", () => {
  it("accepts a linked, dated parent that shares the fabricated citations", () => {
    const result = validateProvenanceEdge({ parent: upstream(), child: downstream(), referenceUrl: "https://court.example/brief", now });

    expect(result.relationship).toBe("propagation");
    expect(result.accepted).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.passed).toEqual(
      expect.arrayContaining(["distinct_artifact", "chronology", "explicit_link", "canonical_metadata", "shared_fabrications", "passage_overlap"]),
    );
    expect(result.evidence.matched_links).toEqual(["https://court.example/brief"]);
    expect(result.evidence.shared_fabrications).toEqual([
      "Varghese v. China Southern Airlines",
      "Shaboon v. Egyptair",
    ]);
    expect(result.evidence.temporal).toEqual({
      parent_time: "2023-05-01T00:00:00.000Z",
      child_time: "2023-06-01T00:00:00.000Z",
      gap_days: 31,
      // The link itself orders the pair; the dates agree with it.
      ordering: "from-link",
    });
  });

  it("hands the graph a ready-made edge only when the relationship is accepted", () => {
    const accepted = validateProvenanceEdge({ parent: upstream(), child: downstream(), now });
    expect(TreeEdge.parse(accepted.graph_edge)).toMatchObject({
      parent_id: "court-brief",
      child_id: "law-blog",
      type: "propagation",
      explicit_link: true,
      shared_mutations: ["Varghese v. China Southern Airlines", "Shaboon v. Egyptair"],
    });

    const unrelated = validateProvenanceEdge({
      parent: doc("almanac", { text: "Tides on the eastern seaboard run roughly six hours apart through the spring." }),
      child: downstream(),
      now,
    });
    expect(unrelated.relationship).toBe("unsupported");
    expect(unrelated.confidence).toBe(0);
    expect(unrelated.graph_edge).toBeNull();
  });

  it("rules out a parent published after its supposed child", () => {
    const result = validateProvenanceEdge({
      parent: upstream({ timestamp: "2023-08-01T00:00:00.000Z" }),
      child: downstream({ outbound_links: [] }),
      now,
    });

    expect(result.relationship).toBe("contradicted");
    expect(result.accepted).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.failed).toContain("chronology");
    expect(result.signals.find((signal) => signal.id === "chronology")).toMatchObject({ status: "failed", disqualifying: true });
    // Real shared material is still reported; it just cannot rescue an impossible edge.
    expect(result.evidence.shared_fabrications.length).toBeGreaterThan(0);
    expect(result.signals.every((signal) => signal.weight === 0)).toBe(true);
  });

  it("rules out a parent that is the same artifact under another URL", () => {
    const text = upstream().text;
    const result = validateProvenanceEdge({
      parent: upstream(),
      child: doc("mirror-site", { url: "https://mirror.example/brief", text, timestamp: "2023-07-01T00:00:00.000Z" }),
      now,
    });

    expect(result.relationship).toBe("contradicted");
    expect(result.failed).toContain("distinct_artifact");
    expect(result.reasons[0]).toContain("same artifact");
  });

  it("rules out a pair whose parent is not the document the reference named", () => {
    const result = validateProvenanceEdge({
      parent: upstream(),
      child: downstream(),
      referenceUrl: "https://elsewhere.example/other",
      now,
    });

    expect(result.relationship).toBe("contradicted");
    expect(result.failed).toContain("canonical_metadata");
    expect(result.signals.find((signal) => signal.id === "canonical_metadata")?.detail).toContain("does not resolve to");
  });

  it("accepts a mirror URL as canonical evidence for the same artifact", () => {
    const result = validateProvenanceEdge({
      parent: upstream({ mirror_urls: ["https://reprint.example/brief"] }),
      child: downstream(),
      referenceUrl: "https://reprint.example/brief",
      now,
    });

    expect(result.passed).toContain("canonical_metadata");
    expect(result.signals.find((signal) => signal.id === "canonical_metadata")?.detail).toContain("through a recorded mirror");
  });

  it("gives no credit for a URL the reference merely named", () => {
    const bare = validateProvenanceEdge({ parent: upstream(), child: downstream(), now });
    const referenced = validateProvenanceEdge({
      parent: upstream(),
      child: downstream(),
      referenceUrl: "https://court.example/brief",
      now,
    });

    // Resolving the named URL confirms which document was fetched; it corroborates nothing.
    expect(referenced.passed).toContain("canonical_metadata");
    expect(referenced.confidence).toBe(bare.confidence);
    expect(referenced.signals.find((signal) => signal.id === "canonical_metadata")?.weight).toBe(0);
  });

  it("caps copied wording alone well below acceptance", () => {
    const result = validateProvenanceEdge({
      parent: upstream({ fabricated_citations: [] }),
      child: downstream({ outbound_links: [], fabricated_citations: [], text: UPSTREAM_SENTENCE }),
      now,
    });

    expect(result.relationship).toBe("similarity");
    expect(result.accepted).toBe(false);
    expect(result.confidence).toBeLessThanOrEqual(0.25);
    expect(result.passed).toContain("shared_phrasing");
    expect(result.reasons).toContain(
      "shared wording without a link, a named reference or a shared fabrication is not enough to claim propagation",
    );
  });

  it("will not pick a direction between same-day documents without a link", () => {
    const result = validateProvenanceEdge({
      parent: upstream({ timestamp: "2023-06-01T00:00:00.000Z" }),
      child: downstream({ outbound_links: [], text: `As filed today, ${UPSTREAM_SENTENCE}` }),
      now,
    });

    expect(result.relationship).toBe("shared-source");
    expect(result.accepted).toBe(false);
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.signals.find((signal) => signal.id === "chronology")?.status).toBe("not-applicable");
  });

  it("discounts phrasing that any other candidate could have supplied", () => {
    const sibling = doc("aggregator", {
      timestamp: "2023-05-02T00:00:00.000Z",
      text: `${UPSTREAM_SENTENCE} Reposted from the wire.`,
    });
    const result = validateProvenanceEdge({
      parent: upstream(),
      child: downstream({ outbound_links: [], text: `As filed last month, ${UPSTREAM_SENTENCE}` }),
      corpus: [sibling],
      now,
    });

    expect(result.failed).toContain("shared_phrasing");
    expect(result.evidence.rare_shared_phrases).toBe(0);
    expect(result.signals.find((signal) => signal.id === "shared_phrasing")?.detail).toContain("also appears in another candidate");
  });

  it("counts a shared misspelling and a shared invented entity", () => {
    const result = validateProvenanceEdge({
      parent: upstream({
        citation_variants: ["Varghese v. China Southern Airways"],
        text: `${UPSTREAM_SENTENCE} Opinion by Judge Marlowe Pettibone.`,
      }),
      child: downstream({
        outbound_links: [],
        citation_variants: ["Varghese v. China Southern Airways"],
        text: `${UPSTREAM_SENTENCE} Opinion by Judge Marlowe Pettibone.`,
      }),
      knownFabrications: ["Judge Marlowe Pettibone"],
      now,
    });

    const signal = result.signals.find((entry) => entry.id === "shared_fabrications");
    expect(signal?.status).toBe("passed");
    expect(signal?.detail).toContain("the same misspelling");
    expect(result.evidence.shared_fabrications).toContain("Judge Marlowe Pettibone");
  });

  it("refuses to validate a document against itself", () => {
    const self = downstream();
    expect(() => validateProvenanceEdge({ parent: self, child: self, now })).toThrow(/its own parent/);
  });
});

describe("validateProposedEdge", () => {
  it("records the proposer without letting it move the score", () => {
    const parent = upstream();
    const child = downstream();
    const confident = validateProposedEdge({ proposal: proposal(), parent, child, now });
    const doubtful = validateProposedEdge({
      proposal: proposal({
        confidence: 0.01,
        metadata: {
          label: "human",
          document_ai_probability: 0.02,
          sentence_ai_probability: 0.01,
          checked_at: "2026-09-19T12:00:00.000Z",
        },
      }),
      parent,
      child,
      now,
    });

    expect({ ...confident, proposal: null }).toEqual({ ...doubtful, proposal: null });
    expect(confident.proposal).toEqual({
      proposer: "gptzero",
      suspicious_claim: UPSTREAM_SENTENCE,
      proposed_upstream: { url: "https://court.example/brief", citation: "Varghese v. China Southern Airlines" },
      proposer_confidence: 0.97,
      influence: "none",
    });
    expect(confident.confidence).not.toBe(0.97);
  });

  it("uses the flagged span only after finding it in the child", () => {
    const result = validateProposedEdge({ proposal: proposal(), parent: upstream(), child: downstream(), now });
    expect(result.evidence.span_verified).toBe(true);
    expect(result.evidence.passage_source).toBe("proposed-span");
    expect(result.evidence.validated_passage).toBe(UPSTREAM_SENTENCE);
  });

  it("falls back to the child's own passage when the flagged span is not in it", () => {
    const result = validateProposedEdge({
      proposal: proposal({ suspicious_claim: "A sentence this document never contained.", evidence_span: null }),
      parent: upstream(),
      child: downstream(),
      now,
    });

    expect(result.evidence.span_verified).toBe(false);
    expect(result.evidence.passage_source).toBe("extracted-passage");
    expect(result.reasons).toContain(
      "the proposed passage was not found in the child document; its own extracted passage was compared instead",
    );
  });

  it("refuses a proposal about a different document than the child supplied", () => {
    expect(() =>
      validateProposedEdge({
        proposal: proposal({ source_url: "https://other.example/post" }),
        parent: upstream(),
        child: downstream(),
        now,
      }),
    ).toThrow(/not the supplied child document/);
  });
});
