import { detectContentKind } from "../content-type";
import type { FetchedPage, PageFetcher } from "./types";

export interface DirectHttpFetcherOptions {
  /** Network budget for one request, including redirects. */
  timeoutMs?: number;
  /** Injectable for deterministic tests or an application-specific HTTP client. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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

/**
 * Fetches direct evidence with Node's built-in HTTP client. Redirects are followed, HTTP failures
 * and network errors are nonfatal, and only HTML/PDF responses cross the provider boundary.
 */
export class DirectHttpFetcher implements PageFetcher {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DirectHttpFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    if (!isHttpUrl(url)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { redirect: "follow", signal: controller.signal });
      // Treat all non-success responses as absent evidence. In particular, dead links and server
      // errors can proceed to optional source resolution without stopping a lineage run.
      if (!response.ok) return null;

      const bytes = new Uint8Array(await response.arrayBuffer());
      const finalUrl = response.url || url;
      const contentType = response.headers.get("content-type");
      const kind = detectContentKind({ contentType, url: finalUrl, bytes });
      if (kind === "html") return { url: finalUrl, kind, html: decodeHtml(bytes, contentType) };
      if (kind === "pdf") return { url: finalUrl, kind, bytes };
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
