import { describe, expect, it } from "vitest";
import rawCandidates from "../../data/cohen-bard-candidates.json";
import { ElasticDocumentIndex, MockDocumentIndex, type ProvenanceDocument } from "./document-index";

const corpus = rawCandidates as ProvenanceDocument[];

describe("document index", () => {
  it("mock search prioritizes mutation matches but still returns a noisy pool", async () => {
    const index = new MockDocumentIndex(corpus);
    const results = await index.search({
      text: "fabricated early termination cases",
      mutations: ["United States v. Amato"],
      limit: corpus.length,
    });
    expect(results).toHaveLength(corpus.length);
    expect(results.slice(0, 4).every((document) => (document.fabricatedCitations ?? []).includes("United States v. Amato"))).toBe(true);
  });

  it("Elastic search emits lexical, mutation, exclusion, and vector retrieval signals", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ hits: { hits: [{ _source: corpus[0] }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const index = new ElasticDocumentIndex({
      baseUrl: "https://elastic.example",
      indexName: "lineage-docs",
      apiKey: "secret",
      fetcher,
    });
    const results = await index.search({
      text: "early termination",
      mutations: ["United States v. Ortiz"],
      embedding: [0.1, 0.2],
      excludeIds: ["seed"],
      limit: 7,
    });
    const body = JSON.parse(String(calls[0]!.init.body)) as any;

    expect(results[0]?.id).toBe("bard-generation");
    expect(calls[0]!.url).toBe("https://elastic.example/lineage-docs/_search");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "ApiKey secret" });
    expect(body.size).toBe(7);
    expect(body.query.bool.should).toHaveLength(3);
    expect(body.query.bool.must_not).toEqual([{ ids: { values: ["seed"] } }]);
    expect(body.knn.query_vector).toEqual([0.1, 0.2]);
  });
});
