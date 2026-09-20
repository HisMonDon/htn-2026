import { describe, expect, it, vi } from "vitest";
import { extractDocument, type CandidateDocument } from "./extract";
import { BraveSearchProvider, type SearchHit, type SearchProvider } from "./providers";
import { WebSearchProposer, createWebSearchProposer, planWebQueries, type WebSearchDebugEvent } from "./web-proposer";

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM =
  "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, three Second Circuit decisions that it says granted early termination of supervised release #93001cf7 in similar circumstances.";

function documentOf(text: string, url = "https://submitted.test/claim", fabricated: string[] = FABRICATED): CandidateDocument {
  return extractDocument({
    url,
    html: `<html><head><title>Submitted text</title></head><body><article><p>${text}</p></article></body></html>`,
    fabricated,
    claimTerms: [],
    discoveredVia: "submitted-text",
  });
}

function hit(url: string, title = "", snippet: string | null = null): SearchHit {
  return { url, title, published: null, snippet };
}

function search(handler: (query: string, limit: number) => SearchHit[] | Error): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    kind: "fake",
    search: vi.fn(async (query: string, limit: number) => {
      const result = handler(query, limit);
      if (result instanceof Error) throw result;
      return result;
    }),
  } as never;
}

describe("planWebQueries", () => {
  it("builds targeted queries from case names, topic words and a distinctive fragment", () => {
    const plan = planWebQueries(documentOf(CLAIM), { maxQueries: 8 });

    expect(plan.queries).toContain('"United States v. Figueroa-Florez" early termination supervised release');
    expect(plan.queries).toContain('"United States v. Ortiz" early termination supervised release');
    expect(plan.queries).toContain('"United States v. Amato" early termination supervised release');
    expect(plan.queries).toContain("Figueroa-Florez Ortiz Amato");
    expect(plan.queries.some((query) => query.includes("early termination of supervised release #93001cf7"))).toBe(true);
    expect(plan.anchors).toEqual(expect.arrayContaining(["figueroa", "florez", "ortiz", "amato"]));
  });

  it("uses quoted passages, entities and mentioned URLs, and skips generic text entirely", () => {
    const rich = planWebQueries(
      documentOf('Dr. Maria Okafor of the Lagos Institute said "microplastics degrade within twenty four hours" in a study at https://nature.example/paper1 on the Vantor enzyme.', "https://a.test/x", []),
      { maxQueries: 8 },
    );
    expect(rich.queries).toContain('"microplastics degrade within twenty four hours"');
    expect(rich.queries).toContain('"https://nature.example/paper1"');
    expect(rich.queries.some((query) => query.includes("Lagos Institute"))).toBe(true);

    expect(planWebQueries(documentOf("It is what it is and they said that.", "https://a.test/y", [])).queries).toEqual([]);
  });

  it("never exceeds the query cap, repeats a query, or exceeds the search API length limit", () => {
    const plan = planWebQueries(documentOf(CLAIM), { maxQueries: 3 });
    expect(plan.queries).toHaveLength(3);
    const all = planWebQueries(documentOf(CLAIM.repeat(6)), { maxQueries: 20 }).queries;
    expect(new Set(all.map((query) => query.toLowerCase())).size).toBe(all.length);
    expect(all.every((query) => query.length <= 200)).toBe(true);
  });

  it("does not query for the document's own URL", () => {
    const own = "https://nature.example/paper1";
    const plan = planWebQueries(documentOf(`See ${own} for the Vantor enzyme study by the Lagos Institute.`, own, []), { maxQueries: 8 });
    expect(plan.queries.some((query) => query.includes(own))).toBe(false);
  });
});

