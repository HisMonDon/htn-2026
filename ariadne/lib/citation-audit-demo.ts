/**
 * A second hardcoded demo, alongside the quantization-chimera one (see quantization-demo.ts):
 * a citation-accuracy audit. Instead of tracing how a claim mutated as it propagated, this one
 * checks whether a paper's own reference list actually points at real, matching sources — the
 * "citation" provenance status (see ProvenanceStatus in lib/graph.ts) exists precisely for this:
 * edges recovered from a citation graph rather than scored by Ariadne's own text-similarity work.
 * Review verdicts per citation are carried in each node's `fabricated_citations` list, the one
 * existing field meant for exactly this ("this citation looks fabricated/incorrect"), so they
 * surface in the node drawer GraphVisualizer already renders — no new UI needed.
 */
import type { BackendEdge, LineageTree, LineageTreeEdge, LineageTreeNode } from "./api";

/** Type this sentence in the landing-page search field to load the deterministic citation-audit demo. */
export const CITATION_AUDIT_DEMO_TRIGGER = "memory-augmented potential field theory";

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
}

/** The trigger is deliberately exact, case-insensitive, and forgiving of terminal punctuation. */
export function isCitationAuditDemoQuery(value: string): boolean {
  return normalizedQuery(value) === CITATION_AUDIT_DEMO_TRIGGER;
}

type DemoNodeOptions = Pick<
  LineageTreeNode,
  | "id"
  | "url"
  | "publisher"
  | "title"
  | "timestamp"
  | "passage"
  | "outbound_links"
  | "fabricated_citations"
  | "is_seed"
> & {
  sourceKind?: LineageTreeNode["source_kind"];
};

function demoNode(index: number, options: DemoNodeOptions): LineageTreeNode {
  const { sourceKind, ...node } = options;
  return {
    ...node,
    mutations: [],
    canonical_id: node.id,
    content_fingerprint: index.toString(16).padStart(64, "0"),
    mirror_urls: [],
    timestamp_source: "document-publication-label",
    timestamp_confidence: "strong",
    earliest_possible: node.timestamp,
    timestamp_conflict: null,
    ai_evidence: null,
    discovered_via: [node.is_seed ? "submitted-text" : "semantic-scholar"],
    source_kind: sourceKind ?? "fetched",
  };
}

type DemoEdgeStatus = "citation";

/** Every edge here is a citation-graph link: the parent cites the child, recovered from lookup, not scored. */
function demoEdge(parent_id: string, child_id: string, basis: string): LineageTreeEdge {
  return {
    parent_id,
    child_id,
    type: "propagation",
    confidence: 1,
    basis,
    shared_mutations: [],
    claim_mutations: [],
    explicit_link: true,
    rare_shared_phrases: 0,
    similarity: 1,
    temporal: { parent_time: null, child_time: null, gap_days: null, ordering: "unknown" },
    alternatives: [],
  };
}

function backendEdge(edge: LineageTreeEdge, status: DemoEdgeStatus): BackendEdge {
  return {
    id: `citation-audit-demo-${edge.parent_id}-${edge.child_id}`,
    source: edge.parent_id,
    target: edge.child_id,
    reference_url: null,
    status,
    type: edge.type,
    evidence: {
      basis: edge.basis,
      explicit_link: edge.explicit_link,
      shared_mutations: edge.shared_mutations,
      rare_shared_phrases: edge.rare_shared_phrases,
      similarity: edge.similarity,
      temporal: edge.temporal,
    },
    claim_mutations: [],
    recursed: false,
    directionality: "upstream_downstream",
    evidence_tags: [],
  } as unknown as BackendEdge;
}

const REVIEWER = "Edlyn To";

