import { assembleDocument, canonicalUrl, parseHtmlPage, type CandidateDocument, type ParsedDocument } from "./extract";
import { canonicalizeDocuments } from "./canonicalize";
import { ingestFetchedPage } from "./ingestion";
import { fetchSourceDetailed, type FetchedPage, type PageFetcher, type SearchProvider, type SourceReference, type SourceResolver } from "./providers";
import { canonicalText, extractCaseNames, matchKey, tokens } from "./text";

/**
 * Candidate discovery starts from an upstream source proposal whenever one exists. A valid URL is
 * fetched directly; source resolution is only a fallback for an incomplete or unusable proposal.
 * Legacy claim-only calls retain the query path because they have no source to fetch.
 */

export interface DiscoveryInput {
  claim: string;
  seedUrl?: string | null;
  /** Rich upstream proposal; takes precedence over the legacy URL-only seed. */
  seedSource?: SourceReference | null;
  /** Known fabricated citations. Derived from the claim (and seed page) when omitted. */
  fabricated?: string[];
}

export interface DiscoveryOptions {
  maxDocuments?: number;
  maxLinkDepth?: number;
  resultsPerQuery?: number;
  maxPhraseQueries?: number;
}

export interface DiscoveryResult {
  documents: CandidateDocument[];
  fabricated: string[];
  queries: string[];
  failedQueries: string[];
  /** Fetched but could not be turned into a document, e.g. an encrypted or scanned PDF. Nonfatal. */
  extractionFailures: string[];
  diagnostics: ResearchDiagnostic[];
  fetched: number;
  seedId: string | null;
}

export interface ResearchDiagnostic {
  stage: "resolution" | "fetch" | "extraction";
  source: string | null;
  category: string;
  message: string;
  recoverable: boolean;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the their this to was were which with were real decisions decision case cases court".split(
    " ",
  ),
);

export function claimTerms(claim: string, fabricated: string[]): string[] {
  let rest = canonicalText(claim);
  for (const citation of fabricated) rest = rest.replace(citation, " ");
  return [...new Set(tokens(rest).filter((word) => word.length > 3 && !STOPWORDS.has(word)))].slice(0, 8);
}

/** Search APIs commonly cap query length. Trim phrases at a word boundary. */
export const MAX_QUERY_LENGTH = 200;
export function fitQuery(query: string): string {
  if (query.length <= MAX_QUERY_LENGTH) return query;
  const quoted = query.startsWith('"') && query.endsWith('"');
  const inner = quoted ? query.slice(1, -1) : query;
  const budget = MAX_QUERY_LENGTH - (quoted ? 2 : 0);
  const cut = inner.slice(0, budget + 1);
  const trimmed = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim();
  return quoted ? `"${trimmed}"` : trimmed;
}

/**
 * Sentences of 8+ words with no citations, taken only from the paragraphs around the fabricated
 * citations (not navigation, paywall or related-link boilerplate): fingerprints for finding copies.
 */
