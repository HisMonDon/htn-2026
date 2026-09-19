import * as cheerio from "cheerio";
import type { z } from "zod";
import type { TimestampConfidence, TimestampSource } from "../../shared/tree";
import { canonicalDocumentId, contentFingerprint } from "./fingerprint";
import { canonicalText, extractCaseNames, matchFabricated, matchKey } from "./text";
import { selectTimestampEvidence, toIso, urlTimestampEvidence, type TimestampEvidence } from "./timestamps";

/** Everything Lineage knows about one discovered page, derived from its HTML. */
export interface CandidateDocument {
  id: string;
  /** SHA-256 identity for the extracted artifact, independent of where it was hosted. */
  canonical_id: string;
  /** SHA-256 of the narrowly normalized extracted text. */
  content_fingerprint: string;
  url: string;
  /** Other URLs serving this exact artifact. The canonical `url` is not repeated here. */
  mirror_urls: string[];
  publisher: string;
  title: string;
  timestamp: string | null;
  timestamp_source: z.infer<typeof TimestampSource>;
  timestamp_confidence: z.infer<typeof TimestampConfidence>;
  /** Conflicting strong document-date signals, before any graph/link-derived conflict. */
  timestamp_conflict: string | null;
  text: string;
  passage: string;
  outbound_links: string[];
  case_names: string[];
  /** Known fabricated citations this page repeats (canonical spelling). */
  fabricated_citations: string[];
  /** Spelling variants of fabricated citations seen on this page, e.g. "X v. Florez" for "X v. Flores". */
  citation_variants: string[];
  discovered_via: string[];
}

