import { z } from "zod";
import { lookupDemoCache } from "./demo-cache";
import type { CandidateDocument } from "../research/extract";
import { toAuditMetadata } from "../research/providers";
import type { UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../research/traversal";

const Identifier = z.number().int().nonnegative();
const OpaqueObject = z.object({}).passthrough();
const Author = z.unknown();

const Claim = z
  .object({
    id: Identifier,
    bibliographic_citation_ids: z.array(Identifier),
    text: z.string(),
  })
  .passthrough();
const BibliographicCitation = z
  .object({
    id: Identifier,
    text: z.string(),
  })
  .passthrough();
const Source = z
  .object({
    id: Identifier,
    citation_id: Identifier.nullable(),
    claim_id: Identifier.nullable(),
    sourcerer_name: z.string(),
    citation_object: OpaqueObject,
    authors: z.array(Author),
    url: z.url(),
    relevance_score: z.number().nullable(),
    citations: z
      .object({
        apa: z.string(),
        bibtex: z.string(),
        chicago: z.string(),
        ieee: z.string(),
        mla: z.string(),
      })
      .passthrough(),
    title: z.string(),
    citation_match: OpaqueObject.nullable(),
    content: z.string(),
    date: z.string(),
    justification: z.string().nullable(),
    relevance_justification: z.string().nullable(),
    relevant_chunk: z.string().nullable(),
    stance: z.string().nullable(),
  })
  .passthrough();

const BibliographyScanResponseSchema = z
  .object({
    id: z.string().min(1),
    version: z.literal(2),
    bibliographic_citations: z.array(BibliographicCitation),
    claims: z.array(Claim),
    sources: z.array(Source),
    raw: OpaqueObject,
    inputText: z.string(),
  })
  .passthrough();

export type BibliographyScanResponse = z.infer<typeof BibliographyScanResponseSchema>;
export type BibliographySource = z.infer<typeof Source>;
export type BibliographyClaim = z.infer<typeof Claim>;
export type BibliographyCitationRecord = z.infer<typeof BibliographicCitation>;

export function parseBibliographyScanResponse(input: unknown): BibliographyScanResponse | null {
  const parsed = BibliographyScanResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export interface BibliographyDebugEvent {
  source_url: string;
  request_body: unknown;
  response_status: number;
  /** The unparsed JSON body, kept only for debugging; never fed into scoring or acceptance. */
  raw_response: unknown;
  proposals_returned: number;
}

export interface BibliographySourceProposerOptions {
  fetchImpl?: typeof fetch;
  /** Invoked once per `analyze()` call with the raw request/response, for debugging only. */
  onDebug?: (event: BibliographyDebugEvent) => void;
  /** Aborts the request after this many ms, surfaced as {@link GPTZeroTimeoutError}. Default 20s. */
  timeoutMs?: number;
}

/** A non-2xx, non-429 HTTP response. `status` lets callers (e.g. the fallback wrapper) decide by code without parsing the message. */
export class GPTZeroHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GPTZeroHttpError";
  }
}

/** The request did not complete within the configured timeout. */
export class GPTZeroTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    /** Which GPTZero call timed out, so a composed proposer can name the right endpoint. */
    operation = "bibliography scan",
  ) {
    super(`GPTZero ${operation} timed out after ${timeoutMs}ms`);
    this.name = "GPTZeroTimeoutError";
  }
}

/**
 * A scan of a real fetched page takes 17-33s (measured live, 4 concurrent scans of 4-11k chars;
 * the submitted claim alone takes 9-19s), so 20s aborted nearly every child-document scan and
 * recursion never got past depth 0. 45s leaves headroom over the slowest observed scan.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

function isPendingAnalysis(analysis: UpstreamAnalysis): analysis is { status: "pending"; job_id: string; retry_after_ms?: number | null } {
  return !Array.isArray(analysis) && (analysis as { status?: string }).status === "pending";
}

export function authorName(author: unknown): string | null {
  if (typeof author === "string") return author.trim() || null;
  const parsed = z.object({ name: z.string() }).passthrough().safeParse(author);
  return parsed.success ? parsed.data.name.trim() || null : null;
}

export function authorsToText(authors: readonly unknown[]): string | null {
  const names = authors
    .map(authorName)
    .filter((name): name is string => name !== null);
  return names.length ? names.join(", ") : null;
}

function resolveById<T extends { id: number }>(items: T[], id: number | null): T | null {
  if (id === null) return null;
  return items.find((item) => item.id === id) ?? null;
}

/**
 * Map one `sources[]` entry to a provider-neutral `UpstreamProposal`. Only `url`/`title`/`authors`
 * feed the structured fields the traversal acts on; everything else GPTZero returned about this
 * source (its matched claim, its matched bibliographic citation, the relevant passage, and any
 * GPTZero-side score/stance/label) rides along as `metadata` for audit purposes only.
 */
