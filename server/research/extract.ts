import * as cheerio from "cheerio";
import type { z } from "zod";
import type { TimestampSource } from "../../shared/tree";
import { canonicalText, extractCaseNames, matchFabricated, matchKey } from "./text";

/** Everything Lineage knows about one discovered page, derived from its HTML. */
export interface CandidateDocument {
  id: string;
  url: string;
  publisher: string;
  title: string;
  timestamp: string | null;
  timestamp_source: z.infer<typeof TimestampSource>;
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

function toIso(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const time = Date.parse(dateOnly);
  if (Number.isNaN(time)) return null;
  const year = new Date(time).getUTCFullYear();
  if (year < 1990 || time > Date.now() + 86_400_000) return null;
  return new Date(time).toISOString();
}

function jsonLdDate(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = jsonLdDate(item);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.datePublished === "string") return record.datePublished;
  if (record["@graph"]) return jsonLdDate(record["@graph"]);
  return null;
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
): { timestamp: string | null; source: CandidateDocument["timestamp_source"] } {
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
    if (value) return { timestamp: value, source: "meta" };
  }
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const value = toIso(jsonLdDate(JSON.parse($(element).text())));
      if (value) return { timestamp: value, source: "json-ld" };
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  const timeValue = toIso($("article time[datetime], main time[datetime], time[datetime]").first().attr("datetime"));
  if (timeValue) return { timestamp: timeValue, source: "time-element" };
  const urlDate = new URL(url).pathname.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (urlDate) {
    const value = toIso(`${urlDate[1]}-${urlDate[2]}-${urlDate[3]}`);
    if (value) return { timestamp: value, source: "url" };
  }
  const searchValue = toIso(searchPublished);
  if (searchValue) return { timestamp: searchValue, source: "search-result" };
  return { timestamp: null, source: "none" };
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
  text: string;
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
    url: parsed.url,
    publisher: parsed.publisher,
    title: parsed.title,
    timestamp: parsed.timestamp,
    timestamp_source: parsed.timestamp_source,
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

  const { timestamp, source } = findTimestamp($, canonical, searchPublished);

  const content = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  content.find("nav, header, footer, script, style, aside").remove();

  const text = content
    .find("p, li, blockquote")
    .toArray()
    .map((element) => canonicalText($(element).text()))
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
    text,
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
