import { describe, expect, it } from "vitest";
import fixture from "../../data/cohen-bard.json" with { type: "json" };
import { CORPUS, type CorpusPage } from "../../data/research-corpus";
import { LineageTree } from "../../shared/tree";
import { MockGptZero } from "../gptzero/client";
import { MemoryIndex } from "./candidate-index";
import { discover } from "./discovery";
import { computeTimings, scoreEdge } from "./edges";
import type { CandidateDocument } from "./extract";
import { runResearch } from "./pipeline";
import { CorpusFetcher, CorpusSearch, type PageFetcher, type SearchProvider } from "./providers";

const CLAIM = fixture.falsehood.claim;
const fixedNow = () => new Date("2026-09-19T12:00:00Z");

function providers(pages: CorpusPage[] = CORPUS) {
  return { search: new CorpusSearch(pages), fetcher: new CorpusFetcher(pages) };
}

async function reconstruct(pages: CorpusPage[] = CORPUS, extra: { include_ai_evidence?: boolean } = {}) {
  return runResearch({ claim: CLAIM, ...extra }, { ...providers(pages), index: new MemoryIndex(), detector: new MockGptZero(fixedNow), now: fixedNow });
}

const ID = {
  bard: "exhibits-court-archive-cohen-exhibit-b-chatbot-response",
  email: "exhibits-court-archive-cohen-exhibit-c-email-to-counsel",
  motion: "dockets-court-archive-cohen-18-cr-602-doc-95-motion",
  order: "dockets-court-archive-cohen-18-cr-602-doc-97-order-to-show-cause",
  digest: "docket-digest-2023-12-01-cohen-supervised-release",
  wire: "legal-wire-news-judge-questions-cohen-citations",
  declaration: "dockets-court-archive-cohen-18-cr-602-doc-102-cohen-declaration",
  ledger: "daily-ledger-2023-12-29-cohen-bard-fake-cases",
  blog: "lawtech-roundup-posts-ai-citations-week",
  forum: "forum-practitioners-t-cohen-bard-cases-4411",
  misdated: "aggregator-archive-ai-cases-explainer",
  tracker: "ai-hallucination-tracker-cases-cohen",
  avianca: "legal-wire-news-lawyers-sanctioned-chatgpt-avianca",
  realOrtiz: "opinions-appeals-2021-united-states-v-ortiz",
  cohenNews: "daily-ledger-2023-11-30-cohen-seeks-early-end-to-supervision",
};

describe("discovery", () => {
  it("starts from the claim alone and finds a messy pool through search and links", async () => {
    const result = await discover({ claim: CLAIM }, providers());
    expect(result.fabricated).toEqual([
      "United States v. Figueroa-Florez",
      "United States v. Ortiz",
      "United States v. Amato",
    ]);
    const ids = result.documents.map((doc) => doc.id);
    // Decoys are discovered too; deciding what belongs is the tree builder's job.
    expect(ids).toEqual(expect.arrayContaining(Object.values(ID)));
    expect(result.queries[0]).toBe('"United States v. Figueroa-Florez"');
    // Some pages are only reachable by following links from relevant pages.
    expect(result.documents.some((doc) => doc.discovered_via.some((via) => via.startsWith("link from")))).toBe(true);
  });

  it("never reads the seed case's recorded chain", async () => {
    const tree = await reconstruct();
    const recorded = new Set(fixture.chain.map((node) => node.url));
    expect(tree.nodes.some((node) => recorded.has(node.url))).toBe(false);
  });

  it("respects the document budget", async () => {
    const result = await discover({ claim: CLAIM }, providers(), { maxDocuments: 5 });
    expect(result.documents.length).toBeLessThanOrEqual(5);
  });

  it("derives fabricated citations from a seed page when the claim names none", async () => {
    const result = await discover(
      { claim: "a motion cited cases that do not exist", seedUrl: "https://docket-digest.test/2023/12/01/cohen-supervised-release" },
      providers(),
    );
    expect(result.seedId).toBe(ID.digest);
    expect(result.fabricated).toHaveLength(3);
    expect(result.documents.find((doc) => doc.id === ID.digest)?.fabricated_citations).toHaveLength(3);
  });

  it("returns the recovered reconstruction as partial with a structured fetch diagnostic", async () => {
    const missing = "https://sources.test/unavailable";
    const corpusSearch = new CorpusSearch(CORPUS);
    const corpusFetcher = new CorpusFetcher(CORPUS);
    const search: SearchProvider = {
      kind: "offline-corpus",
      async search(query, limit) {
        return [{ url: missing, title: "Unavailable source", published: null }, ...(await corpusSearch.search(query, limit))];
      },
    };
    const fetcher: PageFetcher = {
      async fetch(url) {
        if (url === missing) throw new Error("network unavailable");
        return corpusFetcher.fetch(url);
      },
    };
    const tree = await runResearch({ claim: CLAIM }, { search, fetcher, index: new MemoryIndex(), now: fixedNow });

    expect(tree.status).toBe("partial");
    expect(tree.edges.length).toBeGreaterThan(0);
    expect(tree.diagnostics).toContainEqual(
      expect.objectContaining({ stage: "fetch", source: missing, category: "network-error", recoverable: true }),
    );
    expect(() => LineageTree.parse(tree)).not.toThrow();
  });
});

