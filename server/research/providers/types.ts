export interface SearchHit {
  url: string;
  title: string;
  published: string | null;
}

/**
 * The discovery-provider boundary. Anything that can turn a query into candidate URLs
 * (Browserbase Search, the offline corpus, or a future replacement) implements this — `discover()`
 * and the rest of the pipeline never depend on a concrete provider.
 */
export interface SearchProvider {
  readonly kind: "browserbase" | "offline-corpus";
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/**
 * A fetched page, dispatched by content type: HTML goes to the existing extractor, PDFs go through
 * deterministic parsing (step 6). `url` is the final (post-redirect) URL.
 */
export type FetchedPage = { url: string; kind: "html"; html: string } | { url: string; kind: "pdf"; bytes: Uint8Array };

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage | null>;
}
