import { randomUUID } from "node:crypto";
import type { AiEvidence } from "../../shared/schema";
import { LineageTree } from "../../shared/tree";
import type { AiWritingDetector } from "../gptzero/client";
import type { CandidateIndex } from "./candidate-index";
import { discover, type DiscoveryOptions } from "./discovery";
import type { PageFetcher, SearchProvider } from "./providers";
import { buildTree } from "./tree";

export interface ResearchInput {
  claim: string;
  seed_url?: string | null;
  fabricated_citations?: string[];
  /** Run the AI-writing detector on each lineage node. Never affects edges. */
  include_ai_evidence?: boolean;
}

export interface ResearchDeps {
  search: SearchProvider;
  fetcher: PageFetcher;
  index: CandidateIndex;
  detector?: AiWritingDetector;
  discovery?: DiscoveryOptions;
  now?: () => Date;
}

/** Claim in, reconstructed tree out: discover -> extract -> index/retrieve -> score -> assemble. */
export async function runResearch(input: ResearchInput, deps: ResearchDeps): Promise<LineageTree> {
  const discovered = await discover(
    { claim: input.claim, seedUrl: input.seed_url ?? null, fabricated: input.fabricated_citations },
    { search: deps.search, fetcher: deps.fetcher },
    deps.discovery,
  );
  if (discovered.fabricated.length === 0) {
    throw new Error("no fabricated citations could be identified from the claim or seed; pass fabricated_citations");
  }

  let aiEvidence: Map<string, AiEvidence> | undefined;
  if (input.include_ai_evidence && deps.detector) {
    aiEvidence = new Map();
    for (const doc of discovered.documents) {
      try {
        aiEvidence.set(doc.id, await deps.detector.detect(doc.text || doc.passage));
      } catch {
        // AI-writing evidence is optional; a detector failure never blocks the tree.
      }
    }
  }

  const tree = await buildTree({
    runId: randomUUID(),
    claim: input.claim,
    seedUrl: input.seed_url ?? null,
    seedId: discovered.seedId,
    fabricated: discovered.fabricated,
    documents: discovered.documents,
    index: deps.index,
    aiEvidence,
    stats: { discovery: deps.search.kind, queries: discovered.queries, failed_queries: discovered.failedQueries, fetched: discovered.fetched },
    now: deps.now,
  });
  return LineageTree.parse(tree);
}