describe("tree reconstruction from the messy pool", () => {
  it("recovers the propagation chain with branching and a single root", async () => {
    const tree = await reconstruct();
    expect(() => LineageTree.parse(tree)).not.toThrow();
    expect(tree.root_ids).toEqual([ID.bard]);
    const parents = (child: string) =>
      tree.edges.filter((edge) => edge.child_id === child).map((edge) => edge.parent_id).sort();
    expect(parents(ID.email)).toEqual([ID.bard]);
    expect(parents(ID.motion)).toEqual([ID.email]);
    expect(parents(ID.digest)).toEqual([ID.motion]);
    expect(parents(ID.order)).toEqual([ID.motion]);
    expect(parents(ID.wire)).toEqual([ID.order]);
    expect(parents(ID.misdated)).toEqual([ID.wire]);
    expect(parents(ID.declaration)).toEqual([ID.order]);
    expect(parents(ID.ledger)).toEqual([ID.declaration, ID.wire].sort());
    expect(parents(ID.forum)).toEqual([ID.ledger]);
    expect(parents(ID.blog)).toEqual([ID.ledger]);
    expect(parents(ID.tracker)).toEqual([ID.ledger, ID.wire].sort());
  });

  it("excludes decoys with reasons: another AI incident, a real same-name case, topical coverage", async () => {
    const tree = await reconstruct();
    const excluded = Object.fromEntries(tree.excluded.map((entry) => [entry.id, entry.reason]));
    expect(Object.keys(excluded).sort()).toEqual([ID.cohenNews, ID.avianca, ID.realOrtiz].sort());
    expect(excluded[ID.realOrtiz]).toContain("1 of 3");
    expect(tree.nodes.map((node) => node.id)).not.toContain(ID.avianca);
  });

  it("does not let a backdated page parent the origin, and flags its date", async () => {
    const tree = await reconstruct();
    const misdated = tree.nodes.find((node) => node.id === ID.misdated)!;
    expect(misdated.timestamp?.startsWith("2023-10-01")).toBe(true);
    expect(misdated.timestamp_conflict).toContain(ID.wire);
    expect(misdated.earliest_possible?.startsWith("2023-12-13")).toBe(true);
    const rejected = tree.rejected_edges.find((edge) => edge.parent_id === ID.misdated && edge.child_id === ID.bard);
    expect(rejected?.reason).toMatch(/links to material from 2023-12-13/);
  });

  it("places an undated page only through what it links to", async () => {
    const tree = await reconstruct();
    const forum = tree.nodes.find((node) => node.id === ID.forum)!;
    expect(forum.timestamp).toBeNull();
    expect(forum.earliest_possible?.startsWith("2023-12-29")).toBe(true);
    const edge = tree.edges.find((candidate) => candidate.child_id === ID.forum)!;
    expect(edge.explicit_link).toBe(true);
    expect(edge.temporal.ordering).toBe("from-link");
  });

  it("never lets a later document parent an earlier one", async () => {
    const tree = await reconstruct();
    const time = new Map(tree.nodes.map((node) => [node.id, Date.parse(node.earliest_possible!)]));
    for (const edge of tree.edges) expect(time.get(edge.parent_id)!).toBeLessThanOrEqual(time.get(edge.child_id)!);
    const later = tree.rejected_edges.filter((edge) => edge.child_id === ID.bard && edge.confidence === 0);
    expect(later.length).toBeGreaterThan(0);
  });

  it("explains each accepted edge: basis, mutations, timing, links and alternatives", async () => {
    const tree = await reconstruct();
    const motion = tree.edges.find((edge) => edge.child_id === ID.motion)!;
    expect(motion.shared_mutations).toHaveLength(3);
    expect(motion.explicit_link).toBe(false);
    expect(motion.rare_shared_phrases).toBeGreaterThan(0);
    expect(motion.temporal).toMatchObject({ ordering: "strict" });
    expect(motion.temporal.gap_days).toBeGreaterThan(3);
    expect(motion.alternatives.map((alt) => alt.candidate_id)).toContain(ID.bard);
    expect(motion.basis).toContain("copied 6-word phrase");

    const ledger = tree.edges.filter((edge) => edge.child_id === ID.ledger);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((edge) => edge.explicit_link)).toBe(true);
    expect(ledger.flatMap((edge) => edge.alternatives.map((alternative) => alternative.candidate_id))).not.toEqual(
      expect.arrayContaining([ID.declaration, ID.wire]),
    );
  });

  it("describes claim mutations on every accepted relationship", async () => {
    const tree = await reconstruct();
    expect(tree.edges.every((edge) => edge.claim_mutations.length > 0)).toBe(true);
    const orderToWire = tree.edges.find((edge) => edge.parent_id === ID.order && edge.child_id === ID.wire)!;
    expect(orderToWire.claim_mutations.map((mutation) => mutation.type)).toEqual(
      expect.arrayContaining(["added", "omitted"]),
    );
    expect(orderToWire.claim_mutations.every((mutation) => mutation.summary.length > 10)).toBe(true);
  });

  it("keeps copied phrasing without a link below strong-propagation confidence", async () => {
    const tree = await reconstruct();
    const blog = tree.edges.find((edge) => edge.child_id === ID.blog)!;
    expect(blog.explicit_link).toBe(false);
    expect(blog.rare_shared_phrases).toBeGreaterThanOrEqual(3);
    expect(blog.confidence).toBeLessThan(0.5);
    expect(blog.type).toBe("similarity");
  });

  it("is deterministic regardless of corpus order", async () => {
    const a = await reconstruct();
    const b = await reconstruct([...CORPUS].reverse());
    const edges = (tree: LineageTree) =>
      tree.edges.map((edge) => `${edge.parent_id}>${edge.child_id}:${edge.confidence}`).sort();
    expect(edges(b)).toEqual(edges(a));
    expect(b.root_ids).toEqual(a.root_ids);
  });

  it("is byte-stable for repeated deterministic fixture runs", async () => {
    const a = await reconstruct();
    const b = await reconstruct();
    expect(b).toEqual(a);
  });

  it("records GPTZero evidence on nodes without changing any edge", async () => {
    const without = await reconstruct();
    const withAi = await reconstruct(CORPUS, { include_ai_evidence: true });
    expect(withAi.nodes.every((node) => node.ai_evidence?.provider === "gptzero")).toBe(true);
    expect(withAi.edges).toEqual(without.edges);
    expect(withAi.root_ids).toEqual(without.root_ids);
  });

  it("fails clearly when no fabricated citation can be identified", async () => {
    await expect(
      runResearch({ claim: "something false" }, { ...providers(), index: new MemoryIndex() }),
    ).rejects.toThrow(/fabricated citations/);
  });
});

