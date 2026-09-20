import type { BackendEdge, LineageTree, LineageTreeEdge, LineageTreeNode } from "./api";

/** Type this sentence in the landing-page search field to load the deterministic DAG demo. */
export const QUANTIZATION_DEMO_TRIGGER = "binarized neural networks";

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
}

/** The trigger is deliberately exact, case-insensitive, and forgiving of terminal punctuation. */
export function isQuantizationDemoQuery(value: string): boolean {
  return normalizedQuery(value) === QUANTIZATION_DEMO_TRIGGER;
}

type DemoNodeOptions = Pick<
  LineageTreeNode,
  "id" | "url" | "publisher" | "title" | "timestamp" | "passage" | "outbound_links" | "mutations" | "is_seed"
> & {
  /** Overrides the default synthetic/arXiv discovery-method guess for a node that is neither. */
  discoveredVia?: string;
};

function demoNode(index: number, options: DemoNodeOptions): LineageTreeNode {
  const { discoveredVia, ...node } = options;
  return {
    ...node,
    canonical_id: node.id,
    content_fingerprint: index.toString(16).padStart(64, "0"),
    mirror_urls: [],
    timestamp_source: "document-publication-label",
    timestamp_confidence: "strong",
    earliest_possible: node.timestamp,
    timestamp_conflict: null,
    fabricated_citations: [],
    ai_evidence: null,
    discovered_via: [discoveredVia ?? (node.publisher.startsWith("[SYNTHETIC]") ? "demo-synthetic-lineage" : "arXiv")],
    source_kind: "fetched",
  };
}

type DemoEdgeStatus = "validated" | "probable" | "related";

function demoEdge(
  parent_id: string,
  child_id: string,
  confidence: number,
  status: DemoEdgeStatus,
  basis: string,
  evidence: string[],
): LineageTreeEdge {
  return {
    parent_id,
    child_id,
    type: status === "related" ? "similarity" : "propagation",
    confidence,
    basis,
    shared_mutations: evidence,
    claim_mutations: [],
    explicit_link: status === "validated",
    rare_shared_phrases: evidence.length,
    similarity: confidence,
    temporal: { parent_time: null, child_time: null, gap_days: null, ordering: "unknown" },
    alternatives: [],
  };
}

function backendEdge(edge: LineageTreeEdge, status: DemoEdgeStatus): BackendEdge {
  return {
    id: `quantization-demo-${edge.parent_id}-${edge.child_id}`,
    source: edge.parent_id,
    target: edge.child_id,
    reference_url: null,
    status,
    ariadne_score: edge.confidence,
    score_method: "traversal-scoreEdge",
    type: edge.type,
    evidence: {
      basis: edge.basis,
      explicit_link: edge.explicit_link,
      shared_mutations: edge.shared_mutations,
      rare_shared_phrases: edge.rare_shared_phrases,
      similarity: edge.similarity,
      temporal: edge.temporal,
    },
    inspection: null,
    claim_mutations: [],
    recursed: false,
    directionality: "upstream_downstream",
    evidence_tags: [],
  } as BackendEdge;
}

