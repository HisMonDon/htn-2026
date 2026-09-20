import { describe, expect, it } from "vitest";
import {
  createDocumentNativeProposer,
  DOCUMENT_NATIVE_CHANNEL,
  DocumentNativeProposer,
  extractDocumentNativeProposals,
} from "./document-native-proposer";
import { canonicalUrl, extractDocument, type CandidateDocument } from "./extract";
import { MultiSourceProposer } from "./multi-proposer";
import { readAuditMetadata, type PageFetcher } from "./providers";
import { traverseProvenance, type UpstreamProposal, type UpstreamSourceProposer } from "./traversal";

const FABRICATED = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM = `The filing cites ${FABRICATED.join(", ")}.`;

/** A minimal, fully-populated CandidateDocument, for unit tests that don't need real HTML parsing. */
function doc(overrides: Partial<CandidateDocument> = {}): CandidateDocument {
  return {
    id: "doc",
    canonical_id: "canonical-doc",
    content_fingerprint: "fingerprint",
    url: "https://news.test/story",
    mirror_urls: [],
    publisher: "News Test",
    title: "Story",
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
    academic_metadata: null,
    ...overrides,
  };
}

describe("extractDocumentNativeProposals: outbound link extraction", () => {
  it("keeps articles, PDFs/reports, government pages, and scholarly links", () => {
    const document = doc({
      outbound_links: [
        "https://bbc.co.uk/news/technology-33604488",
        "https://example.gov/reports/investigation.pdf",
        "https://courtlistener.com/opinion/12345/example/",
        "https://doi.org/10.1234/example.doi",
        "https://arxiv.org/abs/2301.01234",
      ],
    });

    const urls = extractDocumentNativeProposals(document).map((proposal) => proposal.url);

    expect(urls).toEqual([
      "https://bbc.co.uk/news/technology-33604488",
      "https://example.gov/reports/investigation.pdf",
      "https://courtlistener.com/opinion/12345/example/",
      "https://doi.org/10.1234/example.doi",
      "https://arxiv.org/abs/2301.01234",
    ]);
  });

  it("filters login/signup, privacy/terms, social sharing, navigation, home pages, assets, and mailto/tel", () => {
    const document = doc({
      outbound_links: [
        "https://news.test/", // home page
        "https://news.test/login",
        "https://news.test/account/signup",
        "https://news.test/privacy-policy",
        "https://news.test/terms-of-service",
        "https://news.test/about-us",
        "https://news.test/category/world",
        "https://twitter.com/intent/tweet?url=https://news.test/story",
        "https://facebook.com/sharer/sharer.php?u=https://news.test/story",
        "https://news.test/assets/logo.png",
        "https://news.test/app.js",
      ],
    });

    expect(extractDocumentNativeProposals(document)).toEqual([]);
  });

  it("ignores a same-page anchor and mailto/tel links (never reach outbound_links at all)", () => {
    // `parseHtmlPage` only ever adds http(s) links that differ from the canonical page URL, so
    // anchors and mailto/tel never appear in `outbound_links` in the first place; this locks in
    // that upstream contract from the proposer's side too.
    const document = doc({ url: "https://news.test/story", outbound_links: ["mailto:tips@news.test", "tel:+15551234567"] });

    expect(extractDocumentNativeProposals(document)).toEqual([]);
  });
});

describe("extractDocumentNativeProposals: inline text extraction", () => {
  it("extracts a DOI as its own candidate", () => {
    const document = doc({ text: "The original data appears in the study (doi:10.1000/xyz123) published last year." });
    const proposals = extractDocumentNativeProposals(document);
    expect(proposals).toContainEqual(expect.objectContaining({ url: "https://doi.org/10.1000/xyz123", citation: "10.1000/xyz123" }));
  });

  it("extracts an arXiv id as its own candidate", () => {
    const document = doc({ text: "Full details are in the preprint arXiv:2301.01234." });
    const proposals = extractDocumentNativeProposals(document);
    expect(proposals).toContainEqual(expect.objectContaining({ url: "https://arxiv.org/abs/2301.01234", citation: "arXiv:2301.01234" }));
  });

  it("extracts a docket number as a URL-less named source", () => {
    const document = doc({ text: "The order was entered in Case No. 3:20-cv-01234 last spring." });
    const proposals = extractDocumentNativeProposals(document);
    const match = proposals.find((proposal) => proposal.citation === "Case No. 3:20-cv-01234");
    expect(match).toBeDefined();
    expect(match!.url).toBeUndefined();
  });

  it("extracts a raw in-text URL not present as an anchor", () => {
    const document = doc({ text: "The BBC first reported this at https://bbc.co.uk/news/technology-33604488 in 2016." });
    const proposals = extractDocumentNativeProposals(document);
    expect(proposals).toContainEqual(expect.objectContaining({ url: "https://bbc.co.uk/news/technology-33604488" }));
  });

  it("turns already-extracted case names into named-source candidates", () => {
    const document = doc({ case_names: ["Alan MacMasters v. BBC"] });
    const proposals = extractDocumentNativeProposals(document);
    expect(proposals).toContainEqual(expect.objectContaining({ title: "Alan MacMasters v. BBC" }));
  });

  it("does not duplicate a URL found as both an outbound link and inline text", () => {
    const url = "https://bbc.co.uk/news/technology-33604488";
    const document = doc({ outbound_links: [url], text: `As reported at ${url} last year.` });
    const proposals = extractDocumentNativeProposals(document);
    expect(proposals.filter((proposal) => proposal.url === url)).toHaveLength(1);
  });
});

