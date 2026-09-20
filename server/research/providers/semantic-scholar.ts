import { academicTitleKey, identifyAcademicPaper, type AcademicIdentity, type AcademicPaperMetadata } from "../academic";
import { canonicalUrl, type CandidateDocument } from "../extract";
import type { CitationDirection, CitationProviderMetadata, UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../traversal";

const API = "https://api.semanticscholar.org/graph/v1";
const PAPER_FIELDS = [
  "paperId", "title", "authors", "year", "venue", "externalIds", "url", "openAccessPdf",
  "publicationDate", "journal", "publicationVenue", "citationCount", "referenceCount",
].join(",");
const RELATION_FIELDS = [
  "contexts", "intents", "isInfluential",
  "citedPaper.paperId", "citedPaper.title", "citedPaper.authors", "citedPaper.year", "citedPaper.venue",
  "citedPaper.externalIds", "citedPaper.url", "citedPaper.openAccessPdf", "citedPaper.publicationDate",
  "citedPaper.journal", "citedPaper.publicationVenue",
  "citingPaper.paperId", "citingPaper.title", "citingPaper.authors", "citingPaper.year", "citingPaper.venue",
  "citingPaper.externalIds", "citingPaper.url", "citingPaper.openAccessPdf", "citingPaper.publicationDate",
  "citingPaper.journal", "citingPaper.publicationVenue",
].join(",");

export class SemanticScholarHttpError extends Error {
  constructor(readonly status: number, message = `Semantic Scholar returned HTTP ${status}`) {
    super(message);
    this.name = "SemanticScholarHttpError";
  }
}

export class SemanticScholarTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Semantic Scholar timed out after ${timeoutMs}ms`);
    this.name = "SemanticScholarTimeoutError";
  }
}

export interface SemanticScholarProviderOptions {
  apiKey?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SemanticScholarProposerOptions extends SemanticScholarProviderOptions {
  maxReferences?: number;
  maxCitations?: number;
  onDebug?: (event: SemanticScholarDebugEvent) => void;
}

export interface SemanticScholarDebugEvent {
  document_id: string;
  academic: boolean;
  resolved_paper_id: string | null;
  resolved_by: AcademicIdentity["method"] | null;
  references: number;
  citations: number;
  partial_failure: "references" | "citations" | null;
}

interface SemanticScholarPaper {
  paperId: string;
  metadata: AcademicPaperMetadata;
}

interface SemanticScholarRelation {
  paper: SemanticScholarPaper;
  contexts: string[];
  intents: string[];
  isInfluential: boolean | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((x): x is string => x !== null) : [];
}

function authors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = record(entry);
    const name = text(parsed?.name);
    return name ? [name] : [];
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 3000 ? value : null;
}

function metadataFromPaper(raw: unknown): SemanticScholarPaper | null {
  const paper = record(raw);
  const paperId = text(paper?.paperId);
  if (!paperId) return null;
  const externalIds = record(paper?.externalIds);
  const doi = text(externalIds?.DOI);
  const arxiv = text(externalIds?.ArXiv) ?? text(externalIds?.ARXIV);
  const directUrl = text(paper?.url);
  const openAccess = record(paper?.openAccessPdf);
  const openAccessUrl = text(openAccess?.url);
  const metadata: AcademicPaperMetadata = {
    semantic_scholar_paper_id: paperId,
    doi,
    arxiv_id: arxiv,
    title: text(paper?.title),
    authors: authors(paper?.authors),
    year: numberOrNull(paper?.year),
    publication_date: text(paper?.publicationDate),
    venue: text(paper?.venue) ?? text(record(paper?.journal)?.name) ?? text(record(paper?.publicationVenue)?.name),
    // S2 currently exposes DOI, arXiv, OA and its own record URL. Prefer a durable paper source;
    // the Semantic Scholar record remains an explicit fallback when no canonical source is known.
    canonical_url: doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : openAccessUrl ?? directUrl ?? `https://www.semanticscholar.org/paper/${paperId}`,
  };
  try {
    metadata.canonical_url = canonicalUrl(new URL(metadata.canonical_url ?? `https://www.semanticscholar.org/paper/${paperId}`).toString());
  } catch {
    metadata.canonical_url = `https://www.semanticscholar.org/paper/${paperId}`;
  }
  return { paperId, metadata };
}

