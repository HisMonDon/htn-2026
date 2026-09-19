import { assembleDocument, parseHtmlPage, type CandidateDocument, type ParsedDocument } from "./extract";
import { extractPdfPages, parsePdfDocument } from "./pdf";
import { fetchSource, type FetchedPage, type PageFetcher, type SourceReference, type SourceResolver } from "./providers";

/**
 * Shared document ingestion boundary for sources obtained outside ordinary search discovery.
 * It deliberately uses the same HTML/PDF parsing and document assembly path as discovery so
 * timestamps, canonical URLs, fingerprints, passages, and citation matching stay identical.
 */
export interface IngestSourceOptions {
  fabricated: string[];
  claimTerms: string[];
  discoveredVia: string;
  published?: string | null;
}

export type IngestionFailureReason = "not-found" | "fetch-failed" | "pdf-extraction-failed" | "parse-failed";

export interface IngestionFailure {
  ok: false;
  reason: IngestionFailureReason;
  detail: string | null;
}

export interface IngestedDocument {
  ok: true;
  document: CandidateDocument;
  /** Retained for callers that need to re-assemble after the known-citation set changes. */
  parsed: ParsedDocument;
}

export type IngestionResult = IngestedDocument | IngestionFailure;

export interface SourceIngestionDeps {
  fetcher: PageFetcher;
  /** Used only after a direct URL is missing, malformed, unsupported, or dead. */
  resolver?: SourceResolver;
}

async function ingestFetchedPage(page: FetchedPage, options: IngestSourceOptions): Promise<IngestionResult> {
  try {
    let parsed: ParsedDocument;
    if (page.kind === "pdf") {
      const extraction = await extractPdfPages(page.bytes);
      if (!extraction.ok) {
        return {
          ok: false,
          reason: "pdf-extraction-failed",
          detail: `${extraction.reason}${extraction.detail ? ` (${extraction.detail})` : ""}`,
        };
      }
      parsed = parsePdfDocument(page.url, extraction, options.published ?? undefined);
    } else {
      parsed = parseHtmlPage(page.url, page.html, options.published ?? undefined);
    }
    return {
      ok: true,
      parsed,
      document: assembleDocument(parsed, {
        fabricated: options.fabricated,
        claimTerms: options.claimTerms,
        discoveredVia: options.discoveredVia,
      }),
    };
  } catch (error) {
    return { ok: false, reason: "parse-failed", detail: error instanceof Error ? error.message : "parse failed" };
  }
}

/**
 * Fetch and normalize one source. All failures are returned as data so a provenance branch can
 * end cleanly without discarding the rest of a traversal.
 */
export async function ingestSource(
  url: string,
  fetcher: PageFetcher,
  options: IngestSourceOptions,
): Promise<IngestionResult> {
  return ingestSourceReference({ url }, { fetcher }, options);
}

/**
 * Ingest an upstream proposal. Fetching stays direct whenever a usable URL was supplied; the
 * optional resolver has exactly one chance only after direct acquisition cannot yield evidence.
 */
export async function ingestSourceReference(
  source: SourceReference,
  deps: SourceIngestionDeps,
  options: IngestSourceOptions,
): Promise<IngestionResult> {
  const fetched = await fetchSource(source, deps);
  if (!fetched) return { ok: false, reason: "not-found", detail: null };
  return ingestFetchedPage(fetched.page, options);
}
