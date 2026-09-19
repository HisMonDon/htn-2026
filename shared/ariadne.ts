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

export const AriadneNode = TreeNode.extend({ source_kind: z.enum(["fetched", "submitted"]) });
export type AriadneNode = z.infer<typeof AriadneNode>;

const endpointFields = {
  id: z.string(),
  source: z.string().nullable(),
  target: z.string(),
  reference_url: z.string().nullable(),
};

export const AriadneEdge = z.discriminatedUnion("status", [
  z.object({
    ...endpointFields,
    source: z.string(),
    status: z.literal("validated"),
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
  }),
  z.object({
    ...endpointFields,
    status: z.literal("rejected"),
    ariadne_score: z.number().min(0).max(1).nullable(),
    score_method: z.literal("traversal-scoreEdge"),
    reason: z.string(),
    termination: z.enum(["invalid-proposal", "fetch-failure", "duplicate-source", "cycle", "already-visited", "already-accepted", "validation-rejected"]),
  }),
  z.object({ ...endpointFields, status: z.literal("candidate"), reason: z.string() }),
]);
export type AriadneEdge = z.infer<typeof AriadneEdge>;

export const AriadneExecution = z.object({
  proposer: z.enum(["live", "cached_demo_fallback", "mock"]),
  fallbacks: z.array(z.object({ source_id: z.string(), captured_at: z.iso.datetime({ offset: true }) })),
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
    reason: z.enum(["no-proposals", "max-depth", "provider-failure", "all-proposals-rejected", "accepted-parents", "candidate-roots"]),
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
      fetched: z.number(), fetch_failures: z.number(), analysis_requests: z.number(),
    }),
  }),
});
export type AriadneResponse = z.infer<typeof AriadneResponse>;
