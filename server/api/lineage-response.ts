import { createHash } from "node:crypto";
import { AriadneResponse, type AriadneDiagnostic, type AriadneEdge, type AriadneExecution, type AriadneNode, type AriadneRequest } from "../../shared/ariadne";
import { validateProvenanceEdge } from "../provenance/validator";
import { computeTimings } from "../research/edges";
import type { CandidateDocument } from "../research/extract";
import type { RecursiveProvenanceTraversal, TraversalDiagnostic } from "../research/traversal";

const diagnosticMessages: Record<string, string> = {
  "provider-failure": "Upstream proposal analysis failed.",
  "cached_demo_fallback": "A cached demo bibliography scan was used; see execution.fallbacks for its capture time.",
  "invalid-url": "The source URL could not be used.",
  "http-401": "The source could not be accessed.",
  "http-403": "The source could not be accessed.",
  "http-404": "The source was not found.",
  "http-429": "The source rate limited acquisition.",
  "http-5xx": "The source server returned an error.",
  "http-error": "The source returned an unsuccessful HTTP response.",
  "timeout": "The source request timed out.",
  "network-error": "The source network request failed.",
  "redirect-error": "The source redirect could not be followed.",
  "response-read-failed": "The source response could not be read.",
  "unsupported-content": "The source document format is unsupported.",
  "missing-source-reference": "A usable source URL or configured bibliographic resolver is required.",
  "resolver-failed": "The source reference could not be resolved.",
  "empty-document": "The source contained no extractable text.",
  "error-document": "The source appears to be an error or bot-block page.",
  "parse-failed": "The source document could not be parsed.",
  "pdf-too-large": "The PDF exceeds the extraction size limit.",
  "pdf-invalid": "The source is not a valid PDF.",
  "pdf-no-extractable-text": "The PDF contains no extractable text.",
  "pdf-parse-failed": "The PDF could not be parsed.",
};

export function diagnosticUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value!);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function publicDiagnostic(x: TraversalDiagnostic): AriadneDiagnostic {
  const known = Object.hasOwn(diagnosticMessages, x.category);
  return {
    stage: x.stage,
    source: diagnosticUrl(x.source),
    category: known ? x.category : "stage-failed",
    message: known ? diagnosticMessages[x.category]! : `The ${x.stage} stage could not finish.`,
    recoverable: x.recoverable,
  };
}

function edgeId(source: string | null, target: string, state: string, index = 0): string {
  return createHash("sha256").update(JSON.stringify([source, target, state, index])).digest("hex").slice(0, 24);
}

export function compatibilityTree(
  response: Omit<AriadneResponse, "tree">,
  input: AriadneRequest,
  stats: RecursiveProvenanceTraversal["stats"],
  generatedAt: string,
): AriadneResponse["tree"] {
  const accepted = response.edges.filter((x) => x.status === "validated");
  const childIds = new Set(accepted.map((x) => x.target));
  const members = new Set([response.root.id, ...accepted.flatMap((x) => [x.source, x.target])]);
  const nodes = response.nodes.filter((x) => members.has(x.id));
  return {
    seed: { claim: input.claim, url: response.root.url, fabricated_citations: input.fabricated_citations ?? [] },
    generated_at: generatedAt,
    root_ids: nodes.filter((x) => !childIds.has(x.id)).map((x) => x.id),
    nodes,
    edges: accepted.map((x) => ({
      parent_id: x.source, child_id: x.target, type: x.type, confidence: x.ariadne_score,
      ...x.evidence, claim_mutations: x.claim_mutations, alternatives: [],
    })),
    rejected_edges: response.edges.filter((x) => x.status === "rejected").filter((x) => x.source !== null && x.ariadne_score !== null).map((x) => ({
      parent_id: x.source!, child_id: x.target, confidence: x.ariadne_score!, reason: x.reason,
    })),
    excluded: response.nodes.filter((x) => !members.has(x.id)).map((x) => ({ id: x.id, url: x.url, reason: "No validated edge connects this source to the seed." })),
    status: response.status,
    diagnostics: [...response.warnings, ...response.errors],
    stats: { pipeline: "recursive-provenance", ...stats },
  };
}

export interface SerializationContext {
  id: string;
  input: AriadneRequest;
  seed: CandidateDocument | null;
  execution: AriadneExecution;
  generatedAt: string;
}

