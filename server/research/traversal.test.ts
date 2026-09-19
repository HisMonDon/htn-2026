import { describe, expect, it, vi } from "vitest";
import { canonicalUrl, extractDocument, type CandidateDocument } from "./extract";
import type { PageFetcher } from "./providers";
import { traverseProvenance, type ProposedUpstreamSource, type UpstreamSourceProposer } from "./traversal";

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM = `The filing cites ${FABRICATED.join(", ")}.`;

interface Page {
  url: string;
  date: string;
  marker: string;
  links?: string[];
  body?: string;
}

function html(page: Page): string {
  const links = (page.links ?? []).map((url) => `<a href="${url}">source</a>`).join(" ");
  const body = page.body ?? `${FABRICATED.join(". ")}. ${page.marker}.`;
  return `<html><head><title>${page.marker}</title><meta property="article:published_time" content="${page.date}T00:00:00Z"></head><body><article><p>${body}</p>${links}</article></body></html>`;
}

function seed(page: Page): CandidateDocument {
  return extractDocument({
    url: page.url,
    html: html(page),
    fabricated: FABRICATED,
    claimTerms: [],
    discoveredVia: "test seed",
  });
}

function fetcher(pages: Page[], calls: string[]): PageFetcher {
  const byUrl = new Map(pages.map((page) => [canonicalUrl(page.url), page]));
  return {
    async fetch(url) {
      calls.push(canonicalUrl(url));
      const page = byUrl.get(canonicalUrl(url));
      return page ? { url: page.url, kind: "html", html: html(page) } : null;
    },
  };
}

