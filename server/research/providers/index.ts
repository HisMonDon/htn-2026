/**
 * Discovery-provider boundary: `SearchProvider` turns a query into candidate URLs, `PageFetcher`
 * fetches one. `discover()` (../discovery.ts) and `runResearch()` (../pipeline.ts) depend only on
 * these interfaces, never on a concrete provider.
 *
 * To add a replacement fallback resolver, create a sibling provider implementing `SourceResolver`
 * (or adapt a `SearchProvider` with `SearchSourceResolver`) and point ../factory.ts at it. No
 * extraction, canonicalization, or graph code needs to change.
 */
export type {
  AuditMetadata,
  FetchFailure,
  FetchFailureCategory,
  FetchResult,
  FetchedPage,
  PageFetcher,
  SearchHit,
  SearchProvider,
  SourceReference,
  SourceResolver,
} from "./types";
export { readAuditMetadata, toAuditMetadata } from "./types";
export { CorpusSearch, CorpusFetcher } from "./corpus";
export { DirectHttpFetcher, type DirectHttpFetcherOptions } from "./http";
export {
  fetchSource,
  fetchSourceDetailed,
  SearchSourceResolver,
  sourceLookupQuery,
  type FetchSourceOptions,
  type FetchSourceResult,
  type FetchedSource,
  type SourceFetchFailure,
} from "./resolver";
