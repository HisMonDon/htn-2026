import { z } from "zod";
import type { CandidateDocument } from "../research/extract";
import { toAuditMetadata } from "../research/providers";
import type { UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../research/traversal";
import { authorsToText, GPTZeroHttpError, GPTZeroTimeoutError } from "./bibliography";

/**
 * GPTZero's claim-level source finder: `POST https://api.gptzero.me/v2/relevant_sources/` with
 * `{ text, search_parameters? }` and the usual `x-api-key` header. It takes one arbitrary
 * sentence/claim rather than a whole document, and exists to reach claims that the Bibliography
 * Scan's own check-worthiness filter declined to look for sources for.
 *
 * Like the bibliography scan, it is a *candidate proposer only*. Everything it reports about a
 * source it found — `relevance_score`, `stance`, `justification`, `relevance_justification`,
 * `reliability_score`, `is_relevant`, `opensearch_rank`, `ai_detection_prediction` — is opaque
 * audit metadata here. None of it reaches `scoreEdge`, `validateProvenanceEdge`, edge acceptance,
 * Ariadne confidence or mutation scoring; Ariadne still fetches, extracts and validates every
 * proposal independently.
 */
const OpaqueObject = z.object({}).passthrough();

const RelevantSource = z
  .object({
    url: z.string().nullish(),
    title: z.string().nullish(),
    citation_object: OpaqueObject.nullish(),
    citations: OpaqueObject.nullish(),
    citation_match: OpaqueObject.nullish(),
    content: z.string().nullish(),
    content_is_complete: z.boolean().nullish(),
    date: z.string().nullish(),
    filename: z.string().nullish(),
    id: z.unknown().optional(),
    summary: z.string().nullish(),
    relevant_chunk: z.string().nullish(),
    sourcerer_name: z.string().nullish(),
    // Provider-side assessments. Read only into audit metadata, never into an Ariadne field.
    relevance_score: z.number().nullish(),
    relevance_justification: z.string().nullish(),
    reliability_score: z.number().nullish(),
    is_relevant: z.boolean().nullish(),
    opensearch_rank: z.number().nullish(),
    justification: z.string().nullish(),
    stance: z.string().nullish(),
    ai_detection_prediction: OpaqueObject.nullish(),
  })
  .passthrough();

const RelevantSourcesResponseSchema = z
  .object({
    sources: z.array(RelevantSource),
  })
  .passthrough();

export type RelevantSourcesResponse = z.infer<typeof RelevantSourcesResponseSchema>;
export type RelevantSource = z.infer<typeof RelevantSource>;

export function parseRelevantSourcesResponse(input: unknown): RelevantSourcesResponse | null {
  const parsed = RelevantSourcesResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** `citation_object` is untyped in the response; only the two resolver-facing fields are read out. */
const CitationObject = z
  .object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    authors: z.array(z.unknown()).nullish(),
    publication_date: z.string().nullish(),
  })
  .passthrough();

