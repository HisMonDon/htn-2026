import Browserbase from "@browserbasehq/sdk";
import * as cheerio from "cheerio";
import type { CorpusPage } from "../../data/research-corpus";
import { Bm25 } from "./bm25";
import { canonicalUrl } from "./extract";

export interface SearchHit {
  url: string;
  title: string;
  published: string | null;
}

export interface SearchProvider {
  readonly kind: "browserbase" | "offline-corpus";
  search(query: string, limit: number): Promise<SearchHit[]>;
}

export interface FetchedPage {
  url: string;
  html: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage | null>;
}

/** Browserbase Search API (POST /v1/search via @browserbasehq/sdk). */
export class BrowserbaseSearch implements SearchProvider {
  readonly kind = "browserbase" as const;
  constructor(private readonly client: Browserbase) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const response = await this.client.search.web({ query, numResults: Math.min(25, Math.max(1, limit)) });
    return response.results.map((result) => ({
      url: result.url,
      title: result.title,
      published: result.publishedDate ?? null,
    }));
  }
}

/**
 * Browserbase Fetch API (POST /v1/fetch). Raw HTML, no JavaScript execution, 5 MB limit per the
 * docs. Pages that fail or are not HTML are skipped rather than guessed at.
 */
export class BrowserbaseFetcher implements PageFetcher {
  constructor(private readonly client: Browserbase) {}

  async fetch(url: string): Promise<FetchedPage | null> {
    try {
      const response = await this.client.fetchAPI.create({ url, allowRedirects: true, format: "raw" });
      if (response.statusCode >= 400 || typeof response.content !== "string") return null;
      if (!/html|xml|text\/plain/i.test(response.contentType)) return null;
      const html =
        response.encoding === "base64" ? Buffer.from(response.content, "base64").toString("utf8") : response.content;
      return { url, html };
    } catch {
      return null;
    }
  }
}

export function browserbaseProviders(apiKey: string): { search: SearchProvider; fetcher: PageFetcher } {
  const client = new Browserbase({ apiKey });
  return { search: new BrowserbaseSearch(client), fetcher: new BrowserbaseFetcher(client) };
}

/** Keyword search over the offline corpus, standing in for a web search engine. */
export class CorpusSearch implements SearchProvider {
  readonly kind = "offline-corpus" as const;
  private readonly index = new Bm25<{ id: string; page: CorpusPage; title: string }>();

  constructor(pages: CorpusPage[]) {
    for (const page of pages) {
      const $ = cheerio.load(page.html);
      const title = $("title").first().text();
      $("script, style, nav").remove();
      this.index.add({ id: canonicalUrl(page.url), page, title }, `${title} ${$("body").text()}`);
    }
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    return this.index.search(query, limit).map(({ item }) => ({
      url: item.page.url,
      title: item.title,
      published: item.page.search_published ?? null,
    }));
  }
}

export class CorpusFetcher implements PageFetcher {
  private readonly pages = new Map<string, CorpusPage>();
  constructor(pages: CorpusPage[]) {
    for (const page of pages) this.pages.set(canonicalUrl(page.url), page);
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    const page = this.pages.get(canonicalUrl(url));
    return page ? { url: page.url, html: page.html } : null;
  }
}