function relationFrom(raw: unknown, direction: CitationDirection): SemanticScholarRelation | null {
  const relation = record(raw);
  const paper = metadataFromPaper(relation?.[direction === "references" ? "citedPaper" : "citingPaper"]);
  if (!paper) return null;
  return {
    paper,
    contexts: strings(relation?.contexts),
    intents: strings(relation?.intents),
    isInfluential: typeof relation?.isInfluential === "boolean" ? relation.isInfluential : null,
  };
}

function responseData(value: unknown): unknown[] {
  const parsed = record(value);
  return Array.isArray(parsed?.data) ? parsed.data : [];
}

/** Official Semantic Scholar Academic Graph API client. It never scrapes paper pages. */
export class SemanticScholarProvider {
  readonly kind = "semantic-scholar" as const;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SemanticScholarProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async lookup(identity: AcademicIdentity): Promise<SemanticScholarPaper | null> {
    if (identity.method === "title_author") return this.lookupTitleAuthor(identity);
    const id = identity.method === "doi" ? `DOI:${identity.value}`
      : identity.method === "arxiv" ? `ARXIV:${identity.value}`
        : identity.method === "scholarly_url" ? `URL:${identity.value}`
          : identity.value;
    const value = await this.getJson(`/paper/${encodeURIComponent(id)}`, { fields: PAPER_FIELDS }, true);
    return metadataFromPaper(value);
  }

  async references(paperId: string, limit: number): Promise<SemanticScholarRelation[]> {
    return this.relations(paperId, "references", limit);
  }

  async citations(paperId: string, limit: number): Promise<SemanticScholarRelation[]> {
    return this.relations(paperId, "cited_by", limit);
  }

  private async lookupTitleAuthor(identity: Extract<AcademicIdentity, { method: "title_author" }>): Promise<SemanticScholarPaper | null> {
    // This fallback is intentionally exact after normalization and requires an author surname.
    // A title-only fuzzy API result never gets mapped into Ariadne's graph.
    if (!identity.authors.length) return null;
    const value = await this.getJson("/paper/search", { query: identity.title, limit: "3", fields: PAPER_FIELDS }, false);
    const wantedTitle = academicTitleKey(identity.title);
    const surnames = new Set(identity.authors.map((author) => academicTitleKey(author).split(" ").at(-1)).filter(Boolean));
    for (const raw of responseData(value)) {
      const paper = metadataFromPaper(raw);
      if (!paper || academicTitleKey(paper.metadata.title ?? "") !== wantedTitle) continue;
      const candidateSurnames = new Set((paper.metadata.authors ?? []).map((author) => academicTitleKey(author).split(" ").at(-1)).filter(Boolean));
      if (![...surnames].some((surname) => candidateSurnames.has(surname))) continue;
      if (identity.year !== null && paper.metadata.year !== null && identity.year !== paper.metadata.year) continue;
      return paper;
    }
    return null;
  }

  private async relations(paperId: string, direction: CitationDirection, limit: number): Promise<SemanticScholarRelation[]> {
    const endpoint = direction === "references" ? "references" : "citations";
    const value = await this.getJson(`/paper/${encodeURIComponent(paperId)}/${endpoint}`, {
      fields: RELATION_FIELDS,
      limit: String(Math.min(1_000, Math.max(0, Math.floor(limit)))),
      offset: "0",
    }, false);
    return responseData(value).map((entry) => relationFrom(entry, direction)).filter((entry): entry is SemanticScholarRelation => entry !== null);
  }

