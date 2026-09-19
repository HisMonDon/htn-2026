import { Client } from "@elastic/elasticsearch";
import { Bm25 } from "./bm25";
import type { CandidateDocument } from "./extract";
import { matchKey } from "./text";

/**
 * Retrieval of possible ancestors/descendants for a document. An index only proposes candidate
 * pairs; it never decides provenance. Every proposed pair is scored by the deterministic scorer.
 */
export interface RelatedHit {
  id: string;
  score: number;
}

export interface CandidateIndex {
  readonly kind: "elastic-hybrid" | "elastic-lexical" | "memory-bm25";
  indexDocuments(runId: string, docs: CandidateDocument[]): Promise<void>;
  related(runId: string, doc: CandidateDocument, limit: number): Promise<RelatedHit[]>;
  cleanup(runId: string): Promise<void>;
}

function queryText(doc: CandidateDocument): string {
  return [doc.passage, ...doc.fabricated_citations].join(" ");
}

/** In-process BM25 plus shared-citation matching. Used offline and when Elastic is not configured. */
export class MemoryIndex implements CandidateIndex {
  readonly kind = "memory-bm25" as const;
  private readonly runs = new Map<string, { bm25: Bm25<CandidateDocument>; docs: CandidateDocument[] }>();

  async indexDocuments(runId: string, docs: CandidateDocument[]): Promise<void> {
    const bm25 = new Bm25<CandidateDocument>();
    for (const doc of docs) bm25.add(doc, `${doc.title} ${doc.passage} ${doc.text}`);
    this.runs.set(runId, { bm25, docs });
  }

