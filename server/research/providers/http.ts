import { detectContentKind } from "../content-type";
import type { FetchFailure, FetchResult, FetchedPage, PageFetcher } from "./types";

export interface DirectHttpFetcherOptions {
  /** Network budget for one request, including redirects. */
  timeoutMs?: number;
  /** Injectable for deterministic tests or an application-specific HTTP client. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 100;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function charset(contentType: string | null): string {
  const match = contentType?.match(/;\s*charset\s*=\s*([^;\s]+)/i);
  return match?.[1]?.replace(/^['"]|['"]$/g, "") || "utf-8";
}

function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  try {
    return new TextDecoder(charset(contentType)).decode(bytes);
  } catch {
    // A bad or unsupported charset label must not discard otherwise valid HTML evidence.
    return new TextDecoder().decode(bytes);
  }
}

function failure(
  url: string,
  category: FetchFailure["category"],
  message: string,
  recoverable: boolean,
  status: number | null = null,
): FetchFailure {
  return { stage: "fetch", category, message, recoverable, status, url };
}

function httpFailure(url: string, status: number): FetchFailure {
  if (status === 401) return failure(url, "http-401", "source request was not authorized", false, status);
  if (status === 403) return failure(url, "http-403", "source request was forbidden", false, status);
  if (status === 404) return failure(url, "http-404", "source was not found", false, status);
  if (status === 429) return failure(url, "http-429", "source request was rate limited", true, status);
  if (status >= 500) return failure(url, "http-5xx", "source server returned an error", true, status);
  return failure(url, "http-error", `source request returned HTTP ${status}`, false, status);
}

function errorFailure(url: string, error: unknown, timedOut: boolean): FetchFailure {
  if (timedOut) return failure(url, "timeout", "source request timed out", true);
  if (/redirect/i.test(error instanceof Error ? error.message : String(error))) {
    return failure(url, "redirect-error", "source redirect could not be followed", false);
  }
  return failure(url, "network-error", "source network request failed", true);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches direct evidence with Node's built-in HTTP client. Redirects are followed, HTTP failures
 * and network errors are nonfatal, and only HTML/PDF responses cross the provider boundary.
 */
export class DirectHttpFetcher implements PageFetcher {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: DirectHttpFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    const result = await this.fetchDetailed(url);
    return result.ok ? result.page : null;
  }

  async fetchDetailed(url: string): Promise<FetchResult> {
    if (!isHttpUrl(url)) {
      return { ok: false, failure: failure(url, "invalid-url", "source URL is not HTTP(S)", false) };
    }

    let last: FetchFailure | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { redirect: "follow", signal: controller.signal });
        if (!response.ok) {
          last = httpFailure(url, response.status);
        } else {
          let bytes: Uint8Array | null = null;
          try {
            bytes = new Uint8Array(await response.arrayBuffer());
          } catch {
            last = failure(url, "response-read-failed", "source response could not be read", true, response.status);
          }
          if (bytes) {
            const finalUrl = response.url || url;
            const contentType = response.headers.get("content-type");
            const kind = detectContentKind({ contentType, url: finalUrl, bytes });
            if (kind === "html") return { ok: true, page: { url: finalUrl, kind, html: decodeHtml(bytes, contentType) } };
            if (kind === "pdf") return { ok: true, page: { url: finalUrl, kind, bytes } };
            last = failure(finalUrl, "unsupported-content", "source response is not HTML or PDF", false, response.status);
          }
        }
      } catch (error) {
        last = errorFailure(url, error, controller.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
      const failed = last ?? failure(url, "network-error", "source network request failed", true);
      if (!failed.recoverable || attempt === this.maxRetries) return { ok: false, failure: failed };
      if (this.retryDelayMs > 0) await wait(this.retryDelayMs);
    }
    return { ok: false, failure: last ?? failure(url, "network-error", "source network request failed", true) };
  }
}
