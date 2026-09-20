/**
 * Run the actual recursive provenance pipeline (GPTZero proposal -> resolution/acquisition ->
 * independent deterministic validation -> recursive traversal -> DAG -> mutation analysis) against
 * the Cohen/Bard hallucinated-citation claim.
 *
 *   npm run demo:cohen                 offline: corpus fetch/resolve, link-following proposer
 *   USE_MOCKS=false npm run demo:cohen live: GPTZero bibliography scan + direct HTTP fetch
 *
 * Nothing here decides that an edge exists. Acceptance is exactly `traverseProvenance`'s ordinary
 * ingest -> canonicalize -> cycle/duplicate check -> deterministic `scoreEdge` path.
 */
import { CORPUS } from "../../data/research-corpus";
import { loadConfig } from "../config";
import { createBibliographyProposer } from "../gptzero/bibliography";
import { extractDocument, type CandidateDocument } from "../research/extract";
import { CorpusFetcher, CorpusSearch, DirectHttpFetcher, SearchSourceResolver, type PageFetcher, type SourceResolver } from "../research/providers";
import { traverseProvenance, type RecursiveProvenanceTraversal, type UpstreamAnalysis, type UpstreamSourceProposer } from "../research/traversal";

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM =
  "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, " +
  "three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.";
/** A coverage article carrying the same fabricated citations, with a real outbound-link chain back toward the motion. */
const SEED_URL = "https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases";

/**
 * Deterministic offline stand-in for a bibliography scan, used only when GPTZero itself
 * (`server/gptzero/bibliography.ts`) is mocked out and would otherwise propose nothing offline: it
 * proposes a document's own outbound links as candidate upstream sources. It is a proposer only --
 * every proposal still passes through `traverseProvenance`'s ordinary fetch, canonicalization,
 * cycle/duplicate checks and deterministic `scoreEdge` before it can become an accepted edge.
 */
class OutboundLinkProposer implements UpstreamSourceProposer {
  async analyze(document: CandidateDocument): Promise<UpstreamAnalysis> {
    return document.outbound_links.map((url) => ({ url }));
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

const config = loadConfig();
const useMocks = config.useMocks || process.argv.includes("--mock");

const seedPage = CORPUS.find((page) => page.url === SEED_URL);
if (!seedPage) throw new Error(`seed page ${SEED_URL} not found in offline corpus`);
const seed = extractDocument({
  url: seedPage.url,
  html: seedPage.html,
  fabricated: FABRICATED,
  claimTerms: [],
  discoveredVia: "cohen-demo-seed",
});

const search = new CorpusSearch(CORPUS);
const fetcher: PageFetcher = useMocks ? new CorpusFetcher(CORPUS) : new DirectHttpFetcher();
const resolver: SourceResolver = new SearchSourceResolver(search);
const proposer: UpstreamSourceProposer = useMocks ? new OutboundLinkProposer() : createBibliographyProposer(config);

console.log(`mode: ${useMocks ? "offline (corpus fetch/resolve, link-following proposer)" : "live (GPTZero bibliography scan, direct HTTP fetch)"}`);
console.log(`provenance mode: ${config.provenanceMode}`);
console.log(`seed: ${seed.url}`);
console.log(`claim: ${CLAIM}\n`);

const result = await traverseProvenance(
  { seed, claim: CLAIM, fabricated: FABRICATED, provenanceMode: config.provenanceMode },
  { proposer, fetcher, resolver },
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printResult(result);
}
