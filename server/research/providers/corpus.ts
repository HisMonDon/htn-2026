import * as cheerio from "cheerio";
import type { CorpusPage } from "../../../data/research-corpus";
import { Bm25 } from "../bm25";
import { canonicalUrl } from "../extract";
import type { FetchedPage, PageFetcher, SearchHit, SearchProvider } from "./types";

/**
 * Offline/mock discovery provider, standing in for a web search engine over a fixed corpus. This is
 * what USE_MOCKS=true selects, and what the offline research regression tests run against — it must
 * keep working regardless of which live provider backs production.
 */

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