export function buildProposal(source: BibliographySource, response: BibliographyScanResponse): UpstreamProposal | null {
  const url = source.url.trim() || null;
  const title = source.title.trim() || null;
  const author = authorsToText(source.authors);
  if (!url && !title && !author) return null;

  const claim = resolveById(response.claims, source.claim_id);
  const citation = resolveById(response.bibliographic_citations, source.citation_id);

  return {
    url,
    title,
    // No confirmed field carries a standalone citation string for the proposed *source* itself
    // (as opposed to the matched bibliographic citation preserved in metadata below), so this is
    // left null rather than guessed; the resolver falls back to title/author/URL as usual.
    citation: null,
    author,
    metadata: toAuditMetadata({
      asCited: citation?.text ?? null,
      claimId: source.claim_id,
      citationId: source.citation_id,
      relevantChunk: source.relevant_chunk,
      sourceContent: source.content,
      claim,
      bibliographicCitation: citation,
      source,
    }),
  };
}

/**
 * GPTZero's bibliography scan as an `UpstreamSourceProposer` (see `../research/traversal.ts`).
 * GPTZero is a proposer only: this class never decides that a proposed source is a real parent.
 * Every proposal it returns still passes through `traverseProvenance`'s ordinary fetch,
 * canonicalization, duplicate/cycle checks, and the deterministic `scoreEdge` before it can become
 * an accepted edge. Nothing GPTZero reports as a score, stance, match confidence, or hallucination
 * label is read by this class for acceptance purposes; it is only ever copied into `metadata` for a
 * human or the `onDebug` hook to inspect.
 *
 * One request per `analyze()` call, awaited to completion before returning: this class never issues
 * concurrent requests on its own. `traverseProvenance` already calls `analyze()` sequentially and
 * caps requests per call via `maxProviderRequests` (default 10, matching the bibliography scan's
 * 10-scans/minute limit), so no additional client-side rate limiting is layered on top here.
 */