export function serializeTraversal(result: RecursiveProvenanceTraversal, context: SerializationContext): AriadneResponse {
  const { input, seed, id, generatedAt } = context;
  const status = result.status === "paused" ? "partial" : result.status;
  const diagnostics = result.diagnostics.map(publicDiagnostic);
  const warnings = status === "failed" ? [] : diagnostics;
  const errors = status === "failed" ? diagnostics : [];
  const timings = computeTimings(result.documents);
  const nodes: AriadneNode[] = result.documents.map((x) => {
    const timing = timings.get(x.id)!;
    return {
      id: x.id, canonical_id: x.canonical_id, content_fingerprint: x.content_fingerprint,
      url: x.url, mirror_urls: x.mirror_urls, publisher: x.publisher, title: x.title,
      timestamp: x.timestamp, timestamp_source: x.timestamp_source, timestamp_confidence: x.timestamp_confidence,
      earliest_possible: timing.effective === null ? null : new Date(timing.effective).toISOString(),
      timestamp_conflict: x.timestamp_conflict ?? timing.conflict, passage: x.passage,
      outbound_links: x.outbound_links, fabricated_citations: x.fabricated_citations, mutations: x.citation_variants,
      ai_evidence: null, discovered_via: x.discovered_via, is_seed: x.content_fingerprint === seed?.content_fingerprint,
      source_kind: x.discovered_via.includes("submitted-text") ? "submitted" : "fetched",
    };
  });
  const byId = new Map(result.documents.map((x) => [x.id, x]));
  const edges: AriadneEdge[] = result.accepted_edges.map((x) => {
    let inspection: Extract<AriadneEdge, { status: "validated" }>["inspection"] = null;
    try {
      const inspected = validateProvenanceEdge({
        parent: byId.get(x.parent_id)!, child: byId.get(x.child_id)!, corpus: result.documents,
        now: () => new Date(generatedAt),
      });
      inspection = { validator: inspected.validator, role: "supplementary-inspection", signals: inspected.signals, evidence: inspected.evidence };
    } catch {
      warnings.push({ stage: "validation", source: null, category: "inspection-unavailable", message: "Supplementary edge inspection is unavailable; traversal evidence is retained.", recoverable: false });
    }
    return {
      id: edgeId(x.parent_id, x.child_id, "validated"), source: x.parent_id, target: x.child_id,
      reference_url: byId.get(x.parent_id)?.url ?? null, status: "validated", ariadne_score: x.confidence,
      score_method: "traversal-scoreEdge", type: x.type,
      evidence: { basis: x.basis, explicit_link: x.explicit_link, shared_mutations: x.shared_mutations, rare_shared_phrases: x.rare_shared_phrases, similarity: x.similarity, temporal: x.temporal },
      inspection, claim_mutations: x.claim_mutations, recursed: x.recursed,
    };
  });
  for (const [index, x] of result.rejected_edges.entries()) {
    const source = x.parent_id && byId.has(x.parent_id) ? x.parent_id : result.documents.find((document) => document.url === x.parent_url || document.mirror_urls.includes(x.parent_url))?.id ?? null;
    edges.push({
      id: edgeId(x.parent_url, x.child_id, "rejected", index), source, target: x.child_id,
      reference_url: diagnosticUrl(x.parent_url), status: "rejected", ariadne_score: x.confidence,
      score_method: "traversal-scoreEdge", termination: x.termination,
      reason: x.termination === "fetch-failure" ? publicDiagnostic({ stage: x.stage ?? "fetch", source: null, category: x.category ?? "network-error", message: "", recoverable: x.recoverable ?? false }).message : x.reason,
    });
  }
  if (result.status === "paused") warnings.push({ stage: "traversal", source: null, category: "traversal-paused", message: "Traversal is waiting for provider work or its request budget; resume this result after the indicated delay.", recoverable: true });
  if (input.include_ai_evidence) warnings.push({ stage: "gptzero", source: null, category: "ai-writing-check-not-run", message: "This endpoint performs bibliography proposals; include_ai_evidence is deprecated and no AI-writing check was run.", recoverable: false });
  const root = nodes.find((x) => x.is_seed);
  const response: Omit<AriadneResponse, "tree"> = {
    id, status,
    root: {
      id: root?.id ?? `unavailable-${id}`, url: root?.source_kind === "submitted" ? null : root?.url ?? diagnosticUrl(input.seed_url ?? input.seed_source?.url),
      title: root?.title ?? input.seed_source?.title ?? null, date: root?.timestamp ?? null, text: seed?.text ?? input.seed_text ?? null,
    },
    nodes, edges,
    terminations: result.terminations.map((x) => ({ ...x, url: diagnosticUrl(x.url) ?? "", detail: x.reason === "provider-failure" ? "Upstream proposal analysis failed." : null })),
    warnings, errors, execution: context.execution,
    pending: result.pending_jobs.map((x) => ({ source_id: x.source_id, reason: x.reason, retry_after_ms: x.retry_after_ms })),
    resume_url: result.checkpoint ? `/api/research/${id}/resume` : null,
  };
  return AriadneResponse.parse({ ...response, tree: compatibilityTree(response, input, result.stats, generatedAt) });
}
