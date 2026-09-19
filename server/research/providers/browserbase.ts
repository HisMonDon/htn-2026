import Browserbase from "@browserbasehq/sdk";
import { detectContentKind } from "../content-type";
import type { FetchedPage, PageFetcher, SearchHit, SearchProvider } from "./types";

/**
 * Browserbase-specific discovery provider. Everything that talks to the Browserbase SDK lives in
 * this file — swapping discovery providers means adding a sibling file that implements
 * `SearchProvider`/`PageFetcher` and pointing the factory at it, without touching this one.
 */

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
    } catch {
      return null;
    }
  }
}

export function browserbaseProviders(apiKey: string): { search: SearchProvider; fetcher: PageFetcher } {
  const client = new Browserbase({ apiKey });
  return { search: new BrowserbaseSearch(client), fetcher: new BrowserbaseFetcher(client) };
}