const nodes: LineageTreeNode[] = [
  demoNode(1, {
    id: "binarized-neural-networks-2016",
    url: "https://arxiv.org/abs/1602.02830",
    publisher: "REAL SOURCE A · arXiv",
    title: "Binarized Neural Networks",
    timestamp: "2016-02-09T01:01:59Z",
    passage: "Itay Hubara, Matthieu Courbariaux, Daniel Soudry, Ran El-Yaniv, and Yoshua Bengio are credited on the 2016 Binarized Neural Networks paper. This is the real anchor that contributes the author list.",
    outbound_links: [],
    mutations: [],
    is_seed: false,
  }),
  demoNode(2, {
    id: "quantizing-deep-convolutional-networks-2018",
    url: "https://arxiv.org/abs/1806.08342",
    publisher: "REAL SOURCE B · arXiv",
    title: "Quantizing deep convolutional networks for efficient inference: A whitepaper",
    timestamp: "2018-06-21T17:32:46Z",
    passage: "Raghuraman Krishnamoorthi's whitepaper describes quantizing convolutional networks for efficient inference. This is the real anchor that contributes the exact title.",
    outbound_links: [],
    mutations: [],
    is_seed: false,
  }),
  demoNode(3, {
    id: "weakly-isolated-horizons-2016",
    url: "https://arxiv.org/abs/1612.01462",
    publisher: "REAL SOURCE C · arXiv",
    title: "Weakly Isolated Horizons: First order actions and gauge symmetries",
    timestamp: "2016-12-05T18:27:54Z",
    passage: "Alejandro Corichi, Juan D. Reyes, and Tatjana Vukašinac authored this completely unrelated general-relativity paper, arXiv:1612.01462. Its only role downstream is an identifier collision, not genuine semantic provenance.",
    outbound_links: [],
    mutations: [],
    is_seed: false,
  }),
  demoNode(4, {
    id: "reading-list-2017",
    url: "https://demo.ariadne.invalid/quantization/reading-list-2017",
    publisher: "[SYNTHETIC] · author extraction",
    title: "Quantization Reading List",
    timestamp: "2017-04-10T12:00:00Z",
    passage: "Research notes collecting important low-bit and binary neural-network papers. The Binarized Neural Networks author sequence is copied here verbatim: Hubara, Courbariaux, Soudry, Ran El-Yaniv, Bengio.",
    outbound_links: ["https://arxiv.org/abs/1602.02830"],
    mutations: ["[author_transplant] Full Binarized Neural Networks author list copied into reading-list notes"],
    is_seed: false,
  }),
  demoNode(5, {
    id: "author-cache-2018",
    url: "https://demo.ariadne.invalid/quantization/bibtex-cache-2018",
    publisher: "[SYNTHETIC] · reference manager entry",
    title: "Reference Manager Entry",
    timestamp: "2018-01-19T12:00:00Z",
    passage: "The reading list's citation is transcribed into a reference manager. During transcription, 'Ran El-Yaniv' mutates into 'Rami El-Yaniv'.",
    outbound_links: ["https://demo.ariadne.invalid/quantization/reading-list-2017"],
    mutations: ["[author_name_mutation] Ran El-Yaniv → Rami El-Yaniv during reference-manager transcription"],
    is_seed: false,
  }),
  demoNode(6, {
    id: "title-survey-2019",
    url: "https://demo.ariadne.invalid/quantization/survey-bibliography-2019",
    publisher: "[SYNTHETIC] · related-work notes",
    title: "Related-Work Notes",
    timestamp: "2019-07-22T12:00:00Z",
    passage: "Notes on neural-network quantization copy Krishnamoorthi's exact whitepaper title, but do not preserve his original authorship or arXiv identifier.",
    outbound_links: ["https://arxiv.org/abs/1806.08342"],
    mutations: ["[title_transplant] Exact Krishnamoorthi whitepaper title copied without its authors or identifier"],
    is_seed: false,
  }),
  demoNode(7, {
    id: "merged-citation-2021",
    url: "https://demo.ariadne.invalid/quantization/merged-citation-2021",
    publisher: "[SYNTHETIC] · merged bibliography entry",
    title: "Merged Bibliography Entry",
    timestamp: "2021-03-16T12:00:00Z",
    passage: "A malformed citation now combines the author list derived from Binarized Neural Networks (Hubara, Courbariaux, Soudry, Rami El-Yaniv, Bengio) with the title of Krishnamoorthi's whitepaper. Identifier: missing. Year: uncertain.",
    outbound_links: [
      "https://demo.ariadne.invalid/quantization/bibtex-cache-2018",
      "https://demo.ariadne.invalid/quantization/survey-bibliography-2019",
    ],
    mutations: ["[metadata_merge] Hubara-derived author list merged with Krishnamoorthi's title into one entry"],
    is_seed: false,
  }),
  demoNode(8, {
    id: "malformed-bibtex-2022",
    url: "https://demo.ariadne.invalid/quantization/malformed-bibtex-2022",
    publisher: "[SYNTHETIC] · citation completion output",
    title: "Citation Completion Output",
    timestamp: "2022-09-08T12:00:00Z",
    passage: "An automated citation-completion step fills the merged entry's missing identifier with the unrelated arXiv:1612.01462 identifier, and guesses year 2017. Output: Itay Hubara, Matthieu Courbariaux, Daniel Soudry, Rami El-Yaniv, Yoshua Bengio; 'Quantizing deep convolutional networks for efficient inference: A whitepaper'; arXiv:1612.01462; 2017.",
    outbound_links: [
      "https://demo.ariadne.invalid/quantization/merged-citation-2021",
      "https://arxiv.org/abs/1612.01462",
    ],
    mutations: ["[identifier_hijack] Missing identifier filled with unrelated arXiv:1612.01462"],
    is_seed: false,
  }),
  demoNode(9, {
    id: "generated-draft-2024",
    url: "https://demo.ariadne.invalid/quantization/generated-related-work-2024",
    publisher: "[SYNTHETIC] · generated related-work draft",
    title: "Generated Related-Work Draft",
    timestamp: "2024-05-24T12:00:00Z",
    passage: "The malformed citation is inserted into a generated related-work paragraph and preserved without verification.",
    outbound_links: ["https://demo.ariadne.invalid/quantization/malformed-bibtex-2022"],
    mutations: ["[citation_propagation] Malformed citation reused verbatim in a generated related-work paragraph"],
    is_seed: false,
  }),
  demoNode(10, {
    id: "neurips-paper-2025",
    url: "https://demo.ariadne.invalid/quantization/neurips-paper-2025",
    publisher: "REAL FINAL DOCUMENT · NeurIPS 2025",
    title: "Learning Grouped Lattice Vector Quantizers for Low-Bit LLM Compression",
    timestamp: "2025-12-03T12:00:00Z",
    passage: "The published NeurIPS 2025 paper's related-work section contains the hallucinated citation: authors Itay Hubara, Matthieu Courbariaux, Daniel Soudry, Rami El-Yaniv, Yoshua Bengio; title 'Quantizing deep convolutional networks for efficient inference: A whitepaper'; year 2017; identifier arXiv:1612.01462.",
    outbound_links: ["https://demo.ariadne.invalid/quantization/generated-related-work-2024"],
    mutations: ["[citation_propagation] Hallucinated citation preserved into the published bibliography"],
    is_seed: false,
    discoveredVia: "NeurIPS 2025 proceedings",
  }),
];

