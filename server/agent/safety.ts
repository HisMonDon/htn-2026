import { createHash } from "node:crypto";
import type { Case } from "../../shared/schema";

/**
 * Safety policy for the action loop.
 *
 * - Real external sites may be opened and inspected, never submitted to.
 * - Submission requires approval.status === "approved" and a controlled-target origin.
 * - Falsehood is established only by independent evidence URLs, never by AI-writing scores.
 *
 * Operators cannot submit without a SubmissionPermit, and permits can only be minted here.
 */

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

export function isControlledTarget(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return allowedOrigins.includes(parsed.origin);
}

export function draftHash(draft: Case["correction"]["draft_fields"]): string {
  return createHash("sha256").update(JSON.stringify([draft.subject, draft.body])).digest("hex");
}

/** Falsehood must rest on independent evidence. AI-writing evidence never qualifies. */
export function assertIndependentEvidence(value: Case): void {
  if (value.falsehood.independent_evidence_urls.length === 0) {
    throw new SafetyError("falsehood has no independent evidence; no correction action may run");
  }
}

const PERMIT_TTL_MS = 10 * 60 * 1000;

export interface SubmissionPermit {
  readonly caseId: string;
  readonly origin: string;
  readonly draftHash: string;
  readonly issuedAt: number;
}

const issued = new WeakSet<SubmissionPermit>();
const consumed = new WeakSet<SubmissionPermit>();

export interface PermitRequest {
  value: Case;
  /** The page holding the form that will be submitted. */
  formUrl: string;
  allowedOrigins: readonly string[];
  /** Hash of the draft the human approved; must equal the current draft. */
  approvedDraftHash: string | null;
}

export function issueSubmissionPermit(request: PermitRequest): SubmissionPermit {
  const { value, formUrl, allowedOrigins, approvedDraftHash } = request;
  if (value.approval.status !== "approved") {
    throw new SafetyError(`submission blocked: approval.status is "${value.approval.status}"`);
  }
  assertIndependentEvidence(value);
  if (!isControlledTarget(formUrl, allowedOrigins)) {
    throw new SafetyError(`submission blocked: ${formUrl} is not a controlled target`);
  }
  if (value.correction.route_type !== "form" || !value.correction.draft_ready) {
    throw new SafetyError("submission blocked: no ready form draft");
  }
  const currentHash = draftHash(value.correction.draft_fields);
  if (approvedDraftHash === null || approvedDraftHash !== currentHash) {
    throw new SafetyError("submission blocked: the draft changed after it was approved");
  }
  const permit: SubmissionPermit = Object.freeze({
    caseId: value.id,
    origin: new URL(formUrl).origin,
    draftHash: currentHash,
    issuedAt: Date.now(),
  });
  issued.add(permit);
  return permit;
}

/** Called by operators immediately before clicking submit. Single use. */
export function consumePermit(
  permit: SubmissionPermit,
  currentUrl: string,
  allowedOrigins: readonly string[],
): void {
  if (!issued.has(permit)) throw new SafetyError("submission blocked: permit was not issued by the safety gate");
  if (consumed.has(permit)) throw new SafetyError("submission blocked: permit already used");
  if (Date.now() - permit.issuedAt > PERMIT_TTL_MS) throw new SafetyError("submission blocked: permit expired");
  if (!isControlledTarget(currentUrl, allowedOrigins)) {
    throw new SafetyError(`submission blocked: current page ${currentUrl} is not a controlled target`);
  }
  if (new URL(currentUrl).origin !== permit.origin) {
    throw new SafetyError("submission blocked: current page origin differs from the permitted origin");
  }
  consumed.add(permit);
}
