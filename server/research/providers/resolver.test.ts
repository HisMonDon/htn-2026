import { describe, expect, it, vi } from "vitest";
import { fetchSource, SearchSourceResolver, sourceLookupQuery } from "./resolver";
import type { FetchedPage, PageFetcher, SearchProvider, SourceResolver } from "./types";

const directUrl = "https://publisher.example/article";
const resolvedUrl = "https://archive.example/source";
const htmlPage = (url: string): FetchedPage => ({ url, kind: "html", html: "<html><body>evidence</body></html>" });

describe("source resolution", () => {
  it("does not invoke a resolver when a proposed URL directly yields usable evidence", async () => {
    const resolver: SourceResolver = { kind: "test", resolve: vi.fn() };
    const fetcher: PageFetcher = { fetch: vi.fn(async (url) => htmlPage(url)) };

    await expect(fetchSource({ url: directUrl, title: "Evidence" }, { fetcher, resolver })).resolves.toEqual({
      page: htmlPage(directUrl),
      resolved: false,
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("uses the resolver for an incomplete title/citation proposal", async () => {
    const resolver: SourceResolver = { kind: "test", resolve: vi.fn(async () => resolvedUrl) };
    const fetcher: PageFetcher = { fetch: vi.fn(async (url) => htmlPage(url)) };

    const result = await fetchSource(
      { author: "Ada Lovelace", title: "An analytical engine", citation: "Lovelace 1843" },
      { fetcher, resolver },
    );
    expect(result).toEqual({ page: htmlPage(resolvedUrl), resolved: true });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).toHaveBeenCalledWith(resolvedUrl);
  });

  it("falls back exactly once after a dead direct URL", async () => {
    const resolver: SourceResolver = { kind: "test", resolve: vi.fn(async () => resolvedUrl) };
    const fetcher: PageFetcher = {
      fetch: vi.fn(async (url) => (url === directUrl ? null : htmlPage(url))),
    };

    const result = await fetchSource({ url: directUrl, title: "Archived evidence" }, { fetcher, resolver });
    expect(result).toEqual({ page: htmlPage(resolvedUrl), resolved: true });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).toHaveBeenNthCalledWith(1, directUrl);
    expect(fetcher.fetch).toHaveBeenNthCalledWith(2, resolvedUrl);
  });

  it("adapts any search provider only for bibliographic fallback", async () => {
    const search: SearchProvider = {
      kind: "test-search",
      search: vi.fn(async () => [{ url: resolvedUrl, title: "Evidence", published: null }]),
    };
    const resolver = new SearchSourceResolver(search);
    await expect(resolver.resolve({ author: "Ada", title: "Evidence" })).resolves.toBe(resolvedUrl);
    expect(search.search).toHaveBeenCalledWith("Ada Evidence", 5);
    expect(sourceLookupQuery({ url: "https://news.example/reports/evidence-2026" })).toBe("news.example reports evidence 2026");
  });
});
