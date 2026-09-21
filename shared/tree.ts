import { z } from "zod";
import { AiEvidence } from "./schema";

/**
 * Output of automatic provenance reconstruction: a short propagation tree rebuilt from a
 * discovered candidate pool. Additive to the Case contract; nothing here changes Case.
 */

const timestamp = z.iso.datetime({ offset: true });
const confidence = z.number().min(0).max(1);

/** Where a normalized document's claimed timestamp came from. */
export const TimestampSource = z.enum([
  "meta",
  "json-ld",
  "time-element",
  "pdf-metadata",
  "court-filing-header",
  "document-publication-label",
  "url",
  "search-result",
  "none",
]);

/** Confidence in the timestamp evidence; scoring retains its established thresholds. */
export const TimestampConfidence = z.enum(["strong", "moderate", "weak", "none"]);

export const TreeNode = z.object({
  id: z.string().min(1),
  /** Stable SHA-256 identity of the artifact, independent of its hosting URL. */
  canonical_id: z.string().min(1),
  content_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url(),
  /** Other URLs that served the same exact extracted artifact. */
  mirror_urls: z.array(z.url()),
  publisher: z.string().min(1),
  title: z.string(),
  /** Publication time the document claims, if any. */
  timestamp: timestamp.nullable(),
  timestamp_source: TimestampSource,
  timestamp_confidence: TimestampConfidence,
  /**
   * Earliest time the document can have existed, given what it links to. Equals `timestamp`
   * unless the document links to something published later than its own claimed date.
   */
  earliest_possible: timestamp.nullable(),
  timestamp_conflict: z.string().nullable(),
  passage: z.string(),
  outbound_links: z.array(z.string()),
  fabricated_citations: z.array(z.string()),
  mutations: z.array(z.string()),
  ai_evidence: AiEvidence.nullable(),
  discovered_via: z.array(z.string()).min(1),
  is_seed: z.boolean(),
});

export const TemporalEvidence = z.object({
  parent_time: timestamp.nullable(),
  child_time: timestamp.nullable(),
  gap_days: z.number().nullable(),
  ordering: z.enum(["strict", "same-time", "from-link", "unknown"]),
});

export const EdgeAlternative = z.object({
  candidate_id: z.string(),
  confidence,
  reason: z.string(),
});

/** A human-readable change in the claim-bearing passage from parent to child. */
export const ClaimMutation = z.object({
  type: z.enum(["added", "omitted", "reframed"]),
  summary: z.string().min(1),
  before: z.string().min(1).nullable(),
  after: z.string().min(1).nullable(),
}).superRefine((mutation, ctx) => {
  const valid =
    (mutation.type === "added" && mutation.before === null && mutation.after !== null) ||
    (mutation.type === "omitted" && mutation.before !== null && mutation.after === null) ||
    (mutation.type === "reframed" && mutation.before !== null && mutation.after !== null);
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      message: "added needs only after, omitted needs only before, and reframed needs both",
    });
  }
});

export const TreeEdge = z.object({
  parent_id: z.string(),
  child_id: z.string(),
  type: z.enum(["propagation", "similarity"]),
  confidence,
  basis: z.string().min(1),
  shared_mutations: z.array(z.string()),
  claim_mutations: z.array(ClaimMutation),
  explicit_link: z.boolean(),
  rare_shared_phrases: z.number().int().min(0),
  similarity: z.number().min(0).max(1),
  temporal: TemporalEvidence,
  alternatives: z.array(EdgeAlternative),
});

export const RejectedEdge = z.object({
  parent_id: z.string(),
  child_id: z.string(),
  confidence,
  reason: z.string(),
});

export const ExcludedCandidate = z.object({
  id: z.string(),
  url: z.string(),
  reason: z.string(),
});

export const ResearchDiagnostic = z.object({
  stage: z.enum(["proposal_mapping", "resolution", "fetch", "extraction", "validation", "traversal", "reconstruction", "mutation", "serialization"]),
  source: z.url().nullable(),
  category: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
});