describe("extractDocumentNativeProposals: discovery signal is audit-only", () => {
  it("tags every candidate with the document-native channel and a discovery signal, and nothing that looks like provenance", () => {
    const document = doc({ outbound_links: ["https://bbc.co.uk/news/technology-33604488"], text: "See doi:10.1000/xyz123." });
    const proposals = extractDocumentNativeProposals(document);

    for (const proposal of proposals) {
      expect(proposal.discovered_by).toEqual([DOCUMENT_NATIVE_CHANNEL]);
      expect(proposal.relationship_kind).toBeUndefined();
      const signal = readAuditMetadata(proposal.metadata!).discovery_signal;
      expect(["outbound_link", "inline_citation", "named_source", "doi", "arxiv"]).toContain(signal);
    }
    // A candidate is a pointer for traversal to fetch and validate, not a claim about the
    // relationship it will turn out to have.
    expect(proposals.some((proposal) => "provenance_status" in proposal)).toBe(false);
  });
});

describe("DocumentNativeProposer: limits", () => {
  it("caps candidates per document even when many are found", async () => {
    const links = Array.from({ length: 10 }, (_, index) => `https://news.test/article-${index}`);
    const proposer = new DocumentNativeProposer({ maxProposals: 3 });

    const proposals = await proposer.analyze(doc({ outbound_links: links }));

    expect(proposals).toHaveLength(3);
  });

  it("defaults to a sane cap when none is given", async () => {
    const links = Array.from({ length: 100 }, (_, index) => `https://news.test/article-${index}`);
    const proposals = await new DocumentNativeProposer().analyze(doc({ outbound_links: links }));

    expect(proposals.length).toBeLessThan(100);
  });
});

// --- Integration with real recursive traversal -----------------------------------------------

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
  return extractDocument({ url: page.url, html: html(page), fabricated: FABRICATED, claimTerms: [], discoveredVia: "test seed" });
}

function fetcher(pages: Page[], calls: string[] = []): PageFetcher {
  const byUrl = new Map(pages.map((page) => [canonicalUrl(page.url), page]));
  return {
    async fetch(url) {
      calls.push(canonicalUrl(url));
      const page = byUrl.get(canonicalUrl(url));
      return page ? { url: page.url, kind: "html", html: html(page) } : null;
    },
  };
}

function noProposals(calls: string[] = []): UpstreamSourceProposer {
  return {
    async analyze(document) {
      calls.push(document.url);
      return [];
    },
  };
}

const urlOf = (result: Awaited<ReturnType<typeof traverseProvenance>>, id: string) => result.documents.find((document) => document.id === id)!.url;
const accepted = (result: Awaited<ReturnType<typeof traverseProvenance>>) =>
  result.accepted_edges.map((edge) => `${urlOf(result, edge.parent_id)}>${urlOf(result, edge.child_id)}`).sort();

