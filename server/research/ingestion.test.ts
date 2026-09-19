import { describe, expect, it } from "vitest";
import { DirectHttpFetcher } from "./providers";
import { ingestSource } from "./ingestion";

const options = {
  fabricated: ["Example v. Fabrication"],
  claimTerms: ["fabrication"],
  discoveredVia: "test",
};

describe("source ingestion failures", () => {
  it("rejects an empty HTML response before it can become provenance evidence", async () => {
    const result = await ingestSource(
      "https://source.example/empty",
      { fetch: async (url) => ({ url, kind: "html", html: "<html><body></body></html>" }) },
      options,
    );

    expect(result).toMatchObject({
      ok: false,
      stage: "extraction",
      category: "empty-document",
      reason: "empty-document",
      recoverable: false,
    });
  });

  it("rejects short 200 bot-block and error pages before validation", async () => {
    const result = await ingestSource(
      "https://source.example/protected",
      {
        fetch: async (url) => ({
          url,
          kind: "html",
          html: "<html><head><title>Access denied</title></head><body><p>Access denied</p></body></html>",
        }),
      },
      options,
    );

    expect(result).toMatchObject({
      ok: false,
      stage: "extraction",
      category: "error-document",
      reason: "error-document",
    });
  });

  it("preserves a source timeout as a recoverable fetch failure", async () => {
    const fetcher = new DirectHttpFetcher({
      timeoutMs: 1,
      retryDelayMs: 0,
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const result = await ingestSource("https://source.example/slow", fetcher, options);

    expect(result).toMatchObject({
      ok: false,
      stage: "fetch",
      category: "timeout",
      reason: "source-timeout",
      recoverable: true,
    });
  });

  it("keeps unsupported responses outside the document pipeline", async () => {
    const fetcher = new DirectHttpFetcher({
      fetchImpl: async () => new Response('{"not":"evidence"}', { headers: { "content-type": "application/json" } }),
    });
    const result = await ingestSource("https://source.example/data", fetcher, options);

    expect(result).toMatchObject({
      ok: false,
      stage: "fetch",
      category: "unsupported-content",
      reason: "unsupported-document",
      recoverable: false,
    });
  });
});
