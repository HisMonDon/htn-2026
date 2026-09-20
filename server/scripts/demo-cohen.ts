/**
 * Run the actual recursive provenance pipeline (GPTZero proposal -> resolution/acquisition ->
 * independent deterministic validation -> recursive traversal -> DAG -> mutation analysis) against
 * the Cohen/Bard hallucinated-citation claim.
 *
 *   npm run demo:cohen                        offline: corpus fetch/resolve, bounded case-name discovery, config's mode
 *   npm run demo:cohen -- --mode=deep         override the traversal mode for this run
 *   npm run demo:cohen -- --compare           run strict/exploratory/deep back-to-back and summarize
 *   USE_MOCKS=false npm run demo:cohen        live: GPTZero bibliography scan + direct HTTP fetch
 *
 * Nothing here decides that an edge exists. Acceptance is exactly `traverseProvenance`'s ordinary
 * ingest -> canonicalize -> cycle/duplicate check -> deterministic `scoreEdge` path.
 */
import { CORPUS } from "../../data/research-corpus";
import { loadConfig } from "../config";
import { createBibliographyProposer } from "../gptzero/bibliography";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { CorpusFetcher, CorpusSearch, DirectHttpFetcher, SearchSourceResolver, type PageFetcher, type SourceResolver } from "../research/providers";
import {
  traverseProvenance,
  type ProvenanceMode,
  type RecursiveProvenanceTraversal,
  type UpstreamAnalysis,
  type UpstreamSourceProposer,
} from "../research/traversal";

const MODES: ProvenanceMode[] = ["strict", "exploratory", "deep"];

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM =
  "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, " +
  "three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.";
/** A coverage article carrying the same fabricated citations, with a real outbound-link chain back toward the motion. */
const SEED_URL = "https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases";

/**
 * Deterministic offline stand-in for the combined bibliography/search discovery channels. It uses
 * extracted case names when present (or the title/passage as a fallback) to retrieve a small,
 * bounded corpus candidate pool and includes direct outbound links. It does not know the Cohen
 * URLs or decide that an edge exists: every proposal still passes through ordinary acquisition,
 * canonicalization, cycle/duplicate checks, and deterministic `scoreEdge`.
 */
class OfflineInvestigationProposer implements UpstreamSourceProposer {
  constructor(
    private readonly search: CorpusSearch,
    private readonly maxCandidates: number,
  ) {}

  async analyze(document: CandidateDocument): Promise<UpstreamAnalysis> {
    const query = document.case_names.length
      ? document.case_names.slice(0, 4).join(" ")
      : `${document.title} ${document.passage}`.trim();
    const hits = query ? await this.search.search(query, this.maxCandidates) : [];
    const proposals = [
      ...document.outbound_links.map((url) => ({ url })),
      ...hits.map((hit) => ({ url: hit.url, title: hit.title })),
    ];
    return [...new Map(proposals.map((proposal) => [proposal.url, proposal])).values()];
  }
}

function printResult(result: RecursiveProvenanceTraversal): void {
  const byId = new Map(result.documents.map((document) => [document.id, document]));
  console.log(`status: ${result.status}`);
  console.log(
    `stats: sources_expanded=${result.stats.sources_expanded} proposals_received=${result.stats.proposals_received} ` +
      `fetched=${result.stats.fetched} fetch_failures=${result.stats.fetch_failures} analysis_requests=${result.stats.analysis_requests}`,
  );

  console.log("\naccepted edges:");
  if (result.accepted_edges.length === 0) console.log("  (none)");
  for (const edge of result.accepted_edges) {
    const parent = byId.get(edge.parent_id);
    const child = byId.get(edge.child_id);
    console.log(`  ${parent?.url} -> ${child?.url}  [${edge.provenance_status}, ${edge.type}, confidence ${edge.confidence}]`);
    console.log(`    basis: ${edge.basis}`);
    if (edge.shared_mutations.length) console.log(`    shared fabrications: ${edge.shared_mutations.join(", ")}`);
    console.log(`    temporal: ${edge.temporal.parent_time ?? "unknown"} -> ${edge.temporal.child_time ?? "unknown"} (${edge.temporal.ordering})`);
    for (const mutation of edge.claim_mutations) console.log(`    mutation [${mutation.type}]: ${mutation.summary}`);
  }

  console.log("\nrejected proposals:");
  if (result.rejected_edges.length === 0) console.log("  (none)");
  for (const rejected of result.rejected_edges) {
    console.log(`  ${rejected.parent_url} -/-> ${byId.get(rejected.child_id)?.url ?? rejected.child_id}  [${rejected.termination}]`);
    console.log(`    ${rejected.reason}`);
  }

  console.log("\nsource terminations:");
  for (const termination of result.terminations) {
    console.log(`  ${termination.url} (depth ${termination.depth}): ${termination.reason}${termination.detail ? ` - ${termination.detail}` : ""}`);
  }

  if (result.pending_jobs.length) {
    console.log("\npending jobs (rerun with --checkpoint to resume):");
    for (const job of result.pending_jobs) console.log(`  ${job.url}: ${job.reason}, retry after ${job.retry_after_ms}ms`);
  }
}

interface ModeSummary {
  mode: ProvenanceMode;
  nodes: number;
  edges: number;
  validated: number;
  probable: number;
  related: number;
  max_depth_reached: number;
  nodes_with_multiple_incoming_edges: number;
  crosslinks: number;
  multiple_branches: boolean;
  multiple_depths: boolean;
  crosslinks_between_branches: boolean;
  unique_documents_expanded: number;
  runtime_ms: number;
}

