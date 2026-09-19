import { CORPUS } from "../../data/research-corpus";
import type { Config } from "../config";
import type { AiWritingDetector } from "../gptzero/client";
import { createCandidateIndex } from "./candidate-index";
import type { ResearchDeps } from "./pipeline";
import { browserbaseProviders, CorpusFetcher, CorpusSearch, type PageFetcher, type SearchProvider } from "./providers";

/**
 * USE_MOCKS=true: discovery runs over the offline corpus. Otherwise Browserbase Search and Fetch.
 * Retrieval uses Elastic whenever it is configured (in either mode), else in-memory BM25.
 */
export function createResearchDeps(config: Config, detector?: AiWritingDetector): ResearchDeps {
  let search: SearchProvider;
  let fetcher: PageFetcher;
  if (config.useMocks) {
    search = new CorpusSearch(CORPUS);
    fetcher = new CorpusFetcher(CORPUS);
  } else if (config.browserbaseApiKey) {
    ({ search, fetcher } = browserbaseProviders(config.browserbaseApiKey));
  } else {
    const missing = async (): Promise<never> => {
      throw new Error("BROWSERBASE_API_KEY is not set. Set it, or set USE_MOCKS=true to research the offline corpus.");
    };
    search = { kind: "browserbase", search: missing };
    fetcher = { fetch: missing };
  }
  return { search, fetcher, index: createCandidateIndex(config.elastic), detector };
}
