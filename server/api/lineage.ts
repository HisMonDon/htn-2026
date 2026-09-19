import { createHash, randomUUID } from "node:crypto";
import type { AriadneExecution, AriadneRequest, AriadneResponse } from "../../shared/ariadne";
import { CORPUS } from "../../data/research-corpus";
import { createUpstreamSourceProposer, startProviderRun } from "../gptzero/composition";
import { claimTerms } from "../research/discovery";
import { assembleDocument, type CandidateDocument } from "../research/extract";
import { ingestSourceReference } from "../research/ingestion";
import { CorpusFetcher, CorpusSearch, DirectHttpFetcher, SearchSourceResolver } from "../research/providers";
import { traverseProvenance, type RecursiveProvenanceTraversal, type TraverseProvenanceDeps, type TraversalDiagnostic } from "../research/traversal";
import { HttpError } from "../service";
import { serializeTraversal } from "./lineage-response";

interface StoredRun {
  input: AriadneRequest;
  seed: CandidateDocument | null;
  traversal: RecursiveProvenanceTraversal;
  response: AriadneResponse;
  retryAt: number;
  busy: boolean;
}

function failedTraversal(diagnostic: TraversalDiagnostic, maxDepth: number): RecursiveProvenanceTraversal {
  return {
    documents: [], accepted_edges: [], rejected_edges: [], terminations: [], pending_jobs: [],
    diagnostics: [diagnostic], status: "failed", checkpoint: null,
    stats: { max_depth: maxDepth, sources_expanded: 0, proposals_received: 0, fetched: 0, fetch_failures: 0, analysis_requests: 0 },
  };
}

export function createLineageDeps(config: { useMocks: boolean; gptzeroApiKey: string | null }): TraverseProvenanceDeps {
  if (config.useMocks) return {
    proposer: { analyze: async (document) => document.outbound_links.map((x) => ({ url: x })) },
    fetcher: new CorpusFetcher(CORPUS), resolver: new SearchSourceResolver(new CorpusSearch(CORPUS)),
  };
  return { proposer: createUpstreamSourceProposer(config), fetcher: new DirectHttpFetcher() };
}

export function createLineageController(deps: TraverseProvenanceDeps, mode: "live" | "mock", now = () => new Date()) {
  const runs = new Map<string, StoredRun>();

  async function execute(input: AriadneRequest, id: string, previous?: StoredRun): Promise<AriadneResponse> {
    let seed = previous?.seed ?? null;
    const execution: AriadneExecution = previous ? structuredClone(previous.response.execution) : { proposer: mode, fallbacks: [] };
    const fabricated = input.fabricated_citations ?? [];
    const maxDepth = input.max_depth ?? 5;
    let traversal: RecursiveProvenanceTraversal | null = null;
    try {
      if (!seed) {
        if (input.seed_url || input.seed_source) {
          const acquired = await ingestSourceReference(input.seed_source ?? { url: input.seed_url }, deps, {
            fabricated, claimTerms: claimTerms(input.claim, fabricated), discoveredVia: "api-seed",
          });
          if (acquired.ok) seed = acquired.document;
          else traversal = failedTraversal({ stage: acquired.stage, source: input.seed_url ?? input.seed_source?.url ?? null, category: acquired.category, message: "", recoverable: acquired.recoverable }, maxDepth);
        } else {
          const text = input.seed_text ?? input.claim;
          seed = assembleDocument({
            url: `https://submitted.ariadne.invalid/${createHash("sha256").update(text).digest("hex")}`,
            title: "Submitted text", publisher: "User submission", text, outbound_links: [],
            timestamp: null, timestamp_source: "none", timestamp_confidence: "none", timestamp_conflict: null,
          }, { fabricated, claimTerms: claimTerms(input.claim, fabricated), discoveredVia: "submitted-text" });
        }
      }
      // One provider-request ledger per invocation, so a bibliography -> claim-endpoint fallback
      // counts both outbound GPTZero requests against the same budget traversal enforces.
      if (seed) startProviderRun(deps.proposer, input.max_provider_requests ?? 10);
      if (seed) traversal = await traverseProvenance({
        seed, claim: input.claim, fabricated, maxDepth, maxProviderRequests: input.max_provider_requests,
        checkpoint: previous?.traversal.checkpoint,
      }, {
        ...deps,
        proposer: {
          async analyze(document, continuation) {
            const analysis = await deps.proposer.analyze(document, continuation);
            if ("status" in analysis && analysis.status === "completed" && analysis.fallback) {
              execution.proposer = "cached_demo_fallback";
              const capturedAt = analysis.fallback.capturedAt;
              if (!execution.fallbacks.some((x) => x.source_id === document.id && x.captured_at === capturedAt)) {
                execution.fallbacks.push({ source_id: document.id, captured_at: capturedAt });
              }
            }
            return analysis;
          },
        },
      });
    } catch {
      const diagnostic: TraversalDiagnostic = { stage: "traversal", source: null, category: "stage-failed", message: "", recoverable: false };
      traversal = previous ? { ...previous.traversal, status: previous.traversal.accepted_edges.length ? "partial" : "failed", checkpoint: null, pending_jobs: [], diagnostics: [...previous.traversal.diagnostics, diagnostic] } : failedTraversal(diagnostic, maxDepth);
      if (!previous && seed) traversal.documents = [seed];
    }
    const response = serializeTraversal(traversal!, { id, input, seed, execution, generatedAt: now().toISOString() });
    runs.set(id, { input, seed, traversal: traversal!, response, retryAt: now().getTime() + Math.max(0, ...response.pending.map((x) => x.retry_after_ms ?? 0)), busy: false });
    if (runs.size > 100) runs.delete(runs.keys().next().value!);
    return response;
  }

  return {
    create: (input: AriadneRequest) => execute(input, randomUUID()),
    get(id: string): AriadneResponse {
      const run = runs.get(id);
      if (!run) throw new HttpError(404, "unknown or expired research result");
      return run.response;
    },
    async resume(id: string): Promise<AriadneResponse> {
      const run = runs.get(id);
      if (!run) throw new HttpError(404, "unknown or expired research result");
      if (run.busy) throw new HttpError(409, "this traversal is already running");
      if (!run.traversal.checkpoint) return run.response;
      if (now().getTime() < run.retryAt) throw new HttpError(429, "wait for the pending retry delay before resuming");
      run.busy = true;
      try {
        return await execute(run.input, id, run);
      } finally {
        run.busy = false;
      }
    },
  };
}

export type LineageController = ReturnType<typeof createLineageController>;
