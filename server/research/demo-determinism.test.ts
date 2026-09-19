import { describe, expect, it } from "vitest";
import { CORPUS } from "../../data/research-corpus";
import { extractDocument } from "./extract";
import { CorpusFetcher, CorpusSearch, SearchSourceResolver } from "./providers";
import { traverseProvenance, type UpstreamAnalysis, type UpstreamSourceProposer } from "./traversal";

const fabricated = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const claim =
  "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, " +
  "three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.";
const seedUrl = "https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases";

const proposer: UpstreamSourceProposer = {
  async analyze(document): Promise<UpstreamAnalysis> {
    return document.outbound_links.map((url) => ({ url }));
  },
};

async function runFixture() {
  const page = CORPUS.find((x) => x.url === seedUrl);
  if (!page) throw new Error("missing Cohen demo seed");
  const seed = extractDocument({ url: page.url, html: page.html, fabricated, claimTerms: [], discoveredVia: "deterministic-demo" });
  const search = new CorpusSearch(CORPUS);
  return traverseProvenance(
    { seed, claim, fabricated },
    { proposer, fetcher: new CorpusFetcher(CORPUS), resolver: new SearchSourceResolver(search) },
  );
}

describe("deterministic Cohen traversal fixture", () => {
  it("returns byte-identical provenance output on repeated runs", async () => {
    const a = await runFixture();
    const b = await runFixture();

    expect(a.status).toBe("complete");
    expect(a.accepted_edges.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