  async related(runId: string, doc: CandidateDocument, limit: number): Promise<RelatedHit[]> {
    const run = this.runs.get(runId);
    if (!run) return [];
    const scores = new Map<string, number>();
    const lexical = run.bm25.search(queryText(doc), limit, (item) => item.id !== doc.id);
    // Reciprocal-rank fusion of lexical rank and shared-citation rank, mirroring the Elastic RRF setup.
    lexical.forEach(({ item }, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + rank + 1)));
    const citations = new Set(doc.fabricated_citations.map(matchKey));
    const byCitation = run.docs
      .filter((other) => other.id !== doc.id)
      .map((other) => ({ other, shared: other.fabricated_citations.filter((c) => citations.has(matchKey(c))).length }))
      .filter(({ shared }) => shared > 0)
      .sort((a, b) => b.shared - a.shared || a.other.id.localeCompare(b.other.id));
    byCitation.forEach(({ other }, rank) => scores.set(other.id, (scores.get(other.id) ?? 0) + 1 / (60 + rank + 1)));
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async cleanup(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

/** The subset of the Elasticsearch client used here, so tests can substitute a recorder. */
export interface EsClient {
  indices: {
    exists(params: { index: string }): Promise<boolean>;
    create(params: Record<string, unknown>): Promise<unknown>;
  };
  bulk(params: Record<string, unknown>): Promise<{ errors: boolean; items: unknown[] }>;
  search(params: Record<string, unknown>): Promise<{ hits: { hits: { _score?: number | null; _source?: unknown }[] } }>;
  deleteByQuery(params: Record<string, unknown>): Promise<unknown>;
}

export interface ElasticOptions {
  index: string;
  /** Use a semantic_text field and hybrid RRF retrieval. Requires an inference endpoint. */
  semantic: boolean;
  /** Inference endpoint for semantic_text. Omit to use the cluster default (e.g. EIS on Elastic Cloud). */
  inferenceId: string | null;
}

/**
 * Elastic retrieval per the Elasticsearch docs "Hybrid search with semantic_text": a text field
 * copied into a semantic_text field, queried with an RRF retriever that fuses lexical and semantic
 * matches. A third retriever matches shared fabricated citations exactly (keyword field).
 */
export class ElasticIndex implements CandidateIndex {
  readonly kind: "elastic-hybrid" | "elastic-lexical";
  private ready: Promise<void> | null = null;

  constructor(
    private readonly client: EsClient,
    private readonly options: ElasticOptions,
  ) {
    this.kind = options.semantic ? "elastic-hybrid" : "elastic-lexical";
  }

  mapping(): Record<string, unknown> {
    const passage: Record<string, unknown> = { type: "text" };
    const properties: Record<string, unknown> = {
      run_id: { type: "keyword" },
      doc_id: { type: "keyword" },
      url: { type: "keyword" },
      publisher: { type: "text" },
      title: { type: "text" },
      timestamp: { type: "date" },
      passage,
      body: { type: "text" },
      fabricated_citations: { type: "keyword" },
      outbound_links: { type: "keyword" },
    };
    if (this.options.semantic) {
      passage.copy_to = "passage_semantic";
      properties.passage_semantic = {
        type: "semantic_text",
        ...(this.options.inferenceId ? { inference_id: this.options.inferenceId } : {}),
      };
    }
    return { properties };
  }

  private ensureIndex(): Promise<void> {
    this.ready ??= (async () => {
      if (await this.client.indices.exists({ index: this.options.index })) return;
      await this.client.indices.create({ index: this.options.index, mappings: this.mapping() });
    })();
    return this.ready;
  }

  async indexDocuments(runId: string, docs: CandidateDocument[]): Promise<void> {
    await this.ensureIndex();
    const operations = docs.flatMap((doc) => [
      { index: { _index: this.options.index, _id: `${runId}:${doc.id}` } },
      {
        run_id: runId,
        doc_id: doc.id,
        url: doc.url,
        publisher: doc.publisher,
        title: doc.title,
        timestamp: doc.timestamp,
        passage: doc.passage,
        body: doc.text,
        fabricated_citations: doc.fabricated_citations.map(matchKey),
        outbound_links: doc.outbound_links,
      },
    ]);
    const result = await this.client.bulk({ refresh: "wait_for", operations });
    if (result.errors) throw new Error("Elastic bulk indexing reported errors");
  }

  searchRequest(runId: string, doc: CandidateDocument, limit: number): Record<string, unknown> {
    const scope = { filter: [{ term: { run_id: runId } }], must_not: [{ term: { doc_id: doc.id } }] };
    const retrievers: Record<string, unknown>[] = [
      {
        standard: {
          query: {
            bool: {
              must: { multi_match: { query: queryText(doc), fields: ["passage^2", "body", "title"] } },
              ...scope,
            },
          },
        },
      },
    ];
    if (this.options.semantic) {
      retrievers.push({
        standard: { query: { bool: { must: { match: { passage_semantic: doc.passage } }, ...scope } } },
      });
    }
    if (doc.fabricated_citations.length) {
      retrievers.push({
        standard: {
          query: {
            bool: {
              must: { terms: { fabricated_citations: doc.fabricated_citations.map(matchKey) } },
              ...scope,
            },
          },
        },
      });
    }
    return {
      index: this.options.index,
      size: limit,
      _source: ["doc_id"],
      retriever:
        retrievers.length === 1
          ? retrievers[0]
          : { rrf: { retrievers, rank_window_size: Math.max(50, limit), rank_constant: 60 } },
    };
  }

  async related(runId: string, doc: CandidateDocument, limit: number): Promise<RelatedHit[]> {
    const response = await this.client.search(this.searchRequest(runId, doc, limit));
    return response.hits.hits
      .map((hit) => ({ id: (hit._source as { doc_id?: string } | undefined)?.doc_id ?? "", score: hit._score ?? 0 }))
      .filter((hit) => hit.id && hit.id !== doc.id);
  }

  async cleanup(runId: string): Promise<void> {
    await this.client.deleteByQuery({
      index: this.options.index,
      query: { term: { run_id: runId } },
      refresh: true,
      conflicts: "proceed",
    });
  }
}

export interface ElasticConfig {
  url: string | null;
  cloudId: string | null;
  apiKey: string | null;
  index: string;
  semantic: boolean;
  inferenceId: string | null;
}

export function createCandidateIndex(config: ElasticConfig | null): CandidateIndex {
  if (!config || (!config.url && !config.cloudId)) return new MemoryIndex();
  const client = new Client({
    ...(config.cloudId ? { cloud: { id: config.cloudId } } : { node: config.url! }),
    ...(config.apiKey ? { auth: { apiKey: config.apiKey } } : {}),
  });
  return new ElasticIndex(client as unknown as EsClient, {
    index: config.index,
    semantic: config.semantic,
    inferenceId: config.inferenceId,
  });
}
