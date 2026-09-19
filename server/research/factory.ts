import { CORPUS } from "../../data/research-corpus";
import type { Config } from "../config";
import type { AiWritingDetector } from "../gptzero/client";
import { createCandidateIndex } from "./candidate-index";
import type { ResearchDeps } from "./pipeline";
import {
  CorpusFetcher,
  CorpusSearch,
  DirectHttpFetcher,
  SearchSourceResolver,
  type PageFetcher,
  type SearchProvider,
  type SourceResolver,
} from "./providers";

/**
 * Picks the source-resolution providers. USE_MOCKS=true always wins (offline corpus,
 * deterministic, used by the research regression tests). Live evidence is always fetched directly
 * over HTTP. A production resolver is injected separately when one is available.
 *
 * To add a replacement fallback resolver: implement `SourceResolver` (or adapt a search provider)
 * in ./providers/, then add a branch here. The direct fetch and evidence pipeline remain unchanged.
 */
function selectSearchProviders(config: Config): { search: SearchProvider; fetcher: PageFetcher; resolver?: SourceResolver } {
  if (config.useMocks) {
    const search = new CorpusSearch(CORPUS);
    return { search, fetcher: new CorpusFetcher(CORPUS), resolver: new SearchSourceResolver(search) };
  }
  const fetcher = new DirectHttpFetcher();
  const missing = async (): Promise<never> => {
    throw new Error("No fallback source resolver is configured. Provide a direct source URL or inject a SourceResolver.");
  };
  return { search: { kind: "unconfigured", search: missing }, fetcher };
}

/** Retrieval uses Elastic whenever it is configured (in either discovery mode), else in-memory BM25. */
export function createResearchDeps(config: Config, detector?: AiWritingDetector): ResearchDeps {
  const { search, fetcher, resolver } = selectSearchProviders(config);
  return { search, fetcher, resolver, index: createCandidateIndex(config.elastic), detector };
}
