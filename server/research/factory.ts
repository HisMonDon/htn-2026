import { CORPUS } from "../../data/research-corpus";
import type { Config } from "../config";
import type { AiWritingDetector } from "../gptzero/client";
import { createCandidateIndex } from "./candidate-index";
import type { ResearchDeps } from "./pipeline";
import { browserbaseProviders, CorpusFetcher, CorpusSearch, type PageFetcher, type SearchProvider } from "./providers";

/**
 * Picks the discovery provider pair. USE_MOCKS=true always wins (offline corpus, deterministic,
 * used by the research regression tests). Otherwise Browserbase Search and Fetch, today's only live
 * provider.
 *
 * To add a replacement live provider: implement `SearchProvider`/`PageFetcher` in a new file under
 * ./providers/ (see providers/browserbase.ts for the shape), then add a branch here selecting it —
 * nothing else in the pipeline needs to change.
 */
function selectSearchProviders(config: Config): { search: SearchProvider; fetcher: PageFetcher } {
  if (config.useMocks) {
    return { search: new CorpusSearch(CORPUS), fetcher: new CorpusFetcher(CORPUS) };
  }
  if (config.browserbaseApiKey) {
    return browserbaseProviders(config.browserbaseApiKey);
  }
  const missing = async (): Promise<never> => {
    throw new Error("BROWSERBASE_API_KEY is not set. Set it, or set USE_MOCKS=true to research the offline corpus.");
  };
  return { search: { kind: "browserbase", search: missing }, fetcher: { fetch: missing } };
}

/** Retrieval uses Elastic whenever it is configured (in either discovery mode), else in-memory BM25. */
export function createResearchDeps(config: Config, detector?: AiWritingDetector): ResearchDeps {
  const { search, fetcher } = selectSearchProviders(config);
  return { search, fetcher, index: createCandidateIndex(config.elastic), detector };
}