describe("document-native discovery inside real recursive traversal", () => {
  const a = { url: "https://sources.test/a", date: "2023-01-03", marker: "A", links: ["https://sources.test/b"] };
  const b = { url: "https://sources.test/b", date: "2023-01-02", marker: "B", links: ["https://sources.test/c"] };
  const c = { url: "https://sources.test/c", date: "2023-01-01", marker: "C" };
  const unrelated: Page = {
    url: "https://sources.test/unrelated",
    date: "2023-01-01",
    marker: "Unrelated",
    body: "Spring flowers bloom beside vegetable gardens where gardeners compost leaves, water tomatoes, and prune roses.",
  };

  it("lets outbound-link candidates enter the same validated, recursive path other channels do", async () => {
    const analyzed: string[] = [];
    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c]),
        proposer: new MultiSourceProposer(noProposals(analyzed), null, null, { native: createDocumentNativeProposer() }),
      },
    );

    expect(accepted(result)).toEqual([`${b.url}>${a.url}`, `${c.url}>${b.url}`]);
    // b was expanded because validation accepted it, and its own document-native pass then found c.
    expect(analyzed).toEqual([a.url, b.url, c.url]);
    expect(result.documents.find((document) => document.url === b.url)!.discovered_via).toContain(DOCUMENT_NATIVE_CHANNEL);
  });

  it("does not let a document-native discovery become an edge just because it was proposed", async () => {
    // The unrelated URL is only mentioned in body text, not an actual <a href> on the page: it is
    // an "inline_citation" discovery, not a real hyperlink, so the validator's own `explicit_link`
    // signal (a genuine backlink between the two documents) cannot fire for it either.
    const mentionsUnrelated = { ...a, links: [], body: `${FABRICATED.join(". ")}. A. See ${unrelated.url} for background.` };

    const result = await traverseProvenance(
      { seed: seed(mentionsUnrelated), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([mentionsUnrelated, unrelated]),
        proposer: new MultiSourceProposer(noProposals(), null, null, { native: createDocumentNativeProposer() }),
      },
    );

    // The seed's own fabricated-citation case names are also proposed as named-source candidates;
    // without a resolver configured they simply fail to resolve to a URL, which is unrelated to
    // what this test checks.
    expect(result.accepted_edges).toEqual([]);
    expect(result.rejected_edges).toContainEqual(expect.objectContaining({ termination: "validation-rejected", parent_url: unrelated.url }));
  });

  it("fetches and expands a document reached by two parents exactly once, keeping both edges", async () => {
    // b -> d and c -> d: a fans out to both b and c (which share the seed's fabricated citations),
    // and each independently links to the same downstream document d.
    const d = { url: "https://sources.test/d", date: "2022-12-31", marker: "D" };
    const bToD = { ...b, links: [d.url] };
    const cToD = { ...c, links: [d.url] };
    const fanoutA = { ...a, links: [bToD.url, cToD.url] };
    const fetchCalls: string[] = [];
    const analyzed: string[] = [];

    const result = await traverseProvenance(
      { seed: seed(fanoutA), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([fanoutA, bToD, cToD, d], fetchCalls),
        proposer: new MultiSourceProposer(noProposals(analyzed), null, null, { native: createDocumentNativeProposer() }),
      },
    );

    expect(fetchCalls.filter((url) => url === canonicalUrl(d.url))).toHaveLength(1);
    expect(analyzed.filter((url) => url === d.url)).toHaveLength(1);
    expect(result.documents.filter((document) => document.url === d.url)).toHaveLength(1);
    expect(accepted(result)).toEqual(expect.arrayContaining([`${d.url}>${bToD.url}`, `${d.url}>${cToD.url}`]));
  });

  it("merges a GPTZero proposal and a document-native discovery of the same URL without duplicating it", async () => {
    const fetchCalls: string[] = [];
    const gptzero: UpstreamSourceProposer = {
      async analyze(document): Promise<readonly UpstreamProposal[]> {
        return document.url === a.url ? [{ url: b.url }] : [];
      },
    };

    const result = await traverseProvenance(
      { seed: seed(a), claim: CLAIM, fabricated: FABRICATED },
      {
        fetcher: fetcher([a, b, c], fetchCalls),
        proposer: new MultiSourceProposer(gptzero, null, null, { native: createDocumentNativeProposer() }),
      },
    );

    expect(fetchCalls.filter((url) => url === canonicalUrl(b.url))).toHaveLength(1);
    expect(result.documents.filter((document) => document.url === b.url)).toHaveLength(1);
    expect(result.documents.find((document) => document.url === b.url)!.discovered_via).toEqual(
      expect.arrayContaining(["gptzero", DOCUMENT_NATIVE_CHANNEL]),
    );
  });

  it("still respects maxChildrenPerNode when document-native discovery proposes more candidates than the cap", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      url: `https://sources.test/child-${index}`,
      date: "2023-01-01",
      marker: `Child ${index}`,
    }));
    const withManyLinks = { ...a, links: many.map((page) => page.url) };

    const result = await traverseProvenance(
      { seed: seed(withManyLinks), claim: CLAIM, fabricated: FABRICATED, maxChildrenPerNode: 3 },
      {
        fetcher: fetcher([withManyLinks, ...many]),
        proposer: new MultiSourceProposer(noProposals(), null, null, { native: createDocumentNativeProposer() }),
      },
    );

    expect(result.accepted_edges.length).toBeLessThanOrEqual(3);
  });
});
