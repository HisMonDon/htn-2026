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
  /** Identifies the configured provider for run diagnostics only. */
  readonly kind: string;
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

/**
 * A source proposed by an upstream system. URLs are preferred, but a resolver can use the
 * remaining bibliographic fields when the proposal is incomplete or the URL is dead.
 */
export interface SourceReference {
  url?: string | null;
  title?: string | null;
  citation?: string | null;
  author?: string | null;
}

/**
 * Optional fallback for incomplete source proposals. It deliberately has no dependency on a
 * particular search API or credentials; implementations may use a search API, a catalogue, or a
 * local index.
 */
export interface SourceResolver {
  readonly kind: string;
  resolve(source: SourceReference): Promise<string | null>;
}
