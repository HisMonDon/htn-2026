import { z } from "zod";
import { AiEvidence } from "./schema";

/**
 * Output of automatic provenance reconstruction: a short propagation tree rebuilt from a
 * discovered candidate pool. Additive to the Case contract; nothing here changes Case.
 */

const timestamp = z.iso.datetime({ offset: true });
const confidence = z.number().min(0).max(1);

export const TimestampSource = z.enum(["meta", "json-ld", "time-element", "url", "search-result", "none"]);

export const TreeNode = z.object({
  id: z.string().min(1),
  url: z.url(),
  publisher: z.string().min(1),
  title: z.string(),
  /** Publication time the document claims, if any. */
  timestamp: timestamp.nullable(),
  timestamp_source: TimestampSource,
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

export const TreeEdge = z.object({
  parent_id: z.string(),
  child_id: z.string(),
  type: z.enum(["propagation", "similarity"]),
  confidence,
  basis: z.string().min(1),
  shared_mutations: z.array(z.string()),
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
    stats: z.object({
      discovery: z.enum(["browserbase", "offline-corpus"]),
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
    const ids = new Set(tree.nodes.map((node) => node.id));
    const parents = new Map<string, string>();
    tree.edges.forEach((edge, index) => {
      if (!ids.has(edge.parent_id) || !ids.has(edge.child_id)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "edge references an unknown node" });
      }
      if (parents.has(edge.child_id)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "a node has at most one accepted parent" });
      }
      parents.set(edge.child_id, edge.parent_id);
    });
    const times = new Map(tree.nodes.map((node) => [node.id, node.earliest_possible]));
    tree.edges.forEach((edge, index) => {
      const parent = times.get(edge.parent_id);
      const child = times.get(edge.child_id);
      if (parent && child && Date.parse(parent) > Date.parse(child)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "a later document cannot parent an earlier one" });
      }
    });
    for (const start of parents.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = start;
      while (current !== undefined) {
        if (seen.has(current)) {
          ctx.addIssue({ code: "custom", path: ["edges"], message: "edges contain a cycle" });
          return;
        }
        seen.add(current);
        current = parents.get(current);
      }
    }
    for (const root of tree.root_ids) {
      if (!ids.has(root) || parents.has(root)) {
        ctx.addIssue({ code: "custom", path: ["root_ids"], message: `root "${root}" is unknown or has a parent` });
      }
    }
  });

export type TreeNode = z.infer<typeof TreeNode>;
export type TreeEdge = z.infer<typeof TreeEdge>;
export type RejectedEdge = z.infer<typeof RejectedEdge>;
export type LineageTree = z.infer<typeof LineageTree>;