export const LineageTree = z
  .object({
    seed: z.object({
      claim: z.string(),
      url: z.url().nullable(),
      fabricated_citations: z.array(z.string()),
    }),
    generated_at: timestamp,
    root_ids: z.array(z.string()),
    nodes: z.array(TreeNode),
    edges: z.array(TreeEdge),
    rejected_edges: z.array(RejectedEdge),
    excluded: z.array(ExcludedCandidate),
    status: z.enum(["complete", "partial", "failed"]),
    diagnostics: z.array(ResearchDiagnostic),
    stats: z.object({
      /** The configured fallback-search provider; direct source fetching has no credential dependency. */
      discovery: z.enum(["browserbase", "offline-corpus", "unconfigured"]),
      retrieval: z.enum(["elastic-hybrid", "elastic-lexical", "memory-bm25"]),
      queries: z.array(z.string()),
      failed_queries: z.array(z.string()),
      /** Fetched but not turned into a document, e.g. an encrypted or scanned PDF. Nonfatal. */
      extraction_failures: z.array(z.string()),
      fetched: z.number().int().min(0),
      candidates: z.number().int().min(0),
      pairs_scored: z.number().int().min(0),
    }),
  })
  .superRefine((tree, ctx) => {
    const ids = new Set<string>(tree.nodes.map((node) => node.id));
    const incoming = new Map<string, Set<string>>(tree.nodes.map((node) => [node.id, new Set()]));
    const children = new Map<string, Set<string>>(tree.nodes.map((node) => [node.id, new Set()]));
    const edgeKeys = new Set<string>();
    tree.edges.forEach((edge, index) => {
      if (!ids.has(edge.parent_id) || !ids.has(edge.child_id)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "edge references an unknown node" });
        return;
      }
      if (edge.parent_id === edge.child_id) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "an edge cannot point to the same node" });
        return;
      }
      const edgeKey = `${edge.parent_id}\u0000${edge.child_id}`;
      if (edgeKeys.has(edgeKey)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "duplicate accepted edge" });
        return;
      }
      edgeKeys.add(edgeKey);
      incoming.get(edge.child_id)!.add(edge.parent_id);
      children.get(edge.parent_id)!.add(edge.child_id);
    });
    const times = new Map<string, string | null>(
      tree.nodes.map((node) => [node.id, node.earliest_possible]),
    );
    tree.edges.forEach((edge, index) => {
      const parent = times.get(edge.parent_id);
      const child = times.get(edge.child_id);
      if (parent && child && Date.parse(parent) > Date.parse(child)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "a later document cannot parent an earlier one" });
      }
    });
    const indegree = new Map([...incoming].map(([id, parents]) => [id, parents.size]));
    const queue = [...ids].filter((id) => indegree.get(id) === 0).sort();
    let visited = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const parent = queue[index]!;
      visited += 1;
      for (const child of children.get(parent) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) queue.push(child);
      }
    }
    if (visited !== ids.size) {
      ctx.addIssue({ code: "custom", path: ["edges"], message: "edges contain a cycle" });
    }
    const expectedRoots = [...incoming].filter(([, parents]) => parents.size === 0).map(([id]) => id).sort();
    const suppliedRoots = [...new Set<string>(tree.root_ids)].sort();
    for (const root of suppliedRoots) {
      if (!ids.has(root) || (incoming.get(root)?.size ?? 0) > 0) {
        ctx.addIssue({ code: "custom", path: ["root_ids"], message: `root "${root}" is unknown or has a parent` });
      }
    }
    if (tree.root_ids.length !== suppliedRoots.length || expectedRoots.join("\u0000") !== suppliedRoots.join("\u0000")) {
      ctx.addIssue({ code: "custom", path: ["root_ids"], message: "root_ids must list every node without an accepted parent exactly once" });
    }
  });

export type TreeNode = z.infer<typeof TreeNode>;
export type TreeEdge = z.infer<typeof TreeEdge>;
export type ClaimMutation = z.infer<typeof ClaimMutation>;
export type RejectedEdge = z.infer<typeof RejectedEdge>;
export type ResearchDiagnostic = z.infer<typeof ResearchDiagnostic>;
export type LineageTree = z.infer<typeof LineageTree>;