export function documentId(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "").split(".");
  if (host.length > 1) host.pop();
  const slug = `${host.join("-")}${parsed.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 80 ? slug.slice(slug.length - 80).replace(/^-+/, "") : slug;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) parsed.searchParams.delete(key);
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, "").toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function jsonLdDates(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    const dates: string[] = [];
    for (const item of node) {
      dates.push(...jsonLdDates(item));
    }
    return dates;
  }
  const record = node as Record<string, unknown>;
  const dates = typeof record.datePublished === "string" ? [record.datePublished] : [];
  if (record["@graph"]) dates.push(...jsonLdDates(record["@graph"]));
  return dates;
}

function jsonLdPublisher(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = jsonLdPublisher(item);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const publisher = record.publisher as Record<string, unknown> | undefined;
  if (publisher && typeof publisher.name === "string") return publisher.name;
  if (record["@graph"]) return jsonLdPublisher(record["@graph"]);
  return null;
}

function findTimestamp(
  $: cheerio.CheerioAPI,
  url: string,
  searchPublished: string | undefined,
): {
  timestamp: string | null;
  source: CandidateDocument["timestamp_source"];
  confidence: CandidateDocument["timestamp_confidence"];
  conflict: CandidateDocument["timestamp_conflict"];
} {
  const evidence: TimestampEvidence[] = [];
  const metaNames = [
    'meta[property="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
    'meta[name="DC.date.issued"]',
    'meta[name="citation_date"]',
    'meta[itemprop="datePublished"]',
  ];
  for (const selector of metaNames) {
    const value = toIso($(selector).attr("content"));
    if (value) evidence.push({ timestamp: value, source: "meta", confidence: "strong" });
  }
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      for (const raw of jsonLdDates(JSON.parse($(element).text()))) {
        const value = toIso(raw);
        if (value) evidence.push({ timestamp: value, source: "json-ld", confidence: "strong" });
      }
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  for (const element of $("article time[datetime], main time[datetime], time[datetime]").toArray()) {
    const value = toIso($(element).attr("datetime"));
    if (value) evidence.push({ timestamp: value, source: "time-element", confidence: "strong" });
  }
  const urlEvidence = urlTimestampEvidence(url);
  if (urlEvidence) evidence.push(urlEvidence);
  const searchValue = toIso(searchPublished);
  if (searchValue) evidence.push({ timestamp: searchValue, source: "search-result", confidence: "weak" });
  const selected = selectTimestampEvidence(evidence);
  return { timestamp: selected.timestamp, source: selected.source, confidence: selected.confidence, conflict: selected.conflict };
}

/**
 * Fields any acquisition path (HTML today, PDF as of step 6) can produce deterministically, before
 * the claim-specific case-name/passage/citation logic in {@link assembleDocument} runs. Keeping
 * this split means a new content type only has to know how to become a `ParsedDocument`; everything
 * downstream of that is shared, so the provenance scorer never has to know where a document came from.
 */
export interface ParsedDocument {
  url: string;
  title: string;
  publisher: string;
  timestamp: string | null;
  timestamp_source: CandidateDocument["timestamp_source"];
  timestamp_confidence: CandidateDocument["timestamp_confidence"];
  timestamp_conflict: CandidateDocument["timestamp_conflict"];
  text: string;
  /** Optional extractor-specific structure that must participate in exact artifact identity. */
  fingerprint_text?: string;
  outbound_links: string[];
}

export interface AssembleOptions {
  fabricated: string[];
  /** Words from the claim, used to pick the relevant passage when no citation is present. */
  claimTerms: string[];
  discoveredVia: string;
}

/** Case names, fabricated-citation matches and the best passage: the same for every content type. */
export function assembleDocument(parsed: ParsedDocument, options: AssembleOptions): CandidateDocument {
  const fingerprint = contentFingerprint(parsed.fingerprint_text ?? parsed.text);
  const paragraphs = parsed.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const caseNames = extractCaseNames(parsed.text);
  const fabricated = new Set<string>();
  const variants = new Set<string>();
  for (const name of caseNames) {
    const match = matchFabricated(name, options.fabricated);
    if (!match) continue;
    fabricated.add(match.citation);
    if (match.variant) variants.add(name);
  }

  const claimTerms = options.claimTerms.map(matchKey);
  const scored = paragraphs.map((paragraph, index) => {
    const key = matchKey(paragraph);
    const citations = options.fabricated.filter((citation) => key.includes(matchKey(citation))).length;
    const terms = claimTerms.filter((term) => key.includes(term)).length;
    return { paragraph, index, score: citations * 10 + terms };
  });
  const best = [...scored].sort((a, b) => b.score - a.score || a.index - b.index)[0];
  const passage = best && best.score > 0 ? best.paragraph : (paragraphs[0] ?? "");

  return {
    id: documentId(parsed.url),
    canonical_id: canonicalDocumentId(fingerprint),
    content_fingerprint: fingerprint,
    url: parsed.url,
    mirror_urls: [],
    publisher: parsed.publisher,
    title: parsed.title,
    timestamp: parsed.timestamp,
    timestamp_source: parsed.timestamp_source,
    timestamp_confidence: parsed.timestamp_confidence,
    timestamp_conflict: parsed.timestamp_conflict,
    text: parsed.text,
    passage,
    outbound_links: parsed.outbound_links,
    case_names: caseNames,
    fabricated_citations: [...fabricated],
    citation_variants: [...variants],
    discovered_via: [options.discoveredVia],
  };
}

export function parseHtmlPage(url: string, html: string, searchPublished?: string): ParsedDocument {
  const $ = cheerio.load(html);
  const canonical = canonicalUrl(url);
  const title = canonicalText($('meta[property="og:title"]').attr("content") ?? $("title").first().text() ?? $("h1").first().text());

  let publisher = $('meta[property="og:site_name"]').attr("content")?.trim() ?? null;
  if (!publisher) {
    for (const element of $('script[type="application/ld+json"]').toArray()) {
      try {
        publisher = jsonLdPublisher(JSON.parse($(element).text()));
      } catch {
        publisher = null;
      }
      if (publisher) break;
    }
  }
  publisher ||= new URL(canonical).hostname.replace(/^www\./, "");

  const { timestamp, source, confidence, conflict } = findTimestamp($, canonical, searchPublished);

  const content = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  content.find("nav, header, footer, script, style, aside").remove();

  const rawParagraphs = content
    .find("p, li, blockquote")
    .toArray()
    .map((element) => $(element).text());
  const text = rawParagraphs
    .map((paragraph) => canonicalText(paragraph))
    .filter((paragraph) => paragraph.length > 0)
    .join("\n");

  const outbound = new Set<string>();
  content.find("a[href]").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    let resolved: URL;
    try {
      resolved = new URL(href, canonical);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    const link = canonicalUrl(resolved.toString());
    if (link !== canonical) outbound.add(link);
  });

  return {
    url: canonical,
    title,
    publisher,
    timestamp,
    timestamp_source: source,
    timestamp_confidence: confidence,
    timestamp_conflict: conflict,
    text,
    // Matching retains the established canonical text, while identity only collapses whitespace.
    fingerprint_text: rawParagraphs.join("\n"),
    outbound_links: [...outbound],
  };
}

export interface ExtractOptions {
  url: string;
  html: string;
  fabricated: string[];
  /** Words from the claim, used to pick the relevant passage when no citation is present. */
  claimTerms: string[];
  searchPublished?: string;
  discoveredVia: string;
}

export function extractDocument(options: ExtractOptions): CandidateDocument {
  const parsed = parseHtmlPage(options.url, options.html, options.searchPublished);
  return assembleDocument(parsed, {
    fabricated: options.fabricated,
    claimTerms: options.claimTerms,
    discoveredVia: options.discoveredVia,
  });
}