describe("edge scoring rules", () => {
  function doc(id: string, overrides: Partial<CandidateDocument>): CandidateDocument {
    return {
      id,
      canonical_id: `sha256:${"0".repeat(64)}`,
      content_fingerprint: "0".repeat(64),
      url: `https://${id}.example/`,
      mirror_urls: [],
      publisher: id,
      title: id,
      timestamp: null,
      timestamp_source: "none",
      timestamp_confidence: "none",
      timestamp_conflict: null,
      text: "",
      passage: "",
      outbound_links: [],
      case_names: [],
      fabricated_citations: [],
      citation_variants: [],
      discovered_via: ["test"],
      ...overrides,
    };
  }

  it("keeps pure textual similarity low even when the text is nearly identical", () => {
    const text = "Cohen asked the court to end supervised release early, citing his compliance with every condition.";
    const parent = doc("p", { timestamp: "2023-12-01T00:00:00Z", text });
    const child = doc("c", { timestamp: "2023-12-02T00:00:00Z", text: `${text} More.` });
    const edge = scoreEdge(parent, child, { timings: computeTimings([parent, child]), eligibleParents: [parent] });
    expect(edge.signals.similarity).toBeGreaterThan(0.8);
    expect(edge.confidence).toBeLessThanOrEqual(0.25);
  });

  it("does not count a shared quotation of a primary source as copied phrasing", () => {
    const quote = '"the Court has been unable to locate any of these three decisions and counsel shall show cause"';
    const fab = ["A v. B", "C v. D", "E v. F"];
    const parent = doc("p", { timestamp: "2023-12-13T10:00:00Z", fabricated_citations: fab, text: `Wire story. The judge wrote ${quote}.` });
    const child = doc("c", { timestamp: "2023-12-13T18:00:00Z", fabricated_citations: fab, text: `Blog post. As the order put it, ${quote}.` });
    const edge = scoreEdge(parent, child, { timings: computeTimings([parent, child]), eligibleParents: [parent] });
    expect(edge.signals.unique_phrases).toBe(0);
  });

  it("does not claim direction for same-time documents without a link", () => {
    const fab = ["A v. B", "C v. D", "E v. F"];
    const text = "Identical syndicated wire copy about the fabricated citations in the motion.";
    const a = doc("a", { timestamp: "2023-12-13T00:00:00Z", fabricated_citations: fab, text });
    const b = doc("b", { timestamp: "2023-12-13T00:00:00Z", fabricated_citations: fab, text });
    const edge = scoreEdge(a, b, { timings: computeTimings([a, b]), eligibleParents: [a] });
    expect(edge.signals.ordering).toBe("same-time");
    expect(edge.strong).toBe(false);
  });

  it("treats a parent that links to the child as impossible", () => {
    const child = doc("c", { timestamp: "2023-12-01T00:00:00Z" });
    const parent = doc("p", { timestamp: "2023-11-01T00:00:00Z", outbound_links: [child.url] });
    const edge = scoreEdge(parent, child, { timings: computeTimings([parent, child]), eligibleParents: [] });
    expect(edge.impossible).toContain("links to");
    expect(edge.confidence).toBe(0);
  });

  it("does not accept order from an untrustworthy timestamp", () => {
    const fab = ["A v. B", "C v. D", "E v. F"];
    const parent = doc("p", { fabricated_citations: fab });
    const child = doc("c", { timestamp: "2023-12-02T00:00:00Z", fabricated_citations: fab });
    const edge = scoreEdge(parent, child, { timings: computeTimings([parent, child]), eligibleParents: [parent] });
    expect(edge.signals.ordering).toBe("unknown");
    expect(edge.strong).toBe(false);
    expect(edge.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe("live-provider plumbing", () => {
  it("uses search-result dates when a page has none of its own", async () => {
    const pages: CorpusPage[] = [
      {
        url: "https://undated.example/story",
        search_published: "2023-12-20",
        html: "<html><body><article><p>United States v. Ortiz and United States v. Amato and United States v. Figueroa-Florez.</p></article></body></html>",
      },
    ];
    const search: SearchProvider = new CorpusSearch(pages);
    const fetcher: PageFetcher = new CorpusFetcher(pages);
    const result = await discover({ claim: CLAIM }, { search, fetcher });
    expect(result.documents[0]?.timestamp_source).toBe("search-result");
  });
});
