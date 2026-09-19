import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { canonicalUrl, type ParsedDocument } from "./extract";
import { normalizeFingerprintText } from "./fingerprint";
import { canonicalText } from "./text";
import { looksLikePdfBytes } from "./content-type";
import { parseUnambiguousUsNumericDate, selectTimestampEvidence, toIso, urlTimestampEvidence, type TimestampEvidence } from "./timestamps";

/**
 * Deterministic PDF ingestion. Bytes go through pdf.js (via `unpdf`) for text extraction only -
 * no OCR, no LLM, no visual reconstruction. Failures are structured and nonfatal: a bad PDF drops
 * out of discovery the same way a page that fails to fetch does, without ending the research run.
 */

/** Demo-safe cap. A large PDF should fail extraction cleanly rather than stall or exhaust memory. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Below this many characters of extracted text, treat the PDF as scanned/empty rather than real content. */
const MIN_EXTRACTABLE_TEXT = 40;

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfExtraction {
  ok: true;
  pages: PdfPageText[];
  /** Per-page text normalized only enough for exact artifact identity. */
  fingerprint_pages: PdfPageText[];
  page_count: number;
  /** Page texts joined with a blank line, so page boundaries survive into evidence extraction. */
  text: string;
  /** Semantically labelled PDF metadata dates; generic creation/modification dates are excluded. */
  metadata_dates: string[];
}

/**
 * PDF identity includes its extracted page sequence and page count. A filing repaginated into a
 * different PDF therefore stays separate even when collapsing whitespace makes its visible text
 * look identical to another filing.
 */
export function pdfFingerprintText(extraction: PdfExtraction): string {
  return JSON.stringify({
    page_count: extraction.page_count,
    pages: extraction.fingerprint_pages.map((page) => ({ page: page.page, text: page.text })),
  });
}

export type PdfFailureReason = "pdf-too-large" | "pdf-invalid" | "pdf-no-extractable-text" | "pdf-parse-failed";

export interface PdfFailure {
  ok: false;
  reason: PdfFailureReason;
  detail?: string;
}

/**
 * `CreationDate` and `ModDate` only describe authoring activity, not when a document existed
 * publicly, so they are never promoted to provenance evidence. A PDF may instead contain an
 * explicitly named publication/filing metadata field; retain only those narrow, parseable fields.
 */
function trustedPdfMetadataDates(info: Record<string, unknown>): string[] {
  const trustedKeys = new Set(["publicationdate", "datepublished", "filingdate", "datefiled"]);
  const dates = new Set<string>();
  for (const [key, value] of Object.entries(info)) {
    if (!trustedKeys.has(key.replace(/[^a-z]/gi, "").toLowerCase())) continue;
    const timestamp = toIso(value);
    if (timestamp) dates.add(timestamp);
  }
  return [...dates];
}

const NUMERIC_DATE = "\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}";
const LABELED_DATE = `(?:${NUMERIC_DATE}|\\d{4}-\\d{2}-\\d{2}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})`;

function labelledTimestamp(value: string): string | null {
  return toIso(value) ?? parseUnambiguousUsNumericDate(value);
}

/** A docket header is page furniture, so repeated identical values add no extra claim. */
function courtFilingEvidence(text: string): TimestampEvidence[] {
  const evidence: TimestampEvidence[] = [];
  const header = new RegExp(`\\bDocument\\s+\\d+\\s+Filed\\s+(${NUMERIC_DATE})\\s+Page\\s+\\d+\\s+of\\s+\\d+\\b`, "gi");
  for (const match of text.matchAll(header)) {
    const timestamp = parseUnambiguousUsNumericDate(match[1]!);
    if (timestamp) evidence.push({ timestamp, source: "court-filing-header", confidence: "strong" });
  }
  return evidence;
}

/** Labels must name publication or filing; ordinary prose dates are intentionally ignored. */
function documentLabelEvidence(text: string): TimestampEvidence[] {
  const evidence: TimestampEvidence[] = [];
  const label = new RegExp(
    `\\b(?:date\\s+(?:filed|published)|(?:filed|published)\\s+date|filing\\s+date|publication\\s+date)\\s*[:\\-]\\s*(${LABELED_DATE})`,
    "gi",
  );
  for (const match of text.matchAll(label)) {
    const timestamp = labelledTimestamp(match[1]!);
    if (timestamp) evidence.push({ timestamp, source: "document-publication-label", confidence: "moderate" });
  }
  return evidence;
}