function summarize(mode: ProvenanceMode, result: RecursiveProvenanceTraversal, runtimeMs: number): ModeSummary {
  // `accepted_edges` retain provenance orientation (proposed parent -> current child). For the
  // investigation graph, discovery runs the other way, so a document with several discovery
  // parents is a true crosslink even though it was fetched and expanded only once.
  const incomingByDiscovery = new Map<string, number>();
  const discoveredBySource = new Map<string, number>();
  for (const edge of result.accepted_edges) {
    incomingByDiscovery.set(edge.parent_id, (incomingByDiscovery.get(edge.parent_id) ?? 0) + 1);
    discoveredBySource.set(edge.child_id, (discoveredBySource.get(edge.child_id) ?? 0) + 1);
  }
  const multiIncoming = [...incomingByDiscovery.values()].filter((count) => count > 1);
  const depths = new Set(result.terminations.map((entry) => entry.depth));
  return {
    mode,
    nodes: result.documents.length,
    edges: result.accepted_edges.length,
    validated: result.accepted_edges.filter((x) => x.provenance_status === "validated").length,
    probable: result.accepted_edges.filter((x) => x.provenance_status === "probable").length,
    related: result.accepted_edges.filter((x) => x.provenance_status === "related").length,
    max_depth_reached: result.terminations.reduce((max, x) => Math.max(max, x.depth), 0),
    nodes_with_multiple_incoming_edges: multiIncoming.length,
    crosslinks: multiIncoming.reduce((total, count) => total + count - 1, 0),
    multiple_branches: [...discoveredBySource.values()].some((count) => count > 1),
    multiple_depths: depths.size > 1,
    crosslinks_between_branches: multiIncoming.length > 0,
    unique_documents_expanded: result.stats.sources_expanded,
    runtime_ms: runtimeMs,
  };
}

function printSummaryTable(summaries: ModeSummary[]): void {
  console.log(
    "mode        nodes edges validated probable related max_depth crosslinks expanded runtime_ms",
  );
  for (const s of summaries) {
    console.log(
      `${s.mode.padEnd(11)} ${String(s.nodes).padStart(5)} ${String(s.edges).padStart(5)} ` +
        `${String(s.validated).padStart(9)} ${String(s.probable).padStart(8)} ${String(s.related).padStart(7)} ` +
        `${String(s.max_depth_reached).padStart(9)} ${String(s.crosslinks).padStart(10)} ` +
        `${String(s.unique_documents_expanded).padStart(8)} ${String(s.runtime_ms).padStart(10)}`,
    );
    if (s.mode === "deep") {
      console.log(
        `  deep structure: multiple_branches=${s.multiple_branches} multiple_depths=${s.multiple_depths} ` +
          `nodes_with_multiple_incoming_edges=${s.nodes_with_multiple_incoming_edges} crosslinks_between_branches=${s.crosslinks_between_branches}`,
      );
    }
  }
}

function buildSeed(): CandidateDocument {
  const seedPage = CORPUS.find((page) => page.url === SEED_URL);
  if (!seedPage) throw new Error(`seed page ${SEED_URL} not found in offline corpus`);
  return extractDocument({
    url: seedPage.url,
    html: seedPage.html,
    fabricated: FABRICATED,
    claimTerms: [],
    discoveredVia: "cohen-demo-seed",
  });
}

async function runMode(mode: ProvenanceMode, useMocks: boolean): Promise<{ result: RecursiveProvenanceTraversal; runtimeMs: number }> {
  const config = loadConfig();
  const seed = buildSeed();
  const search = new CorpusSearch(CORPUS);
  const fetcher: PageFetcher = useMocks ? new CorpusFetcher(CORPUS) : new DirectHttpFetcher();
  const resolver: SourceResolver = new SearchSourceResolver(search);
  const proposer: UpstreamSourceProposer = useMocks
    ? new OfflineInvestigationProposer(search, mode === "deep" ? config.webSearch.maxCandidatesDeep : config.webSearch.maxCandidates)
    : createBibliographyProposer(config);
  const start = Date.now();
  const result = await traverseProvenance(
    {
      seed,
      claim: CLAIM,
      fabricated: FABRICATED,
      provenanceMode: mode,
      maxDepth: config.graphLimits.maxDepth,
      maxExpandedNodes: config.graphLimits.maxExpandedNodes,
      maxEdges: config.graphLimits.maxEdges,
      maxChildrenPerNode: config.graphLimits.maxChildrenPerNode,
      maxRelatedChildrenPerNode: config.graphLimits.maxRelatedChildrenPerNode,
      maxProbableChildrenPerNode: config.graphLimits.maxProbableChildrenPerNode,
    },
    { proposer, fetcher, resolver },
  );
  return { result, runtimeMs: Date.now() - start };
}

const config = loadConfig();
const useMocks = config.useMocks || process.argv.includes("--mock");
const asJson = process.argv.includes("--json");
const compare = process.argv.includes("--compare");
const modeFlag = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1];

console.log(`mode: ${useMocks ? "offline (corpus fetch/resolve, bounded investigation proposer)" : "live (GPTZero bibliography scan, direct HTTP fetch)"}`);
console.log(`claim: ${CLAIM}\n`);

if (compare) {
  const summaries: ModeSummary[] = [];
  for (const mode of MODES) {
    const { result, runtimeMs } = await runMode(mode, useMocks);
    summaries.push(summarize(mode, result, runtimeMs));
  }
  if (asJson) console.log(JSON.stringify(summaries, null, 2));
  else printSummaryTable(summaries);
} else {
  const mode: ProvenanceMode = modeFlag === "deep" || modeFlag === "exploratory" || modeFlag === "strict" ? modeFlag : config.provenanceMode;
  console.log(`provenance mode: ${mode}`);
  const { result } = await runMode(mode, useMocks);
  console.log(`seed: ${SEED_URL}\n`);
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
}
