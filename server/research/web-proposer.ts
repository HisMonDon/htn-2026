import { fitQuery } from "./discovery";
import { canonicalUrl, type CandidateDocument } from "./extract";
import { BraveSearchProvider, type SearchHit, type SearchProvider } from "./providers";
import { canonicalText, extractCaseNames, jaccard } from "./text";
import type { UpstreamProposal, UpstreamSourceProposer } from "./traversal";

/**
 * Independent web-retrieval proposer. It turns a document's distinctive text into a few targeted
 * search queries, ranks the results cheaply, and hands the best URLs to traversal as ordinary
 * `UpstreamProposal`s. It has no say in whether a provenance edge exists: every URL it returns is
 * fetched, extracted and scored by the same deterministic validator as a GPTZero proposal, and the
 * ranking score below is discarded rather than turned into confidence.
 */

export const WEB_SEARCH_CHANNEL = "web-search";

export interface WebSearchLimits {
  /** Targeted queries issued per analyzed document. */
  maxQueries: number;
  /** Results requested from the search provider per query. */
  resultsPerQuery: number;
  /** Unique candidates proposed per analyzed document, after ranking. */
  maxCandidates: number;
}

export const DEFAULT_WEB_SEARCH_LIMITS: WebSearchLimits = { maxQueries: 5, resultsPerQuery: 4, maxCandidates: 10 };

/** Only the claim-bearing opening of a document is mined for queries. */
const MAX_SOURCE_CHARS = 2000;
const FRAGMENT_WORDS = 8;

/** Words that carry no search value on their own: function words plus generic claim boilerplate. */
const GENERIC = new Set(
  ("a about after all also an and any are as at be because been before between both but by can could did do does during each for from had has have how " +
    "however i if in including into is it its just many may more most much no not of on one only or other our over she should so some such than that the their " +
    "them then there these they this those three to too two four five very was we were what when where which who whom why will with would you your " +
    "says said say relies relied motion decision decisions case cases court similar circumstances according granted several various first new").split(" "),
);

const STOP_BRIDGE = new Set(["of", "the", "for", "and", "de", "la"]);

export interface WebQueryPlan {
  /** Ordered, de-duplicated, length-fitted queries; at most `maxQueries`. */
  queries: string[];
  /** Exact strings whose presence in a result's title/snippet is strong ranking evidence. */
  phrases: string[];
  /** Distinctive lowercase words (party names, entities) a result should share with the document. */
  anchors: string[];
}

function words(value: string): string[] {
  return canonicalText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function isContentWord(word: string): boolean {
  return word.length >= 3 && !GENERIC.has(word) && !/\d/.test(word);
}

function trimPunctuation(value: string): string {
  return value.replace(/^[^\p{L}\p{N}"]+|[^\p{L}\p{N}"]+$/gu, "");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Runs of adjacent content words ("early termination", "supervised release"), split at punctuation. */
function topicRuns(text: string): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  const close = () => {
    if (current.length) runs.push(current);
    current = [];
  };
  for (const raw of text.split(/\s+/)) {
    if (raw === "¦") {
      close();
      continue;
    }
    const word = raw.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, "");
    if (word && isContentWord(word)) current.push(word);
    else close();
    if (/[,;:.!?)]$/.test(raw)) close();
  }
  close();
  return runs;
}

