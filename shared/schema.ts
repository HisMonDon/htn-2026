import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const confidence = z.number().min(0).max(1);

export const AiEvidence = z.object({
  provider: z.literal("gptzero"),
  ai_probability: confidence,
  label: z.enum(["human", "mixed", "ai"]),
  checked_at: timestamp,
  flagged_passages: z.array(z.string()),
});

export const Edge = z.object({
  parent_id: z.string().min(1),
  type: z.enum(["propagation", "similarity"]),
  confidence,
  basis: z.string().min(1),
});

export const ChainNode = z.object({
  id: z.string().min(1),
  url: z.url(),
  publisher: z.string().min(1),
  timestamp,
  excerpt: z.string().min(1),
  ai_evidence: AiEvidence.nullable(),
  edge: Edge.nullable(),
});

export const Falsehood = z.object({
  claim: z.string().min(1),
  why_false: z.string().min(1),
  independent_evidence_urls: z.array(z.url()).min(1),
});

export const DraftFields = z.object({
  subject: z.string(),
  body: z.string(),
});

export const Correction = z
  .object({
    route_type: z.enum(["form", "editorial_email", "author_contact", "none"]),
    route_url: z.url().nullable(),
    policy_summary: z.string(),
    draft_fields: DraftFields,
    draft_ready: z.boolean(),
  })
  .superRefine((correction, ctx) => {
    const { subject, body } = correction.draft_fields;
    if (correction.route_type === "none" && (subject !== "" || body !== "")) {
      ctx.addIssue({
        code: "custom",
        path: ["draft_fields"],
        message: 'route_type "none" requires empty draft_fields',
      });
    }
  });

export const Approval = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  decided_at: timestamp.nullable(),
});

export const ACTION_STEPS = [
  "open_source",
  "verify_passage",
  "locate_route",
  "fill_fields",
  "await_approval",
  "submit",
  "verify",
] as const;

export const ActionLogEntry = z.object({
  step: z.enum(ACTION_STEPS),
  status: z.enum(["pending", "attempted", "completed", "failed"]),
  timestamp,
  replay_url: z.url().nullable(),
});

export const Verification = z.object({
  status: z.enum(["not_started", "passed", "failed", "inconclusive"]),
  checked_at: timestamp.nullable(),
  observed_change: z.string().nullable(),
});

export const Case = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    falsehood: Falsehood,
    chain: z.array(ChainNode).min(1),
    correction: Correction,
    approval: Approval,
    action_log: z.array(ActionLogEntry),
    verification: Verification,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.chain.forEach((node, index) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["chain", index, "id"],
          message: `duplicate node id "${node.id}"`,
        });
      }
      seen.add(node.id);
      const previous = value.chain[index - 1];
      if (!previous && node.edge !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["chain", index, "edge"],
          message: "first node must have a null edge",
        });
      }
      if (previous && node.edge === null) {
        ctx.addIssue({
          code: "custom",
          path: ["chain", index, "edge"],
          message: "non-first node requires an edge",
        });
      }
      if (previous && node.edge && node.edge.parent_id !== previous.id) {
        ctx.addIssue({
          code: "custom",
          path: ["chain", index, "edge", "parent_id"],
          message: "edge must point to the previous node",
        });
      }
    });

    let submitCompleted = false;
    value.action_log.forEach((entry, index) => {
      if (
        entry.step === "submit" &&
        entry.status !== "pending" &&
        value.approval.status !== "approved"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action_log", index, "status"],
          message: 'a "submit" step may only run when approval.status is "approved"',
        });
      }
      if (entry.step === "verify" && !submitCompleted) {
        ctx.addIssue({
          code: "custom",
          path: ["action_log", index, "step"],
          message: 'a "verify" step requires an earlier completed "submit" step',
        });
      }
      if (entry.step === "submit" && entry.status === "completed") {
        submitCompleted = true;
      }
    });
  });

export type AiEvidence = z.infer<typeof AiEvidence>;
export type Edge = z.infer<typeof Edge>;
export type ChainNode = z.infer<typeof ChainNode>;
export type Falsehood = z.infer<typeof Falsehood>;
export type Correction = z.infer<typeof Correction>;
export type Approval = z.infer<typeof Approval>;
export type ActionStep = (typeof ACTION_STEPS)[number];
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;
export type Verification = z.infer<typeof Verification>;
export type Case = z.infer<typeof Case>;