function citationObject(source: RelevantSource): z.infer<typeof CitationObject> | null {
  const parsed = CitationObject.safeParse(source.citation_object);
  return parsed.success ? parsed.data : null;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Map one `sources[]` entry to a provider-neutral `UpstreamProposal`. Only URL, title and a
 * normalized author list become resolver-facing fields — exactly what source acquisition needs to
 * fetch the document. Every provider-side score, rank, stance and justification stays inside the
 * opaque `AuditMetadata` wrapper, which scoring and acceptance code cannot read through.
 */
export function buildClaimProposal(source: RelevantSource): UpstreamProposal | null {
  const citation = citationObject(source);
  const url = text(source.url) ?? text(citation?.url);
  const title = text(source.title) ?? text(citation?.title);
  const author = authorsToText(citation?.authors ?? []);
  if (!url && !title && !author) return null;

  return {
    url,
    title,
    // The endpoint returns rendered citation strings (APA/MLA/...) rather than a single citation
    // for the source itself, so this stays null instead of picking one arbitrarily; the resolver
    // falls back to title/author/URL as it already does for bibliography proposals.
    citation: null,
    author,
    published: text(citation?.publication_date) ?? text(source.date),
    metadata: toAuditMetadata({
      relevantChunk: source.relevant_chunk ?? null,
      sourceContent: source.content ?? null,
      sourcererName: source.sourcerer_name ?? null,
      /** Provider-only assessments. Audit/debug display only; never an Ariadne score. */
      provider: {
        relevance_score: source.relevance_score ?? null,
        relevance_justification: source.relevance_justification ?? null,
        reliability_score: source.reliability_score ?? null,
        is_relevant: source.is_relevant ?? null,
        opensearch_rank: source.opensearch_rank ?? null,
        justification: source.justification ?? null,
        stance: source.stance ?? null,
        ai_detection_prediction: source.ai_detection_prediction ?? null,
      },
      source,
    }),
  };
}

export interface ClaimSourceDebugEvent {
  source_url: string;
  request_body: unknown;
  response_status: number;
  /** The unparsed JSON body, kept only for debugging; never fed into scoring or acceptance. */
  raw_response: unknown;
  proposals_returned: number;
}

export interface ClaimSourceProposerOptions {
  fetchImpl?: typeof fetch;
  /** Invoked once per `analyze()` call with the raw request/response, for debugging only. */
  onDebug?: (event: ClaimSourceDebugEvent) => void;
  /** Aborts the request after this many ms, surfaced as {@link GPTZeroTimeoutError}. Default 30s. */
  timeoutMs?: number;
  /** The endpoint expects a sentence-sized claim; longer passages are truncated. Default 2,000. */
  maxTextLength?: number;
}

/** Observed live latency is 7-16s, noticeably slower than the bibliography scan. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_LENGTH = 2_000;

/** Marks a pending analysis as "resume straight into the claim endpoint", skipping bibliography. */
export const CLAIM_JOB_PREFIX = "claim-sources:";

export function claimJobId(document: CandidateDocument): string {
  return `${CLAIM_JOB_PREFIX}${document.id}`;
}

/**
 * GPTZero's claim-level source finder as an `UpstreamSourceProposer`.
 *
 * One request per `analyze()` call, awaited to completion: this class never issues concurrent
 * requests. It is normally reached only through `ClaimFallbackProposer`, which owns the provider
 * request budget shared with the bibliography scan.
 */
export class ClaimSourceProposer implements UpstreamSourceProposer {
  static readonly endpoint = "https://api.gptzero.me/v2/relevant_sources/";
  readonly kind = "gptzero-claim-sources" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly onDebug?: (event: ClaimSourceDebugEvent) => void;
  private readonly timeoutMs: number;
  private readonly maxTextLength: number;

  constructor(
    private readonly apiKey: string,
    options: ClaimSourceProposerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onDebug = options.onDebug;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  }

  /** The claim-bearing passage is preferred over the whole document: this endpoint takes a sentence. */
  private claimText(document: CandidateDocument): string {
    return (document.passage || document.text).trim().slice(0, this.maxTextLength);
  }

  async analyze(document: CandidateDocument, continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    const body = { text: this.claimText(document) };
    if (!body.text) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(ClaimSourceProposer.endpoint, {
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
      if (controller.signal.aborted) throw new GPTZeroTimeoutError(this.timeoutMs, "claim source search");
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      // Same shape as the bibliography scan's rate-limit handling: hand traversal a pending
      // analysis so the source is resumed later rather than recorded as having no upstream.
      // The job id keeps the resume on the claim endpoint instead of replaying the whole fallback.
      this.onDebug?.({ source_url: document.url, request_body: body, response_status: 429, raw_response: null, proposals_returned: 0 });
      return { status: "pending", job_id: continuation?.job_id ?? claimJobId(document), retry_after_ms: 60_000 };
    }
    if (!response.ok) {
      throw new GPTZeroHttpError(response.status, `GPTZero claim source search returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      this.onDebug?.({ source_url: document.url, request_body: body, response_status: response.status, raw_response: null, proposals_returned: 0 });
      return [];
    }
    const parsed = parseRelevantSourcesResponse(json);
    const proposals = parsed
      ? parsed.sources.map(buildClaimProposal).filter((proposal): proposal is UpstreamProposal => proposal !== null)
      : [];

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

/** Deterministic stand-in for USE_MOCKS=true and offline tests: proposes nothing, like the mock bibliography proposer. */
export class MockClaimSourceProposer implements UpstreamSourceProposer {
  readonly kind = "mock" as const;
  async analyze(_document: CandidateDocument, _continuation?: { job_id: string }): Promise<UpstreamAnalysis> {
    return [];
  }
}
