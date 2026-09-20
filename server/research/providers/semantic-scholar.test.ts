import { describe, expect, it, vi } from "vitest";
import { identifyAcademicPaper } from "../academic";
import { extractDocument } from "../extract";
import { MultiSourceProposer } from "../multi-proposer";
import type { CitationProviderMetadata, UpstreamAnalysis, UpstreamProposal, UpstreamSourceProposer } from "../traversal";
import { traverseProvenance } from "../traversal";
import { SemanticScholarProposer, SemanticScholarProvider } from "./semantic-scholar";

const paperIdA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const paperIdB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const paperIdC = "cccccccccccccccccccccccccccccccccccccccc";
const paperIdD = "dddddddddddddddddddddddddddddddddddddddd";

function paper(paperId: string, title: string, doi: string, year = 2020) {
  return {
    paperId, title, year, venue: "Example Conference", publicationDate: `${year}-05-01`,
    authors: [{ name: "Ada Lovelace" }], externalIds: { DOI: doi },
    url: `https://www.semanticscholar.org/paper/${paperId}`,
  };
}

function academicDocument() {
  return extractDocument({
    url: "https://example.edu/papers/alpha",
    html: '<html><head><title>Alpha paper</title><meta name="citation_doi" content="10.1000/alpha"><meta name="citation_author" content="Ada Lovelace"></head><body><article><p>Paper body.</p></article></body></html>',
    fabricated: [], claimTerms: [], discoveredVia: "test-seed",
  });
}

function genericDocument() {
  return extractDocument({
    url: "https://dockets.court-archive.test/cohen/18-cr-602/doc-102-cohen-declaration",
    html: "<html><head><title>Declaration of Michael Cohen</title></head><body><article><p>The declaration discusses court filings and cases, not a research paper.</p></article></body></html>",
    fabricated: [], claimTerms: [], discoveredVia: "test-seed",
  });
}

function responseFor(url: string): Response {
  if (url.includes("/paper/DOI%3A10.1000%2Falpha")) return Response.json(paper(paperIdA, "Alpha paper", "10.1000/alpha"));
  if (url.includes(`/paper/${paperIdA}/references`)) {
    return Response.json({ data: [{ citedPaper: paper(paperIdB, "Beta paper", "10.1000/beta", 2019), contexts: ["We build on Beta."], intents: ["Background"], isInfluential: true }] });
  }
  if (url.includes(`/paper/${paperIdA}/citations`)) {
    return Response.json({ data: [{ citingPaper: paper(paperIdC, "Gamma paper", "10.1000/gamma", 2021), contexts: ["Gamma cites Alpha."], intents: ["Methodology"], isInfluential: false }] });
  }
  return new Response("not found", { status: 404 });
}

function proposalsOf(analysis: UpstreamAnalysis): readonly UpstreamProposal[] {
  return Array.isArray(analysis) ? analysis : "proposals" in analysis ? analysis.proposals : [];
}

describe("Semantic Scholar Academic Graph provider", () => {
  it("resolves DOI papers and returns bounded reference and cited-by structural proposals", async () => {
    const calls: string[] = [];
    const provider = new SemanticScholarProvider({ fetchImpl: async (url) => { calls.push(String(url)); return responseFor(String(url)); } });
    const proposer = new SemanticScholarProposer(provider, { maxReferences: 1, maxCitations: 1 });
    const proposals = proposalsOf(await proposer.analyze(academicDocument()));

    expect(calls).toHaveLength(3);
    expect(proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationship_kind: "citation", citation_direction: "references", url: "https://doi.org/10.1000/beta" }),
      expect.objectContaining({ relationship_kind: "citation", citation_direction: "cited_by", url: "https://doi.org/10.1000/gamma" }),
    ]));
    const reference = proposals.find((x) => x.citation_direction === "references")!;
    expect(reference.citation_metadata).toMatchObject({ resolved_paper_id: paperIdA, contexts: ["We build on Beta."], intents: ["Background"], is_influential: true });
  });

  it("does not call Semantic Scholar for generic webpages", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const proposer = new SemanticScholarProposer(new SemanticScholarProvider({ fetchImpl }));
    await expect(proposer.analyze(genericDocument())).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recognizes DOI, arXiv, and Semantic Scholar paper identifiers deterministically", () => {
    const arxiv = extractDocument({
      url: "https://arxiv.org/abs/2106.15928v1", html: "<html><head><title>ArXiv paper</title></head><body><article><p>Paper.</p></article></body></html>",
      fabricated: [], claimTerms: [], discoveredVia: "test-seed",
    });
    const semanticScholar = extractDocument({
      url: `https://www.semanticscholar.org/paper/Paper-title/${paperIdA}`, html: "<html><head><title>Indexed paper</title></head><body><article><p>Paper.</p></article></body></html>",
      fabricated: [], claimTerms: [], discoveredVia: "test-seed",
    });
    expect(identifyAcademicPaper(academicDocument())).toEqual({ method: "doi", value: "10.1000/alpha" });
    expect(identifyAcademicPaper(arxiv)).toEqual({ method: "arxiv", value: "2106.15928" });
    expect(identifyAcademicPaper(semanticScholar)).toEqual({ method: "semantic_scholar_paper_id", value: paperIdA });
    expect(identifyAcademicPaper(genericDocument())).toBeNull();
  });

  it("sends x-api-key only when configured", async () => {
    const headers: Array<HeadersInit | undefined> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      headers.push(init?.headers);
      return Response.json(paper(paperIdA, "Alpha paper", "10.1000/alpha"));
    };
    const keyed = new SemanticScholarProvider({ apiKey: "semantic-key", fetchImpl });
    const publicApi = new SemanticScholarProvider({ fetchImpl });
    await keyed.lookup({ method: "doi", value: "10.1000/alpha" });
    await publicApi.lookup({ method: "doi", value: "10.1000/alpha" });

    expect(headers[0]).toEqual(expect.objectContaining({ "x-api-key": "semantic-key" }));
    expect(headers[1]).not.toHaveProperty("x-api-key");
  });

  it("keeps GPTZero candidates when Semantic Scholar is unavailable", async () => {
    const gptzero: UpstreamSourceProposer = { analyze: async () => [{ url: "https://source.test/gptzero" }] };
    const failingSemantic: UpstreamSourceProposer = { analyze: async () => { throw new Error("Semantic Scholar timed out"); } };
    const merged = new MultiSourceProposer(gptzero, null, failingSemantic);
    const proposals = proposalsOf(await merged.analyze(genericDocument()));
    expect(proposals).toEqual([expect.objectContaining({ url: "https://source.test/gptzero" })]);
  });
});

