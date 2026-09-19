import { canonicalUrl, extractDocument, type CandidateDocument } from "./extract";
import type { PageFetcher, SearchProvider } from "./providers";
import { canonicalText, extractCaseNames, matchKey, tokens } from "./text";

/**
 * Candidate discovery. Starts from a claim (and optionally a seed page), searches for the
 * fabricated citations and the claim's wording, follows outbound links from relevant pages, then
 * searches again for distinctive sentences to find copies. Nothing about any particular incident
 * is built in.
 */

export interface DiscoveryInput {
  claim: string;
  seedUrl?: string | null;
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
  fetched: number;
  seedId: string | null;
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

/** Search APIs cap query length (Browserbase Search: 200 characters). Trim phrases at a word boundary. */
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
  providers: { search: SearchProvider; fetcher: PageFetcher },
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const maxDocuments = options.maxDocuments ?? 30;
  const maxLinkDepth = options.maxLinkDepth ?? 2;
  const perQuery = options.resultsPerQuery ?? 8;
  const maxPhraseQueries = options.maxPhraseQueries ?? 3;

  const documents = new Map<string, CandidateDocument>();
  const queries: string[] = [];
  const failedQueries: string[] = [];
  const attempted = new Set<string>();
  let fetched = 0;
  let fabricated = input.fabricated?.length ? [...input.fabricated] : extractCaseNames(input.claim);
  const pages = new Map<string, { html: string; url: string; published: string | null; via: string }>();

  async function visit(url: string, via: string, published: string | null): Promise<CandidateDocument | null> {
    const key = canonicalUrl(url);
    const existing = [...documents.values()].find((doc) => doc.url === key);
    if (existing) {
      if (!existing.discovered_via.includes(via)) existing.discovered_via.push(via);
      return null;
    }
    if (attempted.has(key) || documents.size >= maxDocuments) return null;
    attempted.add(key);
    const page = await providers.fetcher.fetch(url);
    if (!page) return null;
    fetched += 1;
    const doc = extractDocument({
      url: page.url,
      html: page.html,
      fabricated,
      claimTerms: claimTerms(input.claim, fabricated),
      searchPublished: published ?? undefined,
      discoveredVia: via,
    });
    documents.set(doc.id, doc);
    pages.set(doc.id, { html: page.html, url: page.url, published, via });
    return doc;
  }

  let seedId: string | null = null;
  if (input.seedUrl) {
    const seed = await visit(input.seedUrl, "seed", null);
    if (seed) {
      seedId = seed.id;
      if (fabricated.length === 0) fabricated = seed.case_names;
    }
  }

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
    } catch (error) {
      // One failed search should not end the investigation; the query stays listed as failed.
      failedQueries.push(`${query} (${error instanceof Error ? error.message : "failed"})`);
      return;
    }
    for (const hit of hits) await visit(hit.url, `search: ${query}`, hit.published);
  }

  for (const query of firstRound) await runQuery(query);

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

  // Re-extract with the final citation list so every page is judged by the same criteria.
  const finalTerms = claimTerms(input.claim, fabricated);
  const finalDocs = [...documents.values()].map((doc) => {
    const page = pages.get(doc.id)!;
    const again = extractDocument({
      url: page.url,
      html: page.html,
      fabricated,
      claimTerms: finalTerms,
      searchPublished: page.published ?? undefined,
      discoveredVia: page.via,
    });
    return { ...again, discovered_via: doc.discovered_via };
  });

  return {
    documents: finalDocs,
    fabricated,
    queries,
    failedQueries,
    fetched,
    seedId,
  };
}
