import Browserbase from "@browserbasehq/sdk";
import * as cheerio from "cheerio";
import type { CorpusPage } from "../../data/research-corpus";
import { Bm25 } from "./bm25";
import { canonicalUrl } from "./extract";
import { detectContentKind } from "./content-type";

export interface SearchHit {
  url: string;
  title: string;
  published: string | null;
}

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
 * Browserbase Fetch API (POST /v1/fetch). Raw content, no JavaScript execution, 5 MB limit per the
 * docs. HTML/XML/plain text is decoded as a page; a PDF (by `Content-Type`, or by its URL when the
 * header is missing) is decoded to bytes for deterministic parsing. Anything else, or a fetch that
 * fails outright, is skipped rather than guessed at.
 */
export class BrowserbaseFetcher implements PageFetcher {
  constructor(private readonly client: Browserbase) {}

  async fetch(url: string): Promise<FetchedPage | null> {
    try {
      const response = await this.client.fetchAPI.create({ url, allowRedirects: true, format: "raw" });
      if (response.statusCode >= 400 || typeof response.content !== "string") return null;
      const kind = detectContentKind({ contentType: response.contentType, url });
      // TEMPORARY DIAGNOSTIC LOGGING (step 6 PDF verification) - safe to delete this line.
      console.log(`[pdf-debug] fetch ${url} -> status=${response.statusCode} content-type=${response.contentType ?? "(none)"} detected=${kind}`);
      if (kind === "html") {
        const html =
          response.encoding === "base64" ? Buffer.from(response.content, "base64").toString("utf8") : response.content;
        return { url, kind: "html", html };
      }
      if (kind === "pdf") {
        // Size is enforced by the deterministic PDF extractor, so "too large" is a visible
        // extraction failure rather than a silent fetch failure indistinguishable from any other.
        const bytes =
          response.encoding === "base64" ? Buffer.from(response.content, "base64") : Buffer.from(response.content, "utf8");
        return { url, kind: "pdf", bytes };
      }
      return null;
    } catch (error) {
      // TEMPORARY DIAGNOSTIC LOGGING (step 6 PDF verification) - safe to delete this line.
      console.log(`[pdf-debug] fetch ${url} threw: ${error instanceof Error ? error.message : String(error)}`);
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
    return page ? { url: page.url, kind: "html", html: page.html } : null;
  }
}