function citation(direction: "references" | "cited_by", paperId: string, title: string, doi: string): UpstreamProposal {
  const metadata: CitationProviderMetadata = {
    provider: "semantic-scholar", resolved_paper_id: paperIdA, resolved_by: "doi",
    paper: { semantic_scholar_paper_id: paperId, title, doi, canonical_url: `https://doi.org/${doi}`, authors: ["Ada Lovelace"], year: 2020 },
    contexts: ["Provider context that must never score provenance."], intents: ["Background"], is_influential: true,
  };
  return { url: metadata.paper.canonical_url, title, relationship_kind: "citation", citation_direction: direction, citation_metadata: metadata, discovered_by: ["semantic-scholar"] };
}

describe("citation traversal semantics", () => {
  it("preserves reference and cited-by directions, reuses a crosslinked paper, and expands it once", async () => {
    const seed = academicDocument();
    const calls: string[] = [];
    const proposer: UpstreamSourceProposer = {
      async analyze(document) {
        calls.push(document.title);
        if (document.title === "Alpha paper") return [citation("references", paperIdD, "Delta paper", "10.1000/delta"), citation("cited_by", paperIdB, "Beta paper", "10.1000/beta")];
        if (document.title === "Beta paper") return [citation("references", paperIdD, "Delta paper", "10.1000/delta")];
        return [];
      },
    };
    const result = await traverseProvenance(
      { seed, claim: "academic claim", fabricated: [], maxDepth: 3, maxProviderRequests: 10 },
      { proposer, fetcher: { fetch: async () => { throw new Error("citation nodes must not be fetched"); } } },
    );
    const byId = new Map(result.documents.map((document) => [document.title, document.id]));
    const alpha = byId.get("Alpha paper")!;
    const beta = byId.get("Beta paper")!;
    const delta = byId.get("Delta paper")!;

    expect(result.accepted_edges).toEqual([]);
    expect(result.citation_edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: alpha, target_id: delta, direction: "references", relationship_kind: "citation" }),
      expect.objectContaining({ source_id: beta, target_id: alpha, direction: "cited_by", relationship_kind: "citation" }),
      expect.objectContaining({ source_id: beta, target_id: delta, direction: "references", relationship_kind: "citation" }),
    ]));
    expect(result.documents.filter((document) => document.title === "Delta paper")).toHaveLength(1);
    expect(calls.filter((title) => title === "Delta paper")).toHaveLength(1);
    expect(result.documents.find((document) => document.title === "Delta paper")?.academic_metadata?.metadata_only).toBe(true);
  });

  it("does not let citation context, intent, or influence become provenance acceptance", async () => {
    const seed = academicDocument();
    const run = async (metadata: Pick<CitationProviderMetadata, "contexts" | "intents" | "is_influential">) => {
      const proposal = citation("references", paperIdD, "Delta paper", "10.1000/delta");
      proposal.citation_metadata = { ...proposal.citation_metadata!, ...metadata };
      return traverseProvenance({ seed, claim: "academic claim", fabricated: [], maxDepth: 1 }, {
        proposer: { analyze: async () => [proposal] }, fetcher: { fetch: async () => null },
      });
    };
    const low = await run({ contexts: [], intents: [], is_influential: false });
    const high = await run({ contexts: ["very strong provider claim"], intents: ["Result"], is_influential: true });
    expect(low.accepted_edges).toEqual([]);
    expect(high.accepted_edges).toEqual([]);
    expect(low.citation_edges.map((edge) => ({ source_id: edge.source_id, target_id: edge.target_id, direction: edge.direction }))).toEqual(
      high.citation_edges.map((edge) => ({ source_id: edge.source_id, target_id: edge.target_id, direction: edge.direction })),
    );
  });
});