  private async getJson(path: string, query: Record<string, string>, notFoundIsNull: boolean): Promise<unknown | null> {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers["x-api-key"] = this.apiKey;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new SemanticScholarTimeoutError(this.timeoutMs);
        throw error;
      }
      if (response.status === 404 && notFoundIsNull) return null;
      if (!response.ok) throw new SemanticScholarHttpError(response.status);
      try {
        return await response.json();
      } catch {
        throw new Error("Semantic Scholar returned invalid JSON");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Conditional proposal adapter for recursive traversal. Semantic Scholar supplies only explicit
 * citation-network facts; it does not score, validate, or otherwise claim provenance.
 */
export class SemanticScholarProposer implements UpstreamSourceProposer {
  readonly kind = "semantic-scholar" as const;
  private readonly maxReferences: number;
  private readonly maxCitations: number;

  constructor(
    private readonly provider: SemanticScholarProvider,
    private readonly options: SemanticScholarProposerOptions = {},
  ) {
    this.maxReferences = Math.max(0, Math.min(1_000, Math.floor(options.maxReferences ?? 10)));
    this.maxCitations = Math.max(0, Math.min(1_000, Math.floor(options.maxCitations ?? 10)));
  }

  async analyze(document: CandidateDocument): Promise<UpstreamAnalysis> {
    const identity = identifyAcademicPaper(document);
    if (!identity) {
      this.options.onDebug?.({ document_id: document.id, academic: false, resolved_paper_id: null, resolved_by: null, references: 0, citations: 0, partial_failure: null });
      return [];
    }
    const resolved = await this.provider.lookup(identity);
    if (!resolved) {
      this.options.onDebug?.({ document_id: document.id, academic: true, resolved_paper_id: null, resolved_by: identity.method, references: 0, citations: 0, partial_failure: null });
      return [];
    }
    const [references, citations] = await Promise.allSettled([
      this.maxReferences ? this.provider.references(resolved.paperId, this.maxReferences) : Promise.resolve([]),
      this.maxCitations ? this.provider.citations(resolved.paperId, this.maxCitations) : Promise.resolve([]),
    ]);
    if (references.status === "rejected" && citations.status === "rejected") {
      throw new Error("Semantic Scholar reference and citation lookups both failed");
    }
    const referenceRows = references.status === "fulfilled" ? references.value : [];
    const citationRows = citations.status === "fulfilled" ? citations.value : [];
    const partialFailure = references.status === "rejected" ? "references" : citations.status === "rejected" ? "citations" : null;
    this.options.onDebug?.({
      document_id: document.id, academic: true, resolved_paper_id: resolved.paperId, resolved_by: identity.method,
      references: referenceRows.length, citations: citationRows.length, partial_failure: partialFailure,
    });
    return [
      ...referenceRows.map((row) => this.proposal(resolved.paperId, identity.method, row, "references")),
      ...citationRows.map((row) => this.proposal(resolved.paperId, identity.method, row, "cited_by")),
    ];
  }

  private proposal(resolvedPaperId: string, resolvedBy: AcademicIdentity["method"], row: SemanticScholarRelation, direction: CitationDirection): UpstreamProposal {
    const citation_metadata: CitationProviderMetadata = {
      provider: "semantic-scholar",
      resolved_paper_id: resolvedPaperId,
      resolved_by: resolvedBy,
      paper: row.paper.metadata,
      contexts: row.contexts,
      intents: row.intents,
      is_influential: row.isInfluential,
    };
    return {
      url: row.paper.metadata.canonical_url,
      title: row.paper.metadata.title ?? null,
      author: row.paper.metadata.authors?.join(", ") ?? null,
      published: row.paper.metadata.publication_date ?? (row.paper.metadata.year ? `${row.paper.metadata.year}-01-01` : null),
      relationship_kind: "citation",
      citation_direction: direction,
      citation_metadata,
      discovered_by: ["semantic-scholar"],
    };
  }
}

export function createSemanticScholarProposer(config: { apiKey: string | null; maxReferences: number; maxCitations: number; timeoutMs: number }): SemanticScholarProposer {
  return new SemanticScholarProposer(new SemanticScholarProvider({ apiKey: config.apiKey, timeoutMs: config.timeoutMs }), {
    maxReferences: config.maxReferences,
    maxCitations: config.maxCitations,
    timeoutMs: config.timeoutMs,
  });
}