function topicWords(runs: string[][]): string[] {
  const chosen = runs
    .map((run, index) => ({ run, index, size: run.join("").length }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  return chosen.flatMap((entry) => entry.run).slice(0, 4);
}

function capitalizedEntities(text: string): string[] {
  const found: string[] = [];
  const pattern = /\p{Lu}[\p{L}\p{N}'’.-]*(?:\s+(?:(?:of|the|for|and|de|la)\s+)?\p{Lu}[\p{L}\p{N}'’.-]*){0,3}/gu;
  for (const match of text.matchAll(pattern)) {
    let parts = match[0].split(/\s+/).map(trimPunctuation).filter(Boolean);
    // A capitalized sentence opener ("The", "In") is grammar, not a name.
    while (parts.length && (GENERIC.has(parts[0]!.toLowerCase()) || STOP_BRIDGE.has(parts[0]!.toLowerCase()))) parts = parts.slice(1);
    while (parts.length && STOP_BRIDGE.has(parts.at(-1)!.toLowerCase())) parts = parts.slice(0, -1);
    if (!parts.length) continue;
    const preceding = text.slice(0, match.index!).trimEnd().slice(-1);
    const sentenceInitial = preceding === "" || /[.!?¦]/.test(preceding);
    if (parts.length === 1 && (sentenceInitial || parts[0]!.length < 4)) continue;
    if (parts.every((part) => GENERIC.has(part.toLowerCase()))) continue;
    found.push(parts.join(" "));
  }
  return unique(found);
}

/** The most distinctive contiguous window of words: rare-looking words, digits and mid-sentence capitals score higher. */
function distinctiveFragment(text: string): string | null {
  let best: { score: number; words: string[] } | null = null;
  for (const segment of text.split("¦")) {
    const segmentWords = segment.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    if (segmentWords.length < 5) continue;
    const size = Math.min(FRAGMENT_WORDS, segmentWords.length);
    for (let start = 0; start + size <= segmentWords.length; start += 1) {
      const window = segmentWords.slice(start, start + size);
      let score = 0;
      let distinctive = 0;
      for (const [offset, word] of window.entries()) {
        const bare = word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        if (!bare || GENERIC.has(bare)) continue;
        distinctive += 1;
        score += 0.4 + (Math.min(bare.length, 12) / 12) * 0.6;
        if (/\d/.test(bare)) score += 0.5;
        if (offset > 0 && /^\p{Lu}/u.test(word)) score += 0.3;
      }
      if (distinctive >= 3 && (!best || score > best.score)) best = { score, words: window };
    }
  }
  if (!best) return null;
  const fragment = best.words.join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/"/g, "");
  return fragment || null;
}

/** A query with fewer than two informative words would return generic noise; never spend a request on it. */
function informative(query: string): boolean {
  return words(query.replace(/"/g, " ")).filter(isContentWord).length >= 2 || /\d/.test(query);
}

/**
 * Deterministic query generation. Priority order (later items are dropped first by the cap):
 * quoted passages, each named case with the claim's topic words, the case surnames together, the
 * most distinctive exact fragment, URLs the document mentions, then other named entities.
 */
export function planWebQueries(document: CandidateDocument, limits: Pick<WebSearchLimits, "maxQueries"> = DEFAULT_WEB_SEARCH_LIMITS): WebQueryPlan {
  const raw = (document.passage?.trim() || document.text).slice(0, MAX_SOURCE_CHARS);
  const text = canonicalText(raw);
  if (!text) return { queries: [], phrases: [], anchors: [] };

  const cases = extractCaseNames(text).slice(0, 4);
  const surnames = unique(cases.map((name) => name.split(/\sv\.\s/)[1]?.replace(/[^\p{L}\p{N}'’. -]+/gu, "").trim() ?? "").filter(Boolean));
  // Case names are searched as units, so they are masked out (with "¦", a character that does not
  // occur in ordinary prose or citations) before mining topic words and fragments.
  let masked = text;
  for (const name of cases) masked = masked.split(name).join(" ¦ ");

  const topic = topicWords(topicRuns(masked));
  /** Topic words that add something beyond the name being searched. */
  const withTopic = (name: string) => {
    const known = new Set(words(name));
    const extra = topic.filter((word) => !known.has(word)).join(" ");
    return extra ? `"${name}" ${extra}` : `"${name}"`;
  };
  const quoted = unique([...text.matchAll(/"([^"]{10,240})"/g)].map((match) => match[1]!.trim()).filter((value) => value.split(/\s+/).length >= 3)).slice(0, 2);
  const own = new Set([document.url, ...document.mirror_urls].map(canonicalUrl));
  const urls = unique([...raw.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((match) => match[0].replace(/[.,;:]+$/, "")).filter((url) => !own.has(canonicalUrl(url)))).slice(0, 1);
  const entities = capitalizedEntities(masked).filter((entity) => !cases.some((name) => name.includes(entity))).slice(0, 4);
  const fragment = distinctiveFragment(masked);

  const candidates: string[] = [
    ...quoted.map((phrase) => `"${phrase}"`),
    ...cases.map(withTopic),
    ...(surnames.length > 1 ? [surnames.join(" ")] : []),
    ...(fragment ? [`"${fragment}"`] : []),
    ...urls.map((url) => `"${url}"`),
    ...entities.map(withTopic),
  ];

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    const query = fitQuery(candidate.trim());
    const key = query.toLowerCase();
    if (seen.has(key) || !informative(query)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= limits.maxQueries) break;
  }

  const anchors = unique([...surnames, ...entities].flatMap((value) => words(value)).filter(isContentWord));
  return {
    queries,
    phrases: unique([...cases, ...quoted, ...(fragment ? [fragment] : []), ...entities.filter((entity) => entity.includes(" "))].map((phrase) => words(phrase).join(" ")).filter(Boolean)),
    anchors: anchors.length ? anchors : topic,
  };
}

export interface RankedWebHit {
  hit: SearchHit;
  score: number;
}

interface CollectedHit {
  hit: SearchHit;
  bestRank: number;
  queries: Set<string>;
}

function hostBonus(url: string): number {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(gov|edu)$|\.ac\.[a-z]{2}$|(^|\.)courtlistener\.com$/i.test(host) ? 0.3 : 0;
  } catch {
    return 0;
  }
}

/**
 * Cheap, deterministic pre-fetch ranking. The score only orders and prunes candidates so that the
 * expensive fetch/validation budget is spent on the likeliest ones; it is never surfaced or reused
 * as provenance confidence.
 */
export function rankWebHits(collected: readonly CollectedHit[], plan: WebQueryPlan, documentPassage: string, maxCandidates: number): RankedWebHit[] {
  const passageWords = new Set(words(documentPassage).slice(0, 80));
  const ranked: RankedWebHit[] = [];
  for (const { hit, bestRank, queries } of collected) {
    const haystack = words(`${hit.title} ${hit.snippet ?? ""} ${hit.url}`);
    const haystackText = ` ${haystack.join(" ")} `;
    const haystackSet = new Set(haystack);
    const phraseHits = plan.phrases.filter((phrase) => haystackText.includes(` ${phrase} `)).length;
    const anchorHits = plan.anchors.filter((anchor) => haystackSet.has(anchor)).length;
    // With anything to anchor on, a result sharing none of it is noise and is not worth a fetch.
    if ((plan.phrases.length > 0 || plan.anchors.length > 0) && phraseHits === 0 && anchorHits === 0) continue;

    const anchorRatio = plan.anchors.length ? anchorHits / plan.anchors.length : 0;
    const titleSimilarity = jaccard(new Set(words(hit.title)), passageWords);
    const score =
      phraseHits * 3 + anchorRatio * 2 + titleSimilarity + 0.5 / (1 + bestRank) + Math.min(queries.size - 1, 3) * 0.4 + hostBonus(hit.url);
    ranked.push({ hit, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.hit.url.localeCompare(b.hit.url)).slice(0, maxCandidates);
}

export interface WebSearchDebugEvent {
  document_id: string;
  queries: string[];
  failed_queries: string[];
  hits_received: number;
  proposed_urls: string[];
}

export interface WebSearchProposerOptions extends Partial<WebSearchLimits> {
  onDebug?: (event: WebSearchDebugEvent) => void;
}

export class WebSearchProposer implements UpstreamSourceProposer {
  readonly kind = "web-search" as const;
  private readonly limits: WebSearchLimits;

  constructor(
    private readonly search: SearchProvider,
    private readonly options: WebSearchProposerOptions = {},
  ) {
    this.limits = {
      maxQueries: options.maxQueries ?? DEFAULT_WEB_SEARCH_LIMITS.maxQueries,
      resultsPerQuery: options.resultsPerQuery ?? DEFAULT_WEB_SEARCH_LIMITS.resultsPerQuery,
      maxCandidates: options.maxCandidates ?? DEFAULT_WEB_SEARCH_LIMITS.maxCandidates,
    };
  }

  async analyze(document: CandidateDocument): Promise<readonly UpstreamProposal[]> {
    const plan = planWebQueries(document, this.limits);
    if (plan.queries.length === 0) return [];

    const own = new Set([document.url, ...document.mirror_urls].map(canonicalUrl));
    const collected = new Map<string, CollectedHit>();
    const failedQueries: string[] = [];
    let lastError: unknown = null;
    let hitsReceived = 0;

    // Sequential on purpose: a handful of queries per node, and search APIs commonly rate-limit bursts.
    for (const query of plan.queries) {
      let hits: SearchHit[];
      try {
        hits = await this.search.search(query, this.limits.resultsPerQuery);
      } catch (error) {
        failedQueries.push(query);
        lastError = error;
        continue;
      }
      for (const [rank, hit] of hits.slice(0, this.limits.resultsPerQuery).entries()) {
        hitsReceived += 1;
        let key: string;
        try {
          const url = new URL(hit.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") continue;
          key = canonicalUrl(url.toString());
        } catch {
          continue;
        }
        if (own.has(key)) continue;
        const existing = collected.get(key);
        if (existing) {
          existing.bestRank = Math.min(existing.bestRank, rank);
          existing.queries.add(query);
        } else {
          collected.set(key, { hit, bestRank: rank, queries: new Set([query]) });
        }
      }
    }

    // Every query failing is a provider failure, not "the web has nothing"; one bad query is not.
    if (failedQueries.length === plan.queries.length) {
      throw lastError instanceof Error ? lastError : new Error("web search failed");
    }

    const selected = rankWebHits([...collected.values()], plan, document.passage || document.text, this.limits.maxCandidates);
    const proposals: UpstreamProposal[] = selected.map(({ hit }) => ({
      url: hit.url,
      title: hit.title || null,
      published: hit.published,
      discovered_by: [WEB_SEARCH_CHANNEL],
    }));
    this.options.onDebug?.({
      document_id: document.id,
      queries: plan.queries,
      failed_queries: failedQueries,
      hits_received: hitsReceived,
      proposed_urls: proposals.map((proposal) => proposal.url!),
    });
    return proposals;
  }
}

/** The production web proposer, or null when no search API key is configured (GPTZero-only behavior). */
export function createWebSearchProposer(
  config: { apiKey: string | null; timeoutMs?: number } & Partial<WebSearchLimits>,
  options: Pick<WebSearchProposerOptions, "onDebug"> = {},
): WebSearchProposer | null {
  if (!config.apiKey) return null;
  return new WebSearchProposer(new BraveSearchProvider(config.apiKey, { timeoutMs: config.timeoutMs }), {
    maxQueries: config.maxQueries,
    resultsPerQuery: config.resultsPerQuery,
    maxCandidates: config.maxCandidates,
    onDebug: options.onDebug,
  });
}