describe("WebSearchProposer", () => {
  const doc = () => documentOf(CLAIM);

  it("respects the query, per-query result, and per-node candidate limits", async () => {
    let call = 0;
    const provider = search(() => {
      call += 1;
      return Array.from({ length: 10 }, (_, index) => hit(`https://results.test/q${call}/${index}`, "United States v. Ortiz supervised release"));
    });
    const proposals = await new WebSearchProposer(provider, { maxQueries: 2, resultsPerQuery: 3, maxCandidates: 4 }).analyze(doc());

    expect(provider.search).toHaveBeenCalledTimes(2);
    for (const call of provider.search.mock.calls) expect(call[1]).toBe(3);
    expect(proposals).toHaveLength(4);
  });

  it("collapses the same URL across queries into one candidate and tags it as a web-search discovery", async () => {
    const provider = search(() => [hit("https://Results.test/opinion/?utm_source=x", "United States v. Ortiz"), hit("https://results.test/opinion", "United States v. Ortiz")]);
    const proposals = await new WebSearchProposer(provider, { maxQueries: 3 }).analyze(doc());

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ url: "https://Results.test/opinion/?utm_source=x", discovered_by: ["web-search"] });
  });

  it("drops results that share nothing with the document, non-http URLs, and the document itself", async () => {
    const provider = search(() => [
      hit("https://relevant.test/a", "United States v. Amato decided"),
      hit("https://noise.test/b", "Ten tomato recipes", "Gardening advice"),
      hit("ftp://files.test/c", "United States v. Amato"),
      hit("https://submitted.test/claim", "United States v. Amato"),
    ]);
    const proposals = await new WebSearchProposer(provider).analyze(doc());
    expect(proposals.map((proposal) => proposal.url)).toEqual(["https://relevant.test/a"]);
  });

  it("ranks exact-phrase and anchor matches above weak matches before applying the cap", async () => {
    const provider = search(() => [
      hit("https://weak.test/1", "Circuit news roundup"),
      hit("https://strong.test/2", "United States v. Figueroa-Florez", "United States v. Ortiz and United States v. Amato"),
    ]);
    const proposals = await new WebSearchProposer(provider, { maxCandidates: 1 }).analyze(doc());
    expect(proposals.map((proposal) => proposal.url)).toEqual(["https://strong.test/2"]);
  });

  it("proposes nothing and issues no search when the document has nothing distinctive to search for", async () => {
    const provider = search(() => [hit("https://x.test/a", "anything")]);
    const proposals = await new WebSearchProposer(provider).analyze(documentOf("It is what it is and they said that.", "https://a.test/y", []));
    expect(proposals).toEqual([]);
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("survives individual failed queries, but reports a provider failure when every query fails", async () => {
    let calls = 0;
    const flaky = search(() => (calls++ === 0 ? new Error("boom") : [hit("https://relevant.test/a", "United States v. Ortiz")]));
    const events: WebSearchDebugEvent[] = [];
    const proposals = await new WebSearchProposer(flaky, { onDebug: (event) => events.push(event) }).analyze(doc());
    expect(proposals).toHaveLength(1);
    expect(events[0]?.failed_queries).toHaveLength(1);

    const down = search(() => new Error("search API down"));
    await expect(new WebSearchProposer(down).analyze(doc())).rejects.toThrow("search API down");
  });

  it("is disabled (no proposer) without an API key", () => {
    expect(createWebSearchProposer({ apiKey: null })).toBeNull();
    expect(createWebSearchProposer({ apiKey: "k" })).toBeInstanceOf(WebSearchProposer);
  });
});

describe("BraveSearchProvider", () => {
  it("maps the API response, sends the key only as a header, and clamps count", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const provider = new BraveSearchProvider("secret-key", {
      fetchImpl: (async (url: URL, init: RequestInit) => {
        seen = { url: String(url), headers: init.headers as Record<string, string> };
        return Response.json({ web: { results: [{ url: "https://a.test/1", title: "A", description: "snip", page_age: "2024-01-01T00:00:00" }, { title: "no url" }] } });
      }) as never,
    });
    const hits = await provider.search('"exact phrase"', 100);

    expect(hits).toEqual([{ url: "https://a.test/1", title: "A", published: "2024-01-01T00:00:00", snippet: "snip" }]);
    expect(seen!.headers["x-subscription-token"]).toBe("secret-key");
    expect(seen!.url).not.toContain("secret-key");
    expect(new URL(seen!.url).searchParams.get("count")).toBe("20");
  });

  it("throws a key-free error on a non-2xx response", async () => {
    const provider = new BraveSearchProvider("secret-key", { fetchImpl: (async () => new Response("no", { status: 429 })) as never });
    await expect(provider.search("q", 3)).rejects.toThrow("Brave search returned 429");
  });
});