const nodes: LineageTreeNode[] = [
  demoNode(1, {
    id: "memory-augmented-potential-field-theory",
    url: "https://demo.ariadne.invalid/citation-audit/memory-augmented-potential-field-theory",
    publisher: "User submission",
    title: "Memory-Augmented Potential Field Theory: A Framework for Adaptive Control in Non-Convex Domains",
    timestamp: null,
    passage: "The paper under audit. Its reference list is checked against real citation-graph lookups, not against Ariadne's own text-similarity scoring.",
    outbound_links: [],
    fabricated_citations: [],
    is_seed: true,
    sourceKind: "submitted",
  }),
  demoNode(2, {
    id: "deep-koopman-operator-2020",
    // No real match: no paper by these authors exists in Chaos or anywhere else searched.
    url: "https://demo.ariadne.invalid/citation-audit/deep-koopman-operator-2020",
    publisher: "Chaos: An Interdisciplinary Journal of Nonlinear Science",
    title:
      "Mingliang Han, Bingni W Wei, Phelan Senatus, Jörg D Winkel, Mason Youngblood, I-Han Lee, and David J Mandell. Deep koopman operator: A model-free approach to nonlinear dynamical systems. Chaos: An Interdisciplinary Journal of Nonlinear Science, 30(12):123135, 2020.",
    timestamp: "2020-12-01T00:00:00Z",
    passage: "Cited as prior work on model-free operator-theoretic approaches to nonlinear dynamics.",
    outbound_links: [],
    fabricated_citations: [
      `${REVIEWER} (2:13 AM): No title or author match. Journal and other identifiers match this article.`,
    ],
    is_seed: false,
  }),
  demoNode(3, {
    id: "benchmark-model-power-system-2020",
    // Real underlying paper by the same author group: "Fundamentals of power systems modelling in
    // the presence of converter-interfaced generation," Electric Power Systems Research 189:106811
    // (2020), doi:10.1016/j.epsr.2020.106811 — title, venue, volume, issue, and pages in the cited
    // text don't match it, matching the review comment below.
    url: "https://www.sciencedirect.com/science/article/abs/pii/S037877962030482X",
    publisher: "IEEE Transactions on Power Systems",
    title:
      "Mario Paolone, Trevor Gaunt, Xavier Guillaud, Marco Liserre, Sakis Meliopoulos, Antonello Monti, Thierry Van Cutsem, Vijay Vittal, and Costas Vournas. A benchmark model for power system stability controls. IEEE Transactions on Power Systems, 35(5):3627-3635, 2020.",
    timestamp: "2020-09-01T00:00:00Z",
    passage: "Cited as the benchmark model used for the power-system stability control comparisons.",
    outbound_links: [],
    fabricated_citations: [
      `${REVIEWER} (2:13 AM): The authors match this paper, but the title, publisher, volume, issue, and page numbers are incorrect. Year (2020) is correct.`,
    ],
    is_seed: false,
  }),
  demoNode(4, {
    id: "tube-mppi-covariance-steering-2022",
    url: "https://arxiv.org/abs/2110.07744",
    publisher: "2022 American Control Conference (ACC)",
    title:
      "Isin M Balci, Efstathios Bakolas, Bogdan Vlahov, and Evangelos A Theodorou. Constrained covariance steering based tube-MPPI. In 2022 American Control Conference (ACC), pages 4197-4202. IEEE, 2022.",
    timestamp: "2022-06-01T00:00:00Z",
    passage: "Cited as the tube-MPPI baseline used for constrained covariance steering. Verified: authors, title, venue, and pages all match.",
    outbound_links: [],
    fabricated_citations: [],
    is_seed: false,
  }),
  demoNode(5, {
    id: "voltage-source-converters-inertia-2020",
    url: "https://arxiv.org/abs/1910.05801",
    publisher: "Electric Power Systems Research",
    title:
      "Yihui Zuo, Mario Paolone, and Fabrizio Sossan. Effect of voltage source converters with electrochemical storage systems on dynamics of reduced-inertia bulk power grids. Electric Power Systems Research, 189:106766, 2020.",
    timestamp: "2020-12-01T00:00:00Z",
    passage: "Cited for the effect of storage-backed voltage source converters on reduced-inertia grid dynamics. Verified: authors, title, venue, and volume all match.",
    outbound_links: [],
    fabricated_citations: [],
    is_seed: false,
  }),
  demoNode(6, {
    id: "mosek-optimizer-api-2019",
    url: "https://www.mosek.com/",
    publisher: "MOSEK ApS",
    title: "MOSEK ApS, MOSEK Optimizer API for Python 9.2.40, 2019.",
    timestamp: "2019-01-01T00:00:00Z",
    passage: "Cited within the benchmark-model paper's own references as the optimizer used for its control formulation.",
    outbound_links: [],
    fabricated_citations: [
      `${REVIEWER} (2:14 AM): Source is not found. We did not find a likely match through online search.`,
      `${REVIEWER} (2:41 AM): Marked as resolved.`,
      `${REVIEWER} (2:41 AM): Re-opened.`,
    ],
    is_seed: false,
  }),
  demoNode(7, {
    id: "irena-renewable-energy-prospects-2018",
    url: "https://www.irena.org/How-we-work/Europe",
    publisher: "International Renewable Energy Agency (IRENA)",
    title:
      "[1] A. Z. Amin, \"Renewable energy prospects for the european union,\" International Renewable Energy Agency (IRENA) and European Commission, Tech. Rep., Feb 2018.",
    timestamp: "2018-02-01T00:00:00Z",
    passage: "Cited within the benchmark-model paper's own references for European renewable-energy deployment context.",
    outbound_links: [],
    fabricated_citations: [
      `${REVIEWER} (2:37 AM): We are not sure if we found the source. There are many differences between the citation and the source matched. Most similar source found: Europe. International Renewable Energy Agency (IRENA). https://www.irena.org/How-we-work/Europe.`,
    ],
    is_seed: false,
  }),
  demoNode(8, {
    id: "aemo-black-system-report-2016",
    url: "https://www.aemc.gov.au/markets-reviews-advice/review-of-the-system-black-event-in-south-australia",
    publisher: "Australian Energy Market Operator",
    title:
      "AEMO, \"Review of the black-system south australia report system event of 28 september 2016,\" Australian Energy Market Operator, Tech. Rep., 2016.",
    timestamp: "2016-09-28T00:00:00Z",
    passage: "Cited within the benchmark-model paper's own references for the 2016 South Australia black-system event.",
    outbound_links: [],
    fabricated_citations: [
      `${REVIEWER} (2:38 AM): We are not sure if we found the source. There are many differences between the citation and the source matched. Most similar source found: Review of the System Black Event in South Australia on 28.... https://www.aemc.gov.au/markets-reviews-advice/review-of-the-system-black-event-in-south-australia.`,
    ],
    is_seed: false,
  }),
  demoNode(9, {
    id: "westinghouse-frequency-oscillations-1982",
    url: "https://www.osti.gov/biblio/6139851-phase-ii-frequency-domain-analysis-low-frequency-oscillations-large-electric-power-systems-volume-basic-concepts-mathematical-models-computing-methods-final-report",
    publisher: "Westinghouse Electric Corp.",
    title:
      "R. Byerly, D. Sherman, and R. Bennon, \"Phase II: frequency domain analysis of low-frequency oscillations in large electric power systems. Volume 1.\" Westinghouse Electric Corp., Pittsburgh, PA (USA). Advanced Systems, Tech. Rep., 1982.",
    timestamp: "1982-01-01T00:00:00Z",
    passage: "Cited within the benchmark-model paper's own references for low-frequency oscillation analysis methodology.",
    outbound_links: [],
    fabricated_citations: [],
    is_seed: false,
  }),
];

