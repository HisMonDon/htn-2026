import type { FetchedPage, PageFetcher, SearchProvider, SourceReference, SourceResolver } from "./types";

function usableHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Build a narrow bibliographic lookup rather than using discovery queries as a first choice. */
export function sourceLookupQuery(source: SourceReference): string | null {
  const authorTitle = [source.author, source.title]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (authorTitle.length) return [...new Set(authorTitle)].join(" ");
  if (source.citation?.trim()) return source.citation.trim();

  // A dead URL is still useful to a resolver when no title or citation is available.
  const url = usableHttpUrl(source.url);
  if (!url) return null;
  const parsed = new URL(url);
  const pathTerms = parsed.pathname
    .split("/")
    .flatMap((segment) => segment.split(/[-_.]+/))
    .filter((term) => term.length > 2);
  return [parsed.hostname.replace(/^www\./, ""), ...pathTerms].join(" ") || null;
}

/**
 * Adapts any `SearchProvider` into the optional resolver boundary. It is intentionally only used
 * after a direct source is missing, malformed, unsupported, or cannot be fetched.
 */
export class SearchSourceResolver implements SourceResolver {
  readonly kind: string;

  constructor(private readonly search: SearchProvider) {
    this.kind = `search:${search.kind}`;
  }

  async resolve(source: SourceReference): Promise<string | null> {
    const query = sourceLookupQuery(source);
    if (!query) return null;
    const hits = await this.search.search(query, 5);
    return hits.map((hit) => usableHttpUrl(hit.url)).find((url): url is string => url !== null) ?? null;
  }
}

export interface FetchSourceOptions {
  fetcher: PageFetcher;
  resolver?: SourceResolver;
}

export interface FetchedSource {
  page: FetchedPage;
  /** Whether the evidence came from the proposed URL or a resolver result. */
  resolved: boolean;
}

async function nonfatalFetch(fetcher: PageFetcher, url: string): Promise<FetchedPage | null> {
  try {
    return await fetcher.fetch(url);
  } catch {
    return null;
  }
}

/**
 * Fetch an upstream proposal directly whenever possible. Resolution is a single fallback step:
 * it never runs after a usable direct response and it never recursively searches resolver output.
 */
export async function fetchSource(source: SourceReference, options: FetchSourceOptions): Promise<FetchedSource | null> {
  const directUrl = usableHttpUrl(source.url);
  if (directUrl) {
    const page = await nonfatalFetch(options.fetcher, directUrl);
    if (page) return { page, resolved: false };
  }

  if (!options.resolver) return null;
  let resolvedUrl: string | null;
  try {
    resolvedUrl = usableHttpUrl(await options.resolver.resolve(source));
  } catch {
    return null;
  }
  if (!resolvedUrl || resolvedUrl === directUrl) return null;
  const page = await nonfatalFetch(options.fetcher, resolvedUrl);
  return page ? { page, resolved: true } : null;
}
