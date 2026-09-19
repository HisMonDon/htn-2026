import type { AiEvidence, Case } from "../../shared/schema";
import { parseCase } from "../../shared/validate";

/**
 * Store a detector result on one chain node. This is the only place AI-writing evidence enters a
 * case, and it touches nothing else: not the falsehood, the correction, approval or the action log.
 */
export function attachAiEvidence(value: Case, nodeId: string, evidence: AiEvidence): Case {
  const next = structuredClone(value);
  const node = next.chain.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`unknown chain node "${nodeId}"`);
  node.ai_evidence = evidence;
  return parseCase(next);
}