function proposer(
  routes: Map<string, readonly ProposedUpstreamSource[] | Error>,
  calls: string[],
): UpstreamSourceProposer {
  return {
    async analyze(document) {
      calls.push(document.url);
      const result = routes.get(document.url) ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function proposed(url: string): ProposedUpstreamSource {
  return { url };
}

function acceptedUrls(result: Awaited<ReturnType<typeof traverseProvenance>>): string[] {
  const byId = new Map(result.documents.map((document) => [document.id, document.url]));
  return result.accepted_edges.map((edge) => `${byId.get(edge.parent_id)}>${byId.get(edge.child_id)}`).sort();
}

describe("recursive provenance traversal", () => {
  it("follows a simple A <- B <- C chain only after each deterministic validation", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], fetchCalls),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(c.url)]], [c.url, []]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${b.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url]);
    expect(fetchCalls).toEqual([b.url, c.url]);
    expect(result.terminations.find((entry) => entry.url === c.url)?.reason).toBe("no-proposals");
  });

  it("resolves an incomplete recursive proposal before fetching it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const fetchCalls: string[] = [];
    const resolver = { kind: "test", resolve: vi.fn(async () => b.url) };

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], fetchCalls),
        resolver,
        proposer: proposer(new Map([[a.url, [{ title: "Original B filing", citation: "B v. Example" }]], [b.url, []]]), []),
      },
    );

    expect(resolver.resolve).toHaveBeenCalledWith({ title: "Original B filing", citation: "B v. Example" });
    expect(fetchCalls).toEqual([b.url]);
    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
  });

  it("branches across multiple validated upstream sources in canonical URL order", async () => {
    const a = {
      url: "https://sources.test/a",
      date: "2023-01-03",
      marker: "A",
      links: ["https://sources.test/b", "https://sources.test/c"],
    };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], []),
        // Return C first to prove the traversal controls its own order.
        proposer: proposer(new Map([[a.url, [proposed(c.url), proposed(b.url)]], [b.url, []], [c.url, []]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${a.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url]);
  });

  it("rejects a suggested edge that would close a cycle", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(a.url)]]]), []),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: a.url, termination: "cycle" }),
    );
  });

  it("identifies an exact-content mirror without treating it as a source edge", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "same artifact" };
    const mirror = { url: "https://mirror.test/copy", date: "2023-01-03", marker: "same artifact" };
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, mirror], fetchCalls),
        proposer: proposer(new Map([[a.url, [proposed(mirror.url)]]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.documents).toHaveLength(1);
    expect([result.documents[0]?.url, ...(result.documents[0]?.mirror_urls ?? [])]).toEqual(expect.arrayContaining([a.url, mirror.url]));
    expect(fetchCalls).toEqual([mirror.url]);
    expect(result.rejected_edges[0]).toMatchObject({ termination: "duplicate-source", parent_url: mirror.url });
  });

  it("keeps a rejected proposed parent for debugging and does not recurse into it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const b = {
      url: "https://sources.test/b",
      date: "2023-01-02",
      marker: "unrelated evidence",
      body: "An unrelated report about weather patterns and local conditions.",
    };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), providerCalls),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(providerCalls).toEqual([a.url]);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ parent_url: b.url, termination: "validation-rejected" }));
    expect(result.terminations[0]).toMatchObject({ url: a.url, reason: "all-proposals-rejected" });
  });

  it("records a provider failure as a nonfatal source termination", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a], []),
        proposer: proposer(new Map([[a.url, new Error("provider unavailable")]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.terminations).toEqual([
      expect.objectContaining({ url: a.url, reason: "provider-failure", detail: "provider unavailable" }),
    ]);
  });

  it("records a fetch failure without interrupting the traversal", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A" };
    const missing = "https://sources.test/missing";
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a], []),
        proposer: proposer(new Map([[a.url, [proposed(missing)]]]), []),
      },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toContainEqual(
      expect.objectContaining({ parent_url: missing, termination: "fetch-failure", reason: "not-found" }),
    );
    expect(result.terminations).toEqual([expect.objectContaining({ url: a.url, reason: "all-proposals-rejected" })]);
  });

  it("pauses an asynchronous analysis job and resumes it with the durable job ID", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const calls: string[] = [];
    const asyncProposer: UpstreamSourceProposer = {
      async analyze(document, continuation) {
        calls.push(`${document.url}:${continuation?.job_id ?? "new"}`);
        if (document.url === a.url && !continuation) return { status: "pending", job_id: "analysis-a", retry_after_ms: 250 };
        if (document.url === a.url) return [proposed(b.url)];
        return [];
      },
    };
    const input = { seed: seed(a), claim: CLAIM, fabricated: FABRICATED };

    const paused = await traverseProvenance(input, { fetcher: fetcher([a, b], []), proposer: asyncProposer });
    expect(paused).toMatchObject({
      status: "paused",
      pending_jobs: [expect.objectContaining({ source_id: paused.documents[0]!.id, job_id: "analysis-a", reason: "provider-pending", retry_after_ms: 250 })],
    });
    expect(paused.accepted_edges).toEqual([]);

    const resumed = await traverseProvenance({ ...input, checkpoint: paused.checkpoint }, { fetcher: fetcher([a, b], []), proposer: asyncProposer });
    expect(resumed.status).toBe("complete");
    expect(acceptedUrls(resumed)).toEqual([`${b.url}>${a.url}`]);
    expect(calls).toEqual([`${a.url}:new`, `${a.url}:analysis-a`, `${b.url}:new`]);
  });

  it("pauses queued work at the provider request budget instead of exceeding it", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B" };
    const calls: string[] = [];
    const input = { seed: seed(a), claim: CLAIM, fabricated: FABRICATED, maxProviderRequests: 1 };

    const paused = await traverseProvenance(
      input,
      { fetcher: fetcher([a, b], []), proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), calls) },
    );
    expect(paused.status).toBe("paused");
    expect(paused.pending_jobs).toEqual([expect.objectContaining({ url: b.url, reason: "rate-limit", retry_after_ms: 60_000 })]);
    expect(calls).toEqual([a.url]);

    const resumed = await traverseProvenance(
      { ...input, checkpoint: paused.checkpoint },
      { fetcher: fetcher([a, b], []), proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, []]]), calls) },
    );
    expect(resumed.status).toBe("complete");
    expect(calls).toEqual([a.url, b.url]);
  });

  it("stops expanding an accepted source at the configured maximum depth", async () => {
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
    const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
    const providerCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED, maxDepth: 1 },
      {
        fetcher: fetcher([a, b, c], []),
        proposer: proposer(new Map([[a.url, [proposed(b.url)]], [b.url, [proposed(c.url)]]]), providerCalls),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`]);
    expect(providerCalls).toEqual([a.url]);
    expect(result.terminations.find((entry) => entry.url === b.url)).toMatchObject({ reason: "max-depth", depth: 1 });
  });

  it("validates a repeated source for both branches but expands it once", async () => {
    const d = { url: "https://sources.test/d", date: "2023-01-01", marker: "D" };
    const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: [d.url] };
    const c = { url: "https://sources.test/c", date: "2023-01-02", marker: "C", links: [d.url] };
    const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: [b.url, c.url] };
    const providerCalls: string[] = [];
    const fetchCalls: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c, d], fetchCalls),
        proposer: proposer(
          new Map([[a.url, [proposed(b.url), proposed(c.url)]], [b.url, [proposed(d.url)]], [c.url, [proposed(d.url)]], [d.url, []]]),
          providerCalls,
        ),
      },
    );

    expect(acceptedUrls(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${a.url}`, `${d.url}>${b.url}`, `${d.url}>${c.url}`]);
    expect(providerCalls).toEqual([a.url, b.url, c.url, d.url]);
    expect(fetchCalls.filter((url) => url === d.url)).toHaveLength(1);
    expect(result.accepted_edges.filter((edge) => edge.parent_id === result.documents.find((document) => document.url === d.url)?.id)).toHaveLength(2);
    expect(result.accepted_edges.filter((edge) => edge.recursed)).toHaveLength(3);
  });
});
