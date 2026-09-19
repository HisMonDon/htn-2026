import { describe, expect, it } from "vitest";
import { ElasticIndex, MemoryIndex, type EsClient } from "./candidate-index";
import type { CandidateDocument } from "./extract";

function doc(id: string, passage: string, fabricated: string[] = []): CandidateDocument {
  return {
    id,
    canonical_id: `sha256:${"0".repeat(64)}`,
    content_fingerprint: "0".repeat(64),
    url: `https://${id}.example/`,
    mirror_urls: [],
    publisher: id,
    title: id,
    timestamp: "2023-12-01T00:00:00.000Z",
    timestamp_source: "meta",
    timestamp_confidence: "strong",
    timestamp_conflict: null,
    text: passage,
    passage,
    outbound_links: [],
    case_names: fabricated,
    fabricated_citations: fabricated,
    citation_variants: [],
    discovered_via: ["test"],
  };
}

/** Records requests instead of talking to a cluster. Verifies request shape, not Elastic itself. */
function recorder(existing = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client: EsClient = {
    indices: {
      exists: async (params) => {
        calls.push({ method: "indices.exists", params });
        return existing;
      },
      create: async (params) => {
        calls.push({ method: "indices.create", params });
        return {};
      },
    },
    bulk: async (params) => {
      calls.push({ method: "bulk", params });
      return { errors: false, items: [] };
    },
    search: async (params) => {
      calls.push({ method: "search", params });
      return { hits: { hits: [{ _score: 2, _source: { doc_id: "b" } }, { _score: 1, _source: { doc_id: "a" } }] } };
    },
    deleteByQuery: async (params) => {
      calls.push({ method: "deleteByQuery", params });
      return {};
    },
  };
  return { client, calls };
}

const FAB = ["United States v. Ortiz"];

describe("ElasticIndex", () => {
  it("creates a hybrid mapping: text copied into semantic_text, keyword citations", async () => {
    const { client, calls } = recorder();
    const index = new ElasticIndex(client, { index: "lineage-test", semantic: true, inferenceId: ".elser-2-elasticsearch" });
    await index.indexDocuments("run-1", [doc("a", "alpha", FAB)]);
    const create = calls.find((call) => call.method === "indices.create")!;
    expect(create.params).toMatchObject({
      index: "lineage-test",
      mappings: {
        properties: {
          passage: { type: "text", copy_to: "passage_semantic" },
          passage_semantic: { type: "semantic_text", inference_id: ".elser-2-elasticsearch" },
          fabricated_citations: { type: "keyword" },
          run_id: { type: "keyword" },
        },
      },
    });
    const bulk = calls.find((call) => call.method === "bulk")!;
    expect(bulk.params.refresh).toBe("wait_for");
    expect((bulk.params.operations as unknown[])[1]).toMatchObject({ run_id: "run-1", doc_id: "a", fabricated_citations: ["united states v. ortiz"] });
  });

  it("does not recreate an existing index", async () => {
    const { client, calls } = recorder(true);
    await new ElasticIndex(client, { index: "x", semantic: true, inferenceId: null }).indexDocuments("r", [doc("a", "alpha")]);
    expect(calls.some((call) => call.method === "indices.create")).toBe(false);
  });

  it("retrieves with an RRF of lexical, semantic and shared-citation retrievers, scoped to the run and excluding self", async () => {
    const { client, calls } = recorder();
    const index = new ElasticIndex(client, { index: "x", semantic: true, inferenceId: null });
    const hits = await index.related("run-1", doc("c", "the passage", FAB), 5);
    expect(hits).toEqual([
      { id: "b", score: 2 },
      { id: "a", score: 1 },
    ]);
    const search = calls.find((call) => call.method === "search")!.params as any;
    const retrievers = search.retriever.rrf.retrievers;
    expect(retrievers).toHaveLength(3);
    expect(retrievers[0].standard.query.bool.must.multi_match.query).toContain("the passage");
    expect(retrievers[1].standard.query.bool.must.match.passage_semantic).toBe("the passage");
    expect(retrievers[2].standard.query.bool.must.terms.fabricated_citations).toEqual(["united states v. ortiz"]);
    for (const retriever of retrievers) {
      expect(retriever.standard.query.bool.filter).toEqual([{ term: { run_id: "run-1" } }]);
      expect(retriever.standard.query.bool.must_not).toEqual([{ term: { doc_id: "c" } }]);
    }
  });

  it("falls back to a single lexical retriever when semantic search is off", () => {
    const { client } = recorder();
    const index = new ElasticIndex(client, { index: "x", semantic: false, inferenceId: null });
    expect(index.kind).toBe("elastic-lexical");
    expect(index.mapping()).not.toHaveProperty("properties.passage_semantic");
    const request = index.searchRequest("r", doc("c", "p"), 5) as any;
    expect(request.retriever.standard).toBeDefined();
  });

  it("cleans up the run's documents", async () => {
    const { client, calls } = recorder();
    await new ElasticIndex(client, { index: "x", semantic: false, inferenceId: null }).cleanup("run-9");
    expect(calls[0]).toMatchObject({ method: "deleteByQuery", params: { query: { term: { run_id: "run-9" } } } });
  });
});

describe("MemoryIndex", () => {
  it("proposes lexically similar and citation-sharing documents, never the document itself", async () => {
    const index = new MemoryIndex();
    await index.indexDocuments("r", [
      doc("a", "motion for early termination of supervised release", FAB),
      doc("b", "a recipe for bread"),
      doc("c", "early termination motion discussed", FAB),
    ]);
    const hits = await index.related("r", doc("a", "motion for early termination of supervised release", FAB), 5);
    // Retrieval only proposes; an unrelated page may appear, but ranks below the related one.
    expect(hits[0]?.id).toBe("c");
    expect(hits.map((hit) => hit.id)).not.toContain("a");
  });
});