/** Parse PDF bytes into page-by-page text. Never throws; every failure mode returns a reason instead. */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfExtraction | PdfFailure> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return { ok: false, reason: "pdf-too-large", detail: `${bytes.byteLength} bytes exceeds ${MAX_PDF_BYTES}` };
  }
  if (!looksLikePdfBytes(bytes)) {
    return { ok: false, reason: "pdf-invalid", detail: "missing %PDF- header" };
  }

  let totalPages: number;
  let rawPages: string[];
  let metadataDates: string[] = [];
  try {
    // unpdf/pdf.js rejects a Node Buffer at runtime (it subclasses Uint8Array but fails their
    // exact-type check), so callers that hand us a Buffer (e.g. Buffer.from(...) in the fetcher)
    // need converting to a genuine Uint8Array right at this boundary.
    const plainBytes = Uint8Array.from(bytes);
    // verbosity: 0 silences pdf.js's own console warnings about malformed-but-recoverable structure.
    const proxy = await getDocumentProxy(plainBytes, { verbosity: 0 });
    const extracted = await extractText(proxy, { mergePages: false });
    totalPages = extracted.totalPages;
    rawPages = extracted.text;
    try {
      const metadata = await getMeta(proxy, { parseDates: true });
      metadataDates = trustedPdfMetadataDates(metadata.info);
    } catch {
      // Metadata is optional; text extraction remains usable when it is malformed or absent.
    }
  } catch (error) {
    // Covers encrypted (PasswordException), corrupted and otherwise unparseable PDFs alike.
    return { ok: false, reason: "pdf-parse-failed", detail: error instanceof Error ? error.message : "unknown parser error" };
  }

  const pages: PdfPageText[] = rawPages.map((raw, index) => ({ page: index + 1, text: canonicalText(raw) }));
  const fingerprint_pages: PdfPageText[] = rawPages.map((raw, index) => ({
    page: index + 1,
    text: normalizeFingerprintText(raw),
  }));
  const text = pages
    .map((page) => page.text)
    .filter((page) => page.length > 0)
    .join("\n\n");
  if (text.length < MIN_EXTRACTABLE_TEXT) {
    return { ok: false, reason: "pdf-no-extractable-text" };
  }
  return { ok: true, pages, fingerprint_pages, page_count: totalPages, text, metadata_dates: metadataDates };
}

/**
 * A parsed PDF as a `ParsedDocument`, so it can go through the same case-name/passage/citation
 * assembly as an HTML page. It ranks explicitly labelled PDF metadata, court filing headers,
 * labelled document dates, and weak URL/search dates without inferring from arbitrary prose.
 */
export function parsePdfDocument(url: string, extraction: PdfExtraction, searchPublished?: string): ParsedDocument {
  const canonical = canonicalUrl(url);
  const firstLine = extraction.pages[0]?.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  const evidence: TimestampEvidence[] = [
    ...extraction.metadata_dates.map((timestamp) => ({ timestamp, source: "pdf-metadata" as const, confidence: "strong" as const })),
    ...courtFilingEvidence(extraction.text),
    ...documentLabelEvidence(extraction.text),
  ];
  const urlEvidence = urlTimestampEvidence(canonical);
  if (urlEvidence) evidence.push(urlEvidence);
  const searchTimestamp = toIso(searchPublished);
  if (searchTimestamp) evidence.push({ timestamp: searchTimestamp, source: "search-result", confidence: "weak" });
  const selected = selectTimestampEvidence(evidence);
  return {
    url: canonical,
    title: firstLine.slice(0, 200),
    publisher: new URL(canonical).hostname.replace(/^www\./, ""),
    timestamp: selected.timestamp,
    timestamp_source: selected.source,
    timestamp_confidence: selected.confidence,
    timestamp_conflict: selected.conflict,
    text: extraction.text,
    fingerprint_text: pdfFingerprintText(extraction),
    // Deterministic hyperlink-annotation extraction is future work; see step 6 report for the tradeoff.
    outbound_links: [],
  };
}