const configuredEdges: { edge: LineageTreeEdge }[] = [
  {
    edge: demoEdge(
      "memory-augmented-potential-field-theory", "deep-koopman-operator-2020",
      "Cited as prior work on model-free operator-theoretic approaches to nonlinear dynamics.",
    ),
  },
  {
    edge: demoEdge(
      "memory-augmented-potential-field-theory", "benchmark-model-power-system-2020",
      "Cited as the benchmark model used for the power-system stability control comparisons.",
    ),
  },
  {
    edge: demoEdge(
      "memory-augmented-potential-field-theory", "tube-mppi-covariance-steering-2022",
      "Cited as the tube-MPPI baseline used for constrained covariance steering.",
    ),
  },
  {
    edge: demoEdge(
      "memory-augmented-potential-field-theory", "voltage-source-converters-inertia-2020",
      "Cited for the effect of storage-backed voltage source converters on reduced-inertia grid dynamics.",
    ),
  },
  {
    edge: demoEdge(
      "benchmark-model-power-system-2020", "mosek-optimizer-api-2019",
      "The benchmark-model paper cites this as the optimizer used for its own control formulation.",
    ),
  },
  {
    edge: demoEdge(
      "benchmark-model-power-system-2020", "irena-renewable-energy-prospects-2018",
      "The benchmark-model paper cites this for European renewable-energy deployment context.",
    ),
  },
  {
    edge: demoEdge(
      "benchmark-model-power-system-2020", "aemo-black-system-report-2016",
      "The benchmark-model paper cites this for the 2016 South Australia black-system event.",
    ),
  },
  {
    edge: demoEdge(
      "benchmark-model-power-system-2020", "westinghouse-frequency-oscillations-1982",
      "The benchmark-model paper cites this for low-frequency oscillation analysis methodology.",
    ),
  },
];

export const CITATION_AUDIT_DEMO: { tree: LineageTree; edges: BackendEdge[] } = {
  tree: {
    seed: {
      claim: "Memory-Augmented Potential Field Theory: A Framework for Adaptive Control in Non-Convex Domains",
      url: null,
      fabricated_citations: [],
    },
    generated_at: "2026-09-20T00:00:00.000Z",
    root_ids: ["memory-augmented-potential-field-theory"],
    nodes,
    edges: configuredEdges.map(({ edge }) => edge),
    rejected_edges: [],
    excluded: [],
    status: "complete",
    diagnostics: [],
    stats: {
      pipeline: "recursive-provenance",
      max_depth: 2,
      sources_expanded: nodes.length,
      proposals_received: configuredEdges.length,
      fetched: nodes.length,
      fetch_failures: 0,
      analysis_requests: 0,
      citation_edges: configuredEdges.length,
    },
  },
  edges: configuredEdges.map(({ edge }) => backendEdge(edge, "citation")),
};

/**
 * Per-node accent colors mirroring the reviewed mind map: rose for citations with a confirmed
 * mismatch or no match at all, gold for the benchmark paper's own nested references (uncertain
 * matches), and the default role color (unset here) for citations that were fully verified.
 */
export const CITATION_AUDIT_NODE_COLORS: Record<string, string> = {
  "deep-koopman-operator-2020": "#ef7f97",
  "benchmark-model-power-system-2020": "#ef7f97",
  "mosek-optimizer-api-2019": "#ef7f97",
  "irena-renewable-energy-prospects-2018": "#e8c26a",
  "aemo-black-system-report-2016": "#e8c26a",
  "westinghouse-frequency-oscillations-1982": "#e8c26a",
};
