import { describe, expect, it } from "vitest";
import { CORPUS } from "../../data/research-corpus";
import { extractDocument } from "./extract";
import { CorpusFetcher, CorpusSearch, SearchSourceResolver } from "./providers";
import { traverseProvenance, type UpstreamAnalysis, type UpstreamSourceProposer } from "./traversal";

/**
 * Exercises the real Cohen/Bard demo path end to end: a candidate-source proposal (the shape any
 * upstream-source proposer, including GPTZero's bibliography scan, must produce -- see
 * `UpstreamProposal` in `./traversal.ts`) drives `traverseProvenance`, which acquires each candidate
 * through the real fetch/resolve/canonicalize path (offline corpus standing in for the network). The
 * deterministic scorer in `edges.ts` -- not this test -- decides every accepted or rejected edge.
 * Nothing here mocks the validator, cycle protection, or mutation analysis. GPTZero's own
 * request/response mapping (`server/gptzero/bibliography.ts`) is exercised by its own test suite;
 * this test starts one boundary later, at the provider-neutral proposal traversal actually consumes.
 */

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM =
  "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, " +
  "three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.";
const SEED_URL = "https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases";

/** A candidate-source proposer stand-in, scripted per source URL. Every proposal it returns is
 * still just a pointer to a pair of documents: acceptance is decided entirely by `traverseProvenance` /
 * `scoreEdge` against the real fetched content, exactly as for the live GPTZero proposer. */
function scriptedProposer(routes: Map<string, string[]>): UpstreamSourceProposer {
  return {
    async analyze(document): Promise<UpstreamAnalysis> {
      return (routes.get(document.url) ?? []).map((url) => ({ url }));
    },
  };
}

describe("Cohen demo: recursive provenance traversal against the offline corpus", () => {
  it("acquires, validates, reconstructs, and explains a real multi-hop chain", async () => {
    const seedPage = CORPUS.find((page) => page.url === SEED_URL)!;
    const seed = extractDocument({
      url: seedPage.url,
      html: seedPage.html,
      fabricated: FABRICATED,
      claimTerms: [],
      discoveredVia: "integration-test-seed",
    });

    const proposer = scriptedProposer(
      new Map([
        [
          SEED_URL,
          [
            "https://dockets.court-archive.test/cohen/18-cr-602/doc-102-cohen-declaration",
            "https://legal-wire.test/news/judge-questions-cohen-citations",
          ],
        ],
        [
          "https://dockets.court-archive.test/cohen/18-cr-602/doc-102-cohen-declaration",
          ["https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause"],
        ],
        [
          "https://legal-wire.test/news/judge-questions-cohen-citations",
          ["https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause"],
        ],
        [
          "https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause",
          ["https://dockets.court-archive.test/cohen/18-cr-602/doc-95-motion"],
        ],
        ["https://dockets.court-archive.test/cohen/18-cr-602/doc-95-motion", []],
      ]),
    );

    const search = new CorpusSearch(CORPUS);
    const result = await traverseProvenance(
      { seed, claim: CLAIM, fabricated: FABRICATED },
      { proposer, fetcher: new CorpusFetcher(CORPUS), resolver: new SearchSourceResolver(search) },
    );

    expect(result.status).toBe("complete");
    expect(result.rejected_edges).toEqual([]);

    const byId = new Map(result.documents.map((document) => [document.id, document.url]));
    const acceptedUrls = result.accepted_edges.map((edge) => `${byId.get(edge.parent_id)} -> ${byId.get(edge.child_id)}`).sort();
    expect(acceptedUrls).toEqual(
      [
        "https://dockets.court-archive.test/cohen/18-cr-602/doc-102-cohen-declaration -> https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases",
        "https://dockets.court-archive.test/cohen/18-cr-602/doc-95-motion -> https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause",
        "https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause -> https://dockets.court-archive.test/cohen/18-cr-602/doc-102-cohen-declaration",
        "https://dockets.court-archive.test/cohen/18-cr-602/doc-97-order-to-show-cause -> https://legal-wire.test/news/judge-questions-cohen-citations",
        "https://legal-wire.test/news/judge-questions-cohen-citations -> https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases",
      ].sort(),
    );

    // Every accepted edge carries evidence a judge can inspect: real shared fabrications, a real
    // explicit link, real dates, and real per-sentence mutation analysis -- not a numeric score alone.
    for (const edge of result.accepted_edges) {
      expect(edge.confidence).toBeGreaterThan(0);
      expect(edge.basis.length).toBeGreaterThan(0);
      expect(edge.explicit_link).toBe(true);
      expect(edge.shared_mutations).toEqual(expect.arrayContaining(FABRICATED));
      expect(edge.temporal.ordering).not.toBe("unknown");
      expect(edge.temporal.parent_time).not.toBeNull();
      expect(edge.temporal.child_time).not.toBeNull();
    }

    // The motion is the deepest accepted ancestor: it proposes nothing further and terminates cleanly.
    const motionUrl = "https://dockets.court-archive.test/cohen/18-cr-602/doc-95-motion";
    expect(result.terminations).toContainEqual(expect.objectContaining({ url: motionUrl, reason: "no-proposals" }));

    expect(result.stats.fetched).toBe(4);
    expect(result.stats.fetch_failures).toBe(0);
  });

  it("reports a real network/provider failure as a nonfatal termination instead of a false chain", async () => {
    const seedPage = CORPUS.find((page) => page.url === SEED_URL)!;
    const seed = extractDocument({
      url: seedPage.url,
      html: seedPage.html,
      fabricated: FABRICATED,
      claimTerms: [],
      discoveredVia: "integration-test-seed",
    });
    const failingProposer: UpstreamSourceProposer = {
      async analyze(): Promise<UpstreamAnalysis> {
        throw new Error("simulated GPTZero outage");
      },
    };

    const result = await traverseProvenance(
      { seed, claim: CLAIM, fabricated: FABRICATED },
      { proposer: failingProposer, fetcher: new CorpusFetcher(CORPUS) },
    );

    expect(result.accepted_edges).toEqual([]);
    expect(result.terminations).toEqual([
      expect.objectContaining({ url: SEED_URL, reason: "provider-failure", detail: "simulated GPTZero outage" }),
    ]);
  });
});
