/**
 * Content-type dispatch for acquisition. A discovered URL may resolve to HTML or to a PDF; this
 * decides which deterministic extractor a fetched page should go through. The HTTP `Content-Type`
 * is authoritative when present; the URL extension is only a fallback for when it is missing, and
 * magic bytes settle it when bytes are already in hand (e.g. after a raw/binary fetch).
 */

export type ContentKind = "html" | "pdf" | "unknown";

const PDF_MAGIC = "%PDF-";
const PDF_EXTENSION = /\.pdf(?:[?#]|$)/i;

/** `%PDF-` at the start of the file, per the PDF spec. Cheap and reliable regardless of what any header claims. */
export function looksLikePdfBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  let header = "";
  for (let i = 0; i < PDF_MAGIC.length; i += 1) header += String.fromCharCode(bytes[i]!);
  return header === PDF_MAGIC;
}

export interface ContentKindInput {
  contentType?: string | null;
  url?: string;
  bytes?: Uint8Array;
}

/**
 * A `Content-Type` header wins whenever present, even if it disagrees with a `.pdf` URL (some
 * court-filing links serve an HTML interstitial at a `.pdf` path, and some PDFs are served from
 * extension-less URLs). Bytes settle it when no usable header is available.
 */
export function detectContentKind(input: ContentKindInput): ContentKind {
  const contentType = (input.contentType ?? "").toLowerCase();
  if (contentType.includes("pdf")) return "pdf";
  if (/html|xml|text\/plain/.test(contentType)) return "html";
  if (input.bytes && looksLikePdfBytes(input.bytes)) return "pdf";
  if (!contentType && input.url && PDF_EXTENSION.test(input.url)) return "pdf";
  return "unknown";
}
