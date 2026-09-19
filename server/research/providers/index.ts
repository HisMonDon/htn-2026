/**
 * Discovery-provider boundary: `SearchProvider` turns a query into candidate URLs, `PageFetcher`
 * fetches one. `discover()` (../discovery.ts) and `runResearch()` (../pipeline.ts) depend only on
 * these interfaces, never on a concrete provider.
 *
 * To add a replacement search provider: create a sibling file implementing both interfaces (see
 * browserbase.ts for the shape), then point ../factory.ts at it. No other file in the pipeline needs
 * to change.
 */
export type { FetchedPage, PageFetcher, SearchHit, SearchProvider } from "./types";
export { BrowserbaseSearch, BrowserbaseFetcher, browserbaseProviders } from "./browserbase";
export { CorpusSearch, CorpusFetcher } from "./corpus";