export class BibliographySourceProposer implements UpstreamSourceProposer {
  static readonly endpoint = "https://api.gptzero.me/v2/bibliography-scan/text";
  readonly kind = "gptzero-bibliography" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly onDebug?: (event: BibliographyDebugEvent) => void;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: BibliographySourceProposerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onDebug = options.onDebug;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    const body = { document: document.text || document.passage };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(BibliographySourceProposer.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new GPTZeroTimeoutError(this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      // The confirmed limit is 10 scans/minute. Map it to traversal's existing provider-pending
      // pause path rather than retrying inline or adding separate rate-limit machinery.
      this.onDebug?.({ source_url: document.url, request_body: body, response_status: 429, raw_response: null, proposals_returned: 0 });
      return { status: "pending", job_id: continuation?.job_id ?? `rate-limit:${document.id}`, retry_after_ms: 60_000 };
    }
    if (!response.ok) {
      throw new GPTZeroHttpError(response.status, `GPTZero bibliography scan returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      this.onDebug?.({ source_url: document.url, request_body: body, response_status: response.status, raw_response: null, proposals_returned: 0 });
      return [];
    }
    const raw = parseBibliographyScanResponse(json);

    const proposals = raw ? raw.sources.map((source) => buildProposal(source, raw)).filter((proposal): proposal is UpstreamProposal => proposal !== null) : [];

    this.onDebug?.({
      source_url: document.url,
      request_body: body,
      response_status: response.status,
      raw_response: json,
      proposals_returned: proposals.length,
    });
    return proposals;
  }
}

/** Deterministic stand-in for USE_MOCKS=true and offline tests. Proposes nothing: a run under mocks must supply its own upstream fixtures rather than rely on a synthetic bibliography scan. */
export class MockBibliographyProposer implements UpstreamSourceProposer {
  readonly kind = "mock" as const;
  async analyze(_document: CandidateDocument, _continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    return [];
  }
}

export type FallbackReason = "rate-limited" | "timeout" | "server-error" | "network-error";

export interface FallbackEvent {
  document_id: string;
  reason: FallbackReason;
  cached: boolean;
  captured_at: string | null;
}

export interface CachedFallbackBibliographyProposerOptions {
  /** Live-only mode: never substitute cached demo output, even on a qualifying failure. */
  disabled?: boolean;
  onFallback?: (event: FallbackEvent) => void;
}

/**
 * Wraps a live bibliography proposer with an offline fallback, seeded once from a real successful
 * scan (`server/gptzero/fixtures/demo-cache.json`). The fallback only ever substitutes for a
 * *failed* live attempt; it never overrides a live success, and it never fires for 401/403 (those
 * mean the credential is wrong, not that the service is unavailable, so they fail loudly).
 *
 * A 429 only triggers the fallback once traversal's own job-id continuation has already been
 * tried and rate-limited again: the first 429 for a source still becomes an ordinary pending
 * analysis so the caller can resume it later, exactly as `BibliographySourceProposer` already
 * behaves without this wrapper.
 */
export class CachedFallbackBibliographyProposer implements UpstreamSourceProposer {
  readonly kind = "gptzero-bibliography" as const;

  constructor(
    private readonly inner: UpstreamSourceProposer,
    private readonly options: CachedFallbackBibliographyProposerOptions = {},
  ) {}

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    try {
      const result = await this.inner.analyze(document, continuation);
      if (isPendingAnalysis(result) && continuation?.job_id) return this.fallback(document, "rate-limited");
      return result;
    } catch (error) {
      if (error instanceof GPTZeroHttpError && (error.status === 401 || error.status === 403)) throw error;
      if (error instanceof GPTZeroTimeoutError) return this.fallback(document, "timeout");
      if (error instanceof GPTZeroHttpError && error.status >= 500) return this.fallback(document, "server-error");
      if (error instanceof GPTZeroHttpError) throw error;
      return this.fallback(document, "network-error");
    }
  }

  private fallback(document: CandidateDocument, reason: FallbackReason): UpstreamAnalysis {
    const entry = this.options.disabled ? null : lookupDemoCache(document.text || document.passage);
    this.options.onFallback?.({
      document_id: document.id,
      reason,
      cached: entry !== null,
      captured_at: entry?.capturedAt ?? null,
    });
    if (!entry) {
      throw new Error(
        `GPTZero bibliography scan failed (${reason}) and ${this.options.disabled ? "fallback is disabled" : "no cached demo fallback matches this input"}`,
      );
    }
    console.warn(
      `[gptzero-bibliography] live call failed (${reason}); serving cached_demo_fallback captured ${entry.capturedAt} for document ${document.id}`,
    );
    const proposals = entry.response.sources
      .map((source) => buildProposal(source, entry.response))
      .filter((proposal): proposal is UpstreamProposal => proposal !== null);
    return { status: "completed", proposals, fallback: { provenance: "cached_demo_fallback", capturedAt: entry.capturedAt } };
  }
}

export function createBibliographyProposer(config: { useMocks: boolean; gptzeroApiKey: string | null }): UpstreamSourceProposer {
  if (config.useMocks) return new MockBibliographyProposer();
  if (!config.gptzeroApiKey) {
    return {
      analyze: async () => {
        throw new Error("GPTZERO_API_KEY is not set. Set it, or set USE_MOCKS=true.");
      },
    };
  }
  const live = new BibliographySourceProposer(config.gptzeroApiKey);
  const disabled = ["1", "true", "yes", "on"].includes((process.env.GPTZERO_BIBLIOGRAPHY_DISABLE_FALLBACK ?? "").trim().toLowerCase());
  return new CachedFallbackBibliographyProposer(live, { disabled });
}
