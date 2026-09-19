import type { FetchFailure, FetchFailureCategory, FetchResult, FetchedPage, PageFetcher, SearchProvider, SourceReference, SourceResolver } from "./types";

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

export interface SourceFetchFailure {
  stage: "fetch" | "resolution";
  category: FetchFailureCategory | "missing-source-reference" | "resolver-failed";
  message: string;
  recoverable: boolean;
  url: string | null;
}

export interface FetchSourceResult {
  fetched: FetchedSource | null;
  failure: SourceFetchFailure | null;
}

async function nonfatalFetch(fetcher: PageFetcher, url: string): Promise<FetchResult> {
  try {
    if (fetcher.fetchDetailed) return await fetcher.fetchDetailed(url);
    const page = await fetcher.fetch(url);
    if (page) return { ok: true, page };
    return {
      ok: false,
      failure: { stage: "fetch", category: "http-404", message: "source was not found", recoverable: false, status: 404, url },
    };
  } catch {
    return {
      ok: false,
      failure: { stage: "fetch", category: "network-error", message: "source network request failed", recoverable: true, status: null, url },
    };
  }
}

/**
 * Fetch an upstream proposal directly whenever possible. Resolution is a single fallback step:
 * it never runs after a usable direct response and it never recursively searches resolver output.
 */
export async function fetchSource(source: SourceReference, options: FetchSourceOptions): Promise<FetchedSource | null> {
  return (await fetchSourceDetailed(source, options)).fetched;
}

export async function fetchSourceDetailed(source: SourceReference, options: FetchSourceOptions): Promise<FetchSourceResult> {
  const directUrl = usableHttpUrl(source.url);
  let directFailure: FetchFailure | null = null;
  if (directUrl) {
    const result = await nonfatalFetch(options.fetcher, directUrl);
    if (result.ok) return { fetched: { page: result.page, resolved: false }, failure: null };
    directFailure = result.failure;
  } else if (source.url) {
    directFailure = {
      stage: "fetch",
      category: "invalid-url",
      message: "source URL is not HTTP(S)",
      recoverable: false,
      status: null,
      url: source.url,
    };
  }

  if (!options.resolver) {
    if (directFailure) return { fetched: null, failure: directFailure };
    return {
      fetched: null,
      failure: {
        stage: "resolution",
        category: "missing-source-reference",
        message: "source proposal did not contain a usable URL or bibliographic reference",
        recoverable: false,
        url: null,
      },
    };
  }
  let resolvedUrl: string | null;
  try {
    resolvedUrl = usableHttpUrl(await options.resolver.resolve(source));
  } catch {
    return {
      fetched: null,
      failure: {
        stage: "resolution",
        category: "resolver-failed",
        message: "source resolution failed",
        recoverable: true,
        url: directUrl,
      },
    };
  }
  if (!resolvedUrl || resolvedUrl === directUrl) {
    if (directFailure) return { fetched: null, failure: directFailure };
    return {
      fetched: null,
      failure: {
        stage: "resolution",
        category: "missing-source-reference",
        message: "source resolution did not produce a usable URL",
        recoverable: false,
        url: null,
      },
    };
  }
  const result = await nonfatalFetch(options.fetcher, resolvedUrl);
  if (result.ok) return { fetched: { page: result.page, resolved: true }, failure: null };
  return { fetched: null, failure: result.failure };
}
