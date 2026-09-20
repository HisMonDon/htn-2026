import { z } from "zod";
import { ValidationEvidence, ValidationSignal } from "./provenance-validation";
import { ClaimMutation, TemporalEvidence, TreeEdge, TreeNode } from "./tree";

const httpUrl = z.url().refine((x) => {
  const url = new URL(x);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "expected an HTTP(S) URL without credentials");

export const AriadneRequest = z.object({
  claim: z.string().trim().min(1).max(2000),
  seed_url: httpUrl.optional(),
  seed_text: z.string().trim().min(1).max(100000).optional(),
  seed_source: z.object({
    url: httpUrl.nullable().optional(),
    title: z.string().trim().min(1).max(1000).nullable().optional(),
    citation: z.string().trim().min(1).max(2000).nullable().optional(),
    author: z.string().trim().min(1).max(500).nullable().optional(),
  }).strict().refine((x) => Object.values(x).some(Boolean), "seed_source must identify a source").nullable().optional(),
  fabricated_citations: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  include_ai_evidence: z.boolean().optional(),
  max_depth: z.number().int().min(0).max(10).optional(),
  max_provider_requests: z.number().int().min(1).max(10).optional(),
}).strict().refine((x) => [Boolean(x.seed_url), Boolean(x.seed_source), Boolean(x.seed_text)].filter(Boolean).length <= 1, {
  message: "provide only one of seed_url, seed_source, or seed_text",
});
export type AriadneRequest = z.infer<typeof AriadneRequest>;

export const AriadneDiagnostic = z.object({
  stage: z.enum(["gptzero", "resolution", "fetch", "extraction", "validation", "traversal", "serialization"]),
  source: z.string().nullable(),
  category: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});
export type AriadneDiagnostic = z.infer<typeof AriadneDiagnostic>;

export const AcademicPaperMetadata = z.object({
  semantic_scholar_paper_id: z.string().nullable().optional(),
  doi: z.string().nullable().optional(),
  arxiv_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().nullable().optional(),
  publication_date: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  canonical_url: z.string().nullable().optional(),
  metadata_only: z.boolean().optional(),
});
export const AriadneNode = TreeNode.extend({
  source_kind: z.enum(["fetched", "submitted", "citation-metadata"]),
  /** Present for paper nodes. `metadata_only` means no full paper text was acquired. */
  academic_metadata: AcademicPaperMetadata.nullable().optional(),
});
export type AriadneNode = z.infer<typeof AriadneNode>;

const endpointFields = {
  id: z.string(),
  source: z.string().nullable(),
  target: z.string(),
  reference_url: z.string().nullable(),
};

const validatedEvidenceFields = {
  ariadne_score: z.number().min(0).max(1),
  score_method: z.literal("traversal-scoreEdge"),
  type: TreeEdge.shape.type,
  evidence: z.object({
    basis: z.string(),
    explicit_link: z.boolean(),
    shared_mutations: z.array(z.string()),
    rare_shared_phrases: z.number(),
    similarity: z.number(),
    temporal: TemporalEvidence,
  }),
  inspection: z.object({
    validator: z.literal("lineage-deterministic-v1"),
    role: z.literal("supplementary-inspection"),
    signals: z.array(ValidationSignal),
    evidence: ValidationEvidence,
  }).nullable(),
  claim_mutations: z.array(ClaimMutation),
  recursed: z.boolean(),
  /** "unknown" when the evidence cannot support a claimed upstream->downstream order. */
  directionality: z.enum(["upstream_downstream", "unknown"]),
  /** Why this edge exists, derived only from scoring signals, never provider/search metadata. */
  evidence_tags: z.array(z.enum([
    "explicit_reference",
    "shared_fabricated_citation",
    "shared_named_entities",
    "rare_phrase_overlap",
    "semantic_overlap",
  ])),
};

export const AriadneEdge = z.discriminatedUnion("status", [
  z.object({
    ...endpointFields,
    ...validatedEvidenceFields,
    source: z.string(),
    status: z.literal("validated"),
  }),
  z.object({
    ...endpointFields,
    ...validatedEvidenceFields,
    source: z.string(),
    /**
     * Exploratory/deep-mode-only: meaningful provenance evidence exists (a link, shared citation,
     * or rare shared phrasing) but the edge falls below the strict validated threshold. This is NOT
     * validated provenance and must never be presented or serialized as "validated".
     */
    status: z.literal("probable"),
  }),
  z.object({
    ...endpointFields,
    ...validatedEvidenceFields,
    source: z.string(),
    /**
     * Deep-mode-only: a meaningfully connected document worth investigating, on thinner evidence
     * than "probable". This is an investigative crosslink, not a provenance claim: it never implies
     * propagation direction beyond what `directionality` states, and it is excluded from mutation
     * analysis (`claim_mutations` is always empty for this status).
     */
    status: z.literal("related"),
  }),
  z.object({
    ...endpointFields,
    source: z.string(),
    status: z.literal("citation"),
    relationship_kind: z.literal("citation"),
    /** `references`: source cites target. `cited_by`: source cites target, found while expanding target. */
    direction: z.enum(["references", "cited_by"]),
    recursed: z.boolean(),
    provider_metadata: z.object({
      provider: z.literal("semantic-scholar"),
      resolved_paper_id: z.string(),
      resolved_by: z.enum(["doi", "semantic_scholar_paper_id", "arxiv", "scholarly_url", "title_author"]),
      paper: AcademicPaperMetadata,
      contexts: z.array(z.string()),
      intents: z.array(z.string()),
      is_influential: z.boolean().nullable(),
    }),
  }),
  z.object({
    ...endpointFields,
    status: z.literal("rejected"),
    ariadne_score: z.number().min(0).max(1).nullable(),
    score_method: z.literal("traversal-scoreEdge"),
    reason: z.string(),
    termination: z.enum([
      "invalid-proposal",
      "fetch-failure",
      "duplicate-source",
      "cycle",
      "already-visited",
      "already-accepted",
      "validation-rejected",
      "exploratory-branch-cap",
      "related-branch-cap",
      "children-per-node-cap",
      "edge-budget-exhausted",
    ]),
    /** Rejections never assert a provenance direction. */
    directionality: z.literal("unknown").default("unknown"),
    evidence_tags: z.array(z.enum([
      "explicit_reference",
      "shared_fabricated_citation",
      "shared_named_entities",
      "rare_phrase_overlap",
      "semantic_overlap",
    ])).default([]),
  }),
  z.object({
    ...endpointFields,
    status: z.literal("candidate"),
    reason: z.string(),
    /** Candidate links use discovery order, never a provenance direction. */
    directionality: z.literal("unknown").default("unknown"),
    evidence_tags: z.array(z.enum([
      "explicit_reference",
      "shared_fabricated_citation",
      "shared_named_entities",
      "rare_phrase_overlap",
      "semantic_overlap",
    ])).default([]),
  }),
]);
export type AriadneEdge = z.infer<typeof AriadneEdge>;

export const AriadneExecution = z.object({
  proposer: z.enum(["live", "cached_demo_fallback", "mock"]),
  fallbacks: z.array(z.object({ source_id: z.string(), captured_at: z.iso.datetime({ offset: true }) })),
  /**
   * "exploratory" means this response may include "probable" edges; "deep" means it may also
   * include "related" edges. See AriadneEdge.status.
   */
  provenance_mode: z.enum(["strict", "exploratory", "deep"]),
});
export type AriadneExecution = z.infer<typeof AriadneExecution>;

export const AriadneResponse = z.object({
  id: z.string(),
  status: z.enum(["complete", "partial", "failed"]),
  root: z.object({ id: z.string(), url: z.string().nullable(), title: z.string().nullable(), date: z.string().nullable(), text: z.string().nullable() }),
  nodes: z.array(AriadneNode),
  edges: z.array(AriadneEdge),
  terminations: z.array(z.object({
    source_id: z.string(), url: z.string(), depth: z.number(),
    reason: z.enum(["no-proposals", "max-depth", "provider-failure", "all-proposals-rejected", "accepted-parents", "citation-edges", "candidate-roots", "node-budget-exhausted"]),
    detail: z.string().nullable(),
  })),
  warnings: z.array(AriadneDiagnostic),
  errors: z.array(AriadneDiagnostic),
  execution: AriadneExecution,
  pending: z.array(z.object({
    source_id: z.string(), reason: z.enum(["provider-pending", "rate-limit"]), retry_after_ms: z.number().nullable(),
  })),
  resume_url: z.string().nullable(),
  tree: z.object({
    seed: z.object({ claim: z.string(), url: z.string().nullable(), fabricated_citations: z.array(z.string()) }),
    generated_at: z.iso.datetime({ offset: true }),
    root_ids: z.array(z.string()),
    nodes: z.array(AriadneNode),
    edges: z.array(TreeEdge),
    rejected_edges: z.array(z.object({ parent_id: z.string(), child_id: z.string(), confidence: z.number(), reason: z.string() })),
    excluded: z.array(z.object({ id: z.string(), url: z.string(), reason: z.string() })),
    status: z.enum(["complete", "partial", "failed"]),
    diagnostics: z.array(AriadneDiagnostic),
    stats: z.object({
      pipeline: z.literal("recursive-provenance"),
      max_depth: z.number(), sources_expanded: z.number(), proposals_received: z.number(),
      fetched: z.number(), fetch_failures: z.number(), analysis_requests: z.number(), citation_edges: z.number(),
    }),
  }),
});
export type AriadneResponse = z.infer<typeof AriadneResponse>;