const configuredEdges = [
  {
    edge: demoEdge(
      "binarized-neural-networks-2016", "reading-list-2017", 0.97,
      "probable",
      "Author extraction exactly preserves the Binarized Neural Networks author list.",
      ["same five authors", "author order preserved", "2016 source explicitly referenced"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "reading-list-2017", "author-cache-2018", 0.94,
      "probable",
      "The cache retains the reading list's author set with one name-level typo.",
      ["same author sequence", "single first-name typo", "bibliography structure matches"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "quantizing-deep-convolutional-networks-2018", "title-survey-2019", 0.94,
      "probable",
      "Title extraction carries Krishnamoorthi's paper title into the survey bibliography.",
      ["exact title preserved", "same topic", "2018 source cited"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "author-cache-2018", "merged-citation-2021", 0.86,
      "probable",
      "The merged citation inherits the typo-bearing Hubara author record from the BibTeX cache.",
      ["Hubara author set preserved", "Rami El-Yaniv typo persists", "metadata merger structure"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "title-survey-2019", "merged-citation-2021", 0.89,
      "probable",
      "The merger retains the survey's exact Krishnamoorthi title alongside the unrelated author list.",
      ["exact title preserved", "same topic", "bibliography structure matches"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "merged-citation-2021", "malformed-bibtex-2022", 0.85,
      "probable",
      "Authors and title are preserved while a newly introduced identifier corrupts the citation.",
      ["authors and title preserved", "identifier newly introduced", "citation formatting nearly identical"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "weakly-isolated-horizons-2016", "malformed-bibtex-2022", 1,
      "related",
      "An identifier collision, not genuine provenance: arXiv:1612.01462 matches exactly, but this paper's title, authors, and subject share nothing with the citation being assembled.",
      ["arXiv:1612.01462 identifier matches exactly", "title conflicts", "authors conflict", "subject matter unrelated"],
    ),
    status: "related" as const,
  },
  {
    edge: demoEdge(
      "malformed-bibtex-2022", "generated-draft-2024", 0.88,
      "probable",
      "The generated draft carries forward the same malformed title, author, and identifier combination.",
      ["citation formatting nearly identical", "wrong identifier preserved", "same author-title combination"],
    ),
    status: "probable" as const,
  },
  {
    edge: demoEdge(
      "generated-draft-2024", "neurips-paper-2025", 1,
      "validated",
      "The hallucinated citation actually appears in the published NeurIPS 2025 bibliography, carried forward unchanged from the generated draft.",
      ["citation preserved verbatim", "same malformed identifier", "appears in published bibliography"],
    ),
    status: "validated" as const,
  },
];

export const QUANTIZATION_DEMO: { tree: LineageTree; edges: BackendEdge[] } = {
  tree: {
    seed: { claim: "Quantization citation convergence investigation", url: null, fabricated_citations: [] },
    generated_at: "2026-09-20T00:00:00.000Z",
    root_ids: [
      "binarized-neural-networks-2016",
      "quantizing-deep-convolutional-networks-2018",
      "weakly-isolated-horizons-2016",
    ],
    nodes,
    edges: configuredEdges.map(({ edge }) => edge),
    rejected_edges: [
      {
        parent_id: "merged-citation-2021",
        child_id: "Efficient Integer Quantization Survey",
        confidence: 0.2,
        reason: "similar quantization topic\nno matching author set\nno matching identifier\nweak title overlap\ninsufficient provenance evidence",
      },
    ],
    excluded: [],
    status: "complete",
    diagnostics: [],
    stats: {
      pipeline: "recursive-provenance",
      max_depth: 5,
      sources_expanded: 10,
      proposals_received: 10,
      fetched: 10,
      fetch_failures: 0,
      analysis_requests: 10,
      citation_edges: 0,
    },
  },
  edges: configuredEdges.map(({ edge, status }) => backendEdge(edge, status)),
};
