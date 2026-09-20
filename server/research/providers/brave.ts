import type { SearchHit, SearchProvider } from "./types";

export interface BraveSearchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Brave's documented per-request maximum for `count`. */
const MAX_COUNT = 20;

/**
 * Web search via the Brave Search API (https://api.search.brave.com). It only turns a query into
 * candidate URLs; nothing it returns is evidence of provenance. The key is supplied by the caller
 * (`BRAVE_SEARCH_API_KEY`) and never appears in an error message.
 */
export class BraveSearchProvider implements SearchProvider {
  static readonly endpoint = "https://api.search.brave.com/res/v1/web/search";
  readonly kind = "brave-search" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: BraveSearchOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const url = new URL(BraveSearchProvider.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, Math.min(MAX_COUNT, Math.floor(limit)))));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { "x-subscription-token": this.apiKey, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Brave search timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Brave search returned ${response.status}`);

    const json = (await response.json()) as { web?: { results?: unknown } };
    const results = Array.isArray(json.web?.results) ? (json.web!.results as Array<Record<string, unknown>>) : [];
    const hits: SearchHit[] = [];
    for (const result of results) {
      if (typeof result.url !== "string" || !result.url) continue;
      hits.push({
        url: result.url,
        title: typeof result.title === "string" ? result.title : "",
        published: typeof result.page_age === "string" ? result.page_age : null,
        snippet: typeof result.description === "string" ? result.description : null,
      });
    }
    return hits.slice(0, limit);
  }
}
