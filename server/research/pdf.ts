import { extractText, getDocumentProxy } from "unpdf";
import { canonicalUrl, type ParsedDocument } from "./extract";
import { canonicalText } from "./text";
import { looksLikePdfBytes } from "./content-type";

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
  page_count: number;
  /** Page texts joined with a blank line, so page boundaries survive into evidence extraction. */
  text: string;
}

export type PdfFailureReason = "pdf-too-large" | "pdf-invalid" | "pdf-no-extractable-text" | "pdf-parse-failed";

export interface PdfFailure {
  ok: false;
  reason: PdfFailureReason;
  detail?: string;
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
  } catch (error) {
    // Covers encrypted (PasswordException), corrupted and otherwise unparseable PDFs alike.
    return { ok: false, reason: "pdf-parse-failed", detail: error instanceof Error ? error.message : "unknown parser error" };
  }

  const pages: PdfPageText[] = rawPages.map((raw, index) => ({ page: index + 1, text: canonicalText(raw) }));
  const text = pages
    .map((page) => page.text)
    .filter((page) => page.length > 0)
    .join("\n\n");
  if (text.length < MIN_EXTRACTABLE_TEXT) {
    return { ok: false, reason: "pdf-no-extractable-text" };
  }
  return { ok: true, pages, page_count: totalPages, text };
}

/**
 * A parsed PDF as a `ParsedDocument`, so it can go through the same case-name/passage/citation
 * assembly as an HTML page. Title and timestamp are never taken from PDF metadata (untrustworthy
 * provenance); the title is the first non-blank line of extracted text, publisher falls back to the
 * hostname exactly as the HTML extractor does, and the timestamp is left unknown.
 */
export function parsePdfDocument(url: string, extraction: PdfExtraction): ParsedDocument {
  const canonical = canonicalUrl(url);
  const firstLine = extraction.pages[0]?.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  return {
    url: canonical,
    title: firstLine.slice(0, 200),
    publisher: new URL(canonical).hostname.replace(/^www\./, ""),
    timestamp: null,
    timestamp_source: "none",
    text: extraction.text,
    // Deterministic hyperlink-annotation extraction is future work; see step 6 report for the tradeoff.
    outbound_links: [],
  };
}
