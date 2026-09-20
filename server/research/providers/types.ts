export interface SearchHit {
  url: string;
  title: string;
  published: string | null;
  /** Optional result excerpt. Used only to rank candidates cheaply before they are fetched. */
  snippet?: string | null;
}

/**
 * The discovery-provider boundary. Anything that can turn a query into candidate URLs
 * (Browserbase Search, the offline corpus, or a future replacement) implements this — `discover()`
 * and the rest of the pipeline never depend on a concrete provider.
 */
export interface SearchProvider {
  /** Identifies the configured provider for run diagnostics only. */
  readonly kind: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/**
 * A fetched page, dispatched by content type: HTML goes to the existing extractor, PDFs go through
 * deterministic parsing (step 6). `url` is the final (post-redirect) URL.
 */
export type FetchedPage = { url: string; kind: "html"; html: string } | { url: string; kind: "pdf"; bytes: Uint8Array };

export type FetchFailureCategory =
  | "invalid-url"
  | "timeout"
  | "http-401"
  | "http-403"
  | "http-404"
  | "http-429"
  | "http-5xx"
  | "http-error"
  | "redirect-error"
  | "network-error"
  | "response-read-failed"
  | "unsupported-content";

export interface FetchFailure {
  stage: "fetch";
  category: FetchFailureCategory;
  message: string;
  recoverable: boolean;
  status: number | null;
  url: string;
}

export type FetchResult = { ok: true; page: FetchedPage } | { ok: false; failure: FetchFailure };

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage | null>;
  fetchDetailed?(url: string): Promise<FetchResult>;
}

declare const AUDIT_METADATA: unique symbol;

/**
 * Provider-supplied audit context (e.g. the matched claim/citation record, a relevant passage),
 * structurally opaque outside this module. There is no member access into it: `toAuditMetadata`
 * and `readAuditMetadata` are the only way in or out, so a `.metadata.someField` read in scoring
 * or acceptance code (`research/edges.ts`, `research/traversal.ts`, `provenance/validator.ts`) is
 * a compile error, not just a convention documented in a comment.
 */
export type AuditMetadata = { readonly [AUDIT_METADATA]: true };

/** Wrap provider-supplied audit context. Only call this where a proposal is constructed. */
export function toAuditMetadata(value: Record<string, unknown>): AuditMetadata {
  return value as unknown as AuditMetadata;
}

/** Escape hatch for debugging/audit display only. Never call this from scoring or acceptance code. */
export function readAuditMetadata(value: AuditMetadata): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/**
 * A source proposed by an upstream system. URLs are preferred, but a resolver can use the
 * remaining bibliographic fields when the proposal is incomplete or the URL is dead.
 */
export interface SourceReference {
  url?: string | null;
  title?: string | null;
  citation?: string | null;
  author?: string | null;
  /** Purely informational: traversal and edge scoring cannot read through this type. */
  metadata?: AuditMetadata | null;
}

/**
 * Optional fallback for incomplete source proposals. It deliberately has no dependency on a
 * particular search API or credentials; implementations may use a search API, a catalogue, or a
 * local index.
 */
export interface SourceResolver {
  readonly kind: string;
  resolve(source: SourceReference): Promise<string | null>;
}
