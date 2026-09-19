import { assembleDocument, parseHtmlPage, type CandidateDocument, type ParsedDocument } from "./extract";
import { extractPdfPages, parsePdfDocument } from "./pdf";
import { fetchSourceDetailed, type FetchedPage, type PageFetcher, type SourceFetchFailure, type SourceReference, type SourceResolver } from "./providers";
import { canonicalText } from "./text";

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

export type IngestionFailureReason =
  | "invalid-url"
  | "not-found"
  | "source-unauthorized"
  | "source-forbidden"
  | "source-rate-limited"
  | "source-server-error"
  | "source-timeout"
  | "source-network-error"
  | "source-redirect-error"
  | "unsupported-document"
  | "resolution-failed"
  | "fetch-failed"
  | "empty-document"
  | "error-document"
  | "pdf-extraction-failed"
  | "parse-failed";

export interface IngestionFailure {
  ok: false;
  stage: "resolution" | "fetch" | "extraction";
  category: string;
  reason: IngestionFailureReason;
  detail: string | null;
  recoverable: boolean;
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

function sourceFailure(failure: SourceFetchFailure): IngestionFailure {
  const reason: Record<SourceFetchFailure["category"], IngestionFailureReason> = {
    "invalid-url": "invalid-url",
    timeout: "source-timeout",
    "http-401": "source-unauthorized",
    "http-403": "source-forbidden",
    "http-404": "not-found",
    "http-429": "source-rate-limited",
    "http-5xx": "source-server-error",
    "http-error": "fetch-failed",
    "redirect-error": "source-redirect-error",
    "network-error": "source-network-error",
    "response-read-failed": "source-network-error",
    "unsupported-content": "unsupported-document",
    "missing-source-reference": "invalid-url",
    "resolver-failed": "resolution-failed",
  };
  return {
    ok: false,
    stage: failure.stage,
    category: failure.category,
    reason: reason[failure.category],
    detail: failure.category === "http-404" ? null : failure.message,
    recoverable: failure.recoverable,
  };
}

function unusableDocumentReason(parsed: ParsedDocument): IngestionFailureReason | null {
  const text = canonicalText(parsed.text);
  if (!text) return "empty-document";
  const visible = canonicalText(`${parsed.title} ${text}`);
  if (
    text.length <= 300 &&
    /^(?:404(?: not found)?|page not found|not found|access denied|forbidden|request blocked|attention required|just a moment|enable javascript|captcha\b)/i.test(
      visible,
    )
  ) {
    return "error-document";
  }
  return null;
}

export async function ingestFetchedPage(page: FetchedPage, options: IngestSourceOptions): Promise<IngestionResult> {
  try {
    let parsed: ParsedDocument;
    if (page.kind === "pdf") {
      const extraction = await extractPdfPages(page.bytes);
      if (!extraction.ok) {
        return {
          ok: false,
          stage: "extraction",
          category: extraction.reason,
          reason: "pdf-extraction-failed",
          detail: `${extraction.reason}${extraction.detail ? ` (${extraction.detail})` : ""}`,
          recoverable: false,
        };
      }
      parsed = parsePdfDocument(page.url, extraction, options.published ?? undefined);
    } else {
      parsed = parseHtmlPage(page.url, page.html, options.published ?? undefined);
    }
    const unusable = unusableDocumentReason(parsed);
    if (unusable) {
      return {
        ok: false,
        stage: "extraction",
        category: unusable,
        reason: unusable,
        detail: unusable === "empty-document" ? "source document contained no extractable text" : "source response appears to be an error or bot-block page",
        recoverable: false,
      };
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
    return { ok: false, stage: "extraction", category: "parse-failed", reason: "parse-failed", detail: "source document could not be parsed", recoverable: false };
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
  const result = await fetchSourceDetailed(source, deps);
  if (!result.fetched) {
    return sourceFailure(
      result.failure ?? {
        stage: "fetch",
        category: "network-error",
        message: "source network request failed",
        recoverable: true,
        url: null,
      },
    );
  }
  return ingestFetchedPage(result.fetched.page, options);
}
