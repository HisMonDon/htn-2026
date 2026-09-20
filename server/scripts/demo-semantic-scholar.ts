/**
 * Small live Academic Graph verification. It deliberately uses only six first-hop citation edges
 * from one stable DOI, so it demonstrates both directions without broad crawling.
 *
 *   npm run demo:academic
 *   SEMANTIC_SCHOLAR_API_KEY=... npm run demo:academic
 */
import { loadConfig } from "../config";
import { assembleDocument } from "../research/extract";
import { SemanticScholarProposer, SemanticScholarProvider, type SemanticScholarDebugEvent } from "../research/providers";
import { traverseProvenance } from "../research/traversal";

const DOI = "10.18653/v1/N18-3011";
const config = loadConfig();
const debug: SemanticScholarDebugEvent[] = [];
const proposer = new SemanticScholarProposer(
  new SemanticScholarProvider({ apiKey: config.semanticScholar.apiKey, timeoutMs: config.semanticScholar.timeoutMs }),
  {
    maxReferences: Math.min(3, config.semanticScholar.maxReferences),
    maxCitations: Math.min(3, config.semanticScholar.maxCitations),
    onDebug: (event) => debug.push(event),
  },
);
const seed = assembleDocument({
  url: `https://doi.org/${DOI}`,
  title: "Known academic paper",
  publisher: "DOI record",
  timestamp: null,
  timestamp_source: "none",
  timestamp_confidence: "none",
  timestamp_conflict: null,
  text: "",
  outbound_links: [],
  academic_metadata: { doi: DOI, title: "Known academic paper" },
}, { fabricated: [], claimTerms: [], discoveredVia: "semantic-scholar-live-demo" });

const started = Date.now();
const result = await traverseProvenance(
  { seed, claim: "Academic citation graph verification", fabricated: [], maxDepth: 1, maxEdges: 6, maxExpandedNodes: 7, maxProviderRequests: 7 },
  { proposer, fetcher: { fetch: async () => null } },
);
const first = debug.find((event) => event.resolved_paper_id !== null) ?? null;
const incoming = new Map<string, number>();
for (const edge of result.citation_edges) incoming.set(edge.target_id, (incoming.get(edge.target_id) ?? 0) + 1);
const crosslinks = [...incoming.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
console.log(JSON.stringify({
  resolved_paper_id: first?.resolved_paper_id ?? null,
  resolved_by: first?.resolved_by ?? null,
  reference_count: first?.references ?? 0,
  citation_count: first?.citations ?? 0,
  nodes_created: result.documents.length,
  citation_edges_created: result.citation_edges.length,
  max_depth: Math.max(0, ...result.terminations.map((entry) => entry.depth)),
  crosslinks,
  runtime_ms: Date.now() - started,
  status: result.status,
  provider_failure: result.terminations.find((entry) => entry.reason === "provider-failure")?.detail ?? null,
}, null, 2));
