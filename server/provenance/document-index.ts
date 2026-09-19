import type { AiEvidence } from "../../shared/schema";
import type { ProvenanceDoc } from "./score";

export interface ProvenanceDocument {
  id: string;
  url: string;
  publisher: string;
  timestamp: string;
  title: string;
  relevantPassage: string;
  claim?: string;
  fabricatedCitations?: string[];
  rareMutations?: string[];
  explicitLinks?: string[];
  sourceReferences?: string[];
  embedding?: number[];
  aiEvidence?: AiEvidence | null;
}

export interface CandidateQuery {
  text: string;
  mutations?: string[];
  embedding?: number[];
  excludeIds?: string[];
  limit?: number;
}

export interface DocumentIndex {
  index(document: ProvenanceDocument): Promise<void>;
  search(query: CandidateQuery): Promise<ProvenanceDocument[]>;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter(Boolean));
}

function lexicalScore(query: CandidateQuery, document: ProvenanceDocument): number {
  const queryTokens = tokens(query.text);
  const body = [
    document.title,
    document.relevantPassage,
    document.claim ?? "",
    ...(document.fabricatedCitations ?? []),
    ...(document.rareMutations ?? []),
  ].join(" ");
  const documentTokens = tokens(body);
  let shared = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) shared += 1;
  const union = new Set([...queryTokens, ...documentTokens]).size || 1;
  const overlap = shared / union;
  const normalizedBody = normalize(body);
  const mutationMatches = (query.mutations ?? []).filter((mutation) => normalizedBody.includes(normalize(mutation))).length;
  return overlap + mutationMatches * 2;
}

export class MockDocumentIndex implements DocumentIndex {
  private readonly documents = new Map<string, ProvenanceDocument>();

  constructor(documents: ProvenanceDocument[] = []) {
    for (const document of documents) this.documents.set(document.id, structuredClone(document));
  }

  async index(document: ProvenanceDocument): Promise<void> {
    this.documents.set(document.id, structuredClone(document));
  }

  async search(query: CandidateQuery): Promise<ProvenanceDocument[]> {
    const excluded = new Set(query.excludeIds ?? []);
    const limit = Math.max(1, query.limit ?? 20);
    return [...this.documents.values()]
      .filter((document) => !excluded.has(document.id))
      .map((document) => ({ document, score: lexicalScore(query, document) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.document.timestamp) - Date.parse(a.document.timestamp) ||
          a.document.id.localeCompare(b.document.id),
      )
      .slice(0, limit)
      .map(({ document }) => structuredClone(document));
  }
}

export interface ElasticDocumentIndexOptions {
  baseUrl: string;
  indexName: string;
  apiKey?: string | null;
  fetcher?: typeof fetch;
}

export class ElasticDocumentIndex implements DocumentIndex {
  private readonly baseUrl: string;
  private readonly indexName: string;
  private readonly apiKey: string | null;
  private readonly fetcher: typeof fetch;

  constructor(options: ElasticDocumentIndexOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.indexName = options.indexName;
    this.apiKey = options.apiKey?.trim() || null;
    this.fetcher = options.fetcher ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `ApiKey ${this.apiKey}` } : {}),
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/${encodeURIComponent(this.indexName)}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      throw new Error(`Elastic request failed (${response.status}): ${await response.text()}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async index(document: ProvenanceDocument): Promise<void> {
    await this.request(`/_doc/${encodeURIComponent(document.id)}?refresh=wait_for`, {
      method: "PUT",
      body: JSON.stringify(document),
    });
  }

  async search(query: CandidateQuery): Promise<ProvenanceDocument[]> {
    const should: Record<string, unknown>[] = [];
    if (query.text.trim()) {
      should.push({
        multi_match: {
          query: query.text,
          fields: ["title^3", "claim^3", "relevantPassage^2", "fabricatedCitations^5", "rareMutations^5"],
        },
      });
    }
    if ((query.mutations ?? []).length > 0) {
      should.push({ terms: { "fabricatedCitations.keyword": query.mutations, boost: 6 } });
      should.push({ terms: { "rareMutations.keyword": query.mutations, boost: 6 } });
    }
    const body: Record<string, unknown> = {
      size: Math.max(1, query.limit ?? 20),
      query: {
        bool: {
          should,
          minimum_should_match: should.length > 0 ? 1 : 0,
          must_not: (query.excludeIds ?? []).map((id) => ({ ids: { values: [id] } })),
        },
      },
    };
    if ((query.embedding ?? []).length > 0) {
      body.knn = {
        field: "embedding",
        query_vector: query.embedding,
        k: Math.max(1, query.limit ?? 20),
        num_candidates: Math.max(50, (query.limit ?? 20) * 5),
        boost: 2,
      };
    }
    const raw = (await this.request("/_search", {
      method: "POST",
      body: JSON.stringify(body),
    })) as { hits?: { hits?: Array<{ _source?: ProvenanceDocument }> } };
    return (raw.hits?.hits ?? []).flatMap((hit) => (hit._source ? [hit._source] : []));
  }
}

export function toScoringDoc(document: ProvenanceDocument): ProvenanceDoc {
  return {
    id: document.id,
    timestamp: document.timestamp,
    text: document.relevantPassage,
    url: document.url,
    links: document.explicitLinks ?? [],
    title: document.title,
    publisher: document.publisher,
    sourceReferences: document.sourceReferences ?? [],
  };
}