function fingerprintSentences(doc: CandidateDocument, fabricated: string[]): string[] {
  const paragraphs = doc.text.split(/\n/);
  const keys = fabricated.map(matchKey);
  const near = new Set<number>();
  paragraphs.forEach((paragraph, index) => {
    const key = matchKey(paragraph);
    if (keys.some((citation) => key.includes(citation))) [index - 1, index, index + 1].forEach((i) => near.add(i));
  });
  return paragraphs
    .filter((_, index) => near.has(index))
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/[.!?]+$/, ""))
    .filter((sentence) => sentence.split(" ").length >= 8 && extractCaseNames(sentence).length === 0)
    .filter((sentence) => !/["]/.test(sentence));
}

export async function discover(
  input: DiscoveryInput,
  providers: { search: SearchProvider; fetcher: PageFetcher; resolver?: SourceResolver },
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const maxDocuments = options.maxDocuments ?? 30;
  const maxLinkDepth = options.maxLinkDepth ?? 2;
  const perQuery = options.resultsPerQuery ?? 8;
  const maxPhraseQueries = options.maxPhraseQueries ?? 3;

  // URLs remain distinct through discovery so their origin and exact link evidence are retained.
  // Exact-content grouping happens only after deterministic extraction and before retrieval.
  const documents = new Map<string, CandidateDocument>();
  const queries: string[] = [];
  const failedQueries: string[] = [];
  const extractionFailures: string[] = [];
  const diagnostics: ResearchDiagnostic[] = [];
  const attempted = new Set<string>();
  let fetched = 0;
  let fabricated = input.fabricated?.length ? [...input.fabricated] : extractCaseNames(input.claim);
  // Cached per document so the final re-extraction pass (below) never re-downloads or re-parses.
  const pages = new Map<string, { parsed: ParsedDocument; via: string }>();

  const diagnosticSource = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };

  async function visitFetched(page: FetchedPage, via: string, published: string | null): Promise<CandidateDocument | null> {
    const key = canonicalUrl(page.url);
    const existing = documents.get(key);
    if (existing) {
      if (!existing.discovered_via.includes(via)) existing.discovered_via.push(via);
      return null;
    }
    if (documents.size >= maxDocuments) return null;
    attempted.add(key);
    fetched += 1;

    const ingested = await ingestFetchedPage(page, {
      fabricated,
      claimTerms: claimTerms(input.claim, fabricated),
      discoveredVia: via,
      published,
    });
    if (!ingested.ok) {
      diagnostics.push({
        stage: ingested.stage,
        source: diagnosticSource(page.url),
        category: ingested.category,
        message: ingested.detail ?? ingested.reason,
        recoverable: ingested.recoverable,
      });
      if (ingested.stage === "extraction") {
        extractionFailures.push(`${page.url}: ${ingested.reason}${ingested.detail ? ` (${ingested.detail})` : ""}`);
      }
      return null;
    }
    const doc = ingested.document;
    documents.set(doc.url, doc);
    pages.set(doc.url, { parsed: ingested.parsed, via });
    return doc;
  }

  async function visit(url: string, via: string, published: string | null): Promise<CandidateDocument | null> {
    const key = canonicalUrl(url);
    const existing = documents.get(key);
    if (existing) {
      if (!existing.discovered_via.includes(via)) existing.discovered_via.push(via);
      return null;
    }
    if (attempted.has(key) || documents.size >= maxDocuments) return null;
    attempted.add(key);
    let page: FetchedPage | null;
    try {
      if (providers.fetcher.fetchDetailed) {
        const result = await providers.fetcher.fetchDetailed(url);
        if (!result.ok) {
          diagnostics.push({
            stage: result.failure.stage,
            source: diagnosticSource(result.failure.url),
            category: result.failure.category,
            message: result.failure.message,
            recoverable: result.failure.recoverable,
          });
          return null;
        }
        page = result.page;
      } else {
        page = await providers.fetcher.fetch(url);
      }
    } catch {
      diagnostics.push({
        stage: "fetch",
        source: diagnosticSource(url),
        category: "network-error",
        message: "source network request failed",
        recoverable: true,
      });
      return null;
    }
    if (!page) {
      diagnostics.push({
        stage: "fetch",
        source: diagnosticSource(url),
        category: "http-404",
        message: "source was not found",
        recoverable: false,
      });
      return null;
    }
    return page ? visitFetched(page, via, published) : null;
  }

  let seedUrl: string | null = null;
  const source = input.seedSource ?? (input.seedUrl ? { url: input.seedUrl } : null);
  if (source) {
    const sourceResult = await fetchSourceDetailed(source, { fetcher: providers.fetcher, resolver: providers.resolver });
    if (sourceResult.fetched) {
      const seed = await visitFetched(sourceResult.fetched.page, sourceResult.fetched.resolved ? "resolved source" : "seed", null);
      if (seed) {
        seedUrl = seed.url;
        if (fabricated.length === 0) fabricated = seed.case_names;
      }
    } else if (sourceResult.failure) {
      diagnostics.push({
        stage: sourceResult.failure.stage,
        source: diagnosticSource(sourceResult.failure.url),
        category: sourceResult.failure.category,
        message: sourceResult.failure.message,
        recoverable: sourceResult.failure.recoverable,
      });
    }
  }

  // A search provider is a claim-only fallback. When an upstream source was supplied, it has
  // already been fetched directly and (only if needed) resolved exactly once above.
  const useSearchDiscovery = !source;
  const terms = claimTerms(input.claim, fabricated);
  const firstRound = [
    ...fabricated.map((citation) => `"${citation}"`),
    ...(fabricated.length > 1 ? [fabricated.join(" ")] : []),
    ...(terms.length ? [[...fabricated.slice(0, 1), ...terms].join(" ")] : []),
  ];

  async function runQuery(raw: string) {
    const query = fitQuery(raw);
    if (queries.includes(query)) return;
    queries.push(query);
    let hits: Awaited<ReturnType<SearchProvider["search"]>>;
    try {
      hits = await providers.search.search(query, perQuery);
    } catch {
      // One failed search should not end the investigation; the query stays listed as failed.
      failedQueries.push(`${query} (search failed)`);
      return;
    }
    for (const hit of hits) await visit(hit.url, `search: ${query}`, hit.published);
  }

  if (useSearchDiscovery) {
    for (const query of firstRound) await runQuery(query);
  }

  // Follow outbound links from pages that repeat a fabricated citation.
  const isRelevant = (doc: CandidateDocument) => doc.fabricated_citations.length > 0;
  let frontier = [...documents.values()].filter(isRelevant);
  for (let depth = 1; depth <= maxLinkDepth && frontier.length; depth += 1) {
    const next: CandidateDocument[] = [];
    for (const doc of frontier) {
      for (const link of doc.outbound_links) {
        const found = await visit(link, `link from ${doc.id}`, null);
        if (found && isRelevant(found)) next.push(found);
      }
    }
    frontier = next;
  }

  // Search for distinctive sentences to find copies that neither cite nor link.
  if (useSearchDiscovery) {
    const counts = new Map<string, number>();
    const relevant = [...documents.values()].filter(isRelevant);
    for (const doc of relevant) {
      for (const sentence of new Set(fingerprintSentences(doc, fabricated).map(matchKey))) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    }
    const phrases = [...counts.entries()]
      .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
      .map(([sentence]) => sentence)
      .slice(0, maxPhraseQueries);
    for (const phrase of phrases) await runQuery(`"${phrase}"`);
  }

  // Re-assemble with the final citation list so every page is judged by the same criteria. The
  // cached ParsedDocument means this never re-downloads or re-parses a PDF or HTML page.
  const finalTerms = claimTerms(input.claim, fabricated);
  const finalDocs = [...documents.values()].map((doc) => {
    const page = pages.get(doc.url)!;
    const again = assembleDocument(page.parsed, { fabricated, claimTerms: finalTerms, discoveredVia: page.via });
    return { ...again, discovered_via: doc.discovered_via };
  });

  const canonicalized = canonicalizeDocuments(finalDocs);
  return {
    documents: canonicalized.documents,
    fabricated,
    queries,
    failedQueries,
    extractionFailures: [...extractionFailures].sort((a, b) => a.localeCompare(b)),
    diagnostics: [...diagnostics].sort(
      (a, b) =>
        (a.source ?? "").localeCompare(b.source ?? "") ||
        a.stage.localeCompare(b.stage) ||
        a.category.localeCompare(b.category) ||
        a.message.localeCompare(b.message),
    ),
    fetched,
    seedId: seedUrl ? (canonicalized.idByUrl.get(seedUrl) ?? null) : null,
  };
}
