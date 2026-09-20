import type { CandidateDocument } from "./extract";

/**
 * Bibliographic facts collected deterministically from a paper page or returned by Semantic
 * Scholar. This is deliberately separate from extracted document text: it identifies a paper and
 * describes a citation edge, but is never an input to provenance scoring.
 */
export interface AcademicPaperMetadata {
  semantic_scholar_paper_id?: string | null;
  doi?: string | null;
  arxiv_id?: string | null;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  publication_date?: string | null;
  venue?: string | null;
  /** Best source URL supplied by the bibliographic record, ordered DOI, publisher/arXiv/OA, S2. */
  canonical_url?: string | null;
  /** The node represents citation metadata only; its full text was not acquired. */
  metadata_only?: boolean;
}

export type AcademicIdentity =
  | { method: "doi"; value: string }
  | { method: "semantic_scholar_paper_id"; value: string }
  | { method: "arxiv"; value: string }
  | { method: "scholarly_url"; value: string }
  | { method: "title_author"; title: string; authors: string[]; year: number | null };

const DOI = /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*[:=]?\s*)(10\.\d{4,9}\/[\w.()/:;-]+)/iu;
const ARXIV = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|\s*[:=]?))(\d{4}\.\d{4,5}(?:v\d+)?)/iu;
const S2_PAPER_URL = /semanticscholar\.org\/paper\/[^/]+\/([a-f0-9]{40})/iu;

/** Sources whose URLs are paper-level identifiers, rather than general-purpose web pages. */
export function isRecognizedScholarlyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "arxiv.org" ||
      host.endsWith(".arxiv.org") ||
      host === "semanticscholar.org" ||
      host.endsWith(".semanticscholar.org") ||
      host === "doi.org" ||
      host.endsWith(".doi.org") ||
      host === "dl.acm.org" ||
      host === "ieeexplore.ieee.org" ||
      host === "pubmed.ncbi.nlm.nih.gov" ||
      host === "pmc.ncbi.nlm.nih.gov" ||
      host === "aclanthology.org" ||
      host === "openreview.net" ||
      host === "biorxiv.org" ||
      host === "medrxiv.org"
    );
  } catch {
    return false;
  }
}

export function normalizeDoi(value: string | null | undefined): string | null {
  const candidate = (value ?? "").trim();
  const found = candidate.match(DOI)?.[1] ?? (candidate.startsWith("10.") ? candidate : null);
  return found ? found.replace(/[)>.,;]+$/u, "").toLowerCase() : null;
}

export function normalizeArxivId(value: string | null | undefined): string | null {
  const candidate = (value ?? "").trim();
  const found = candidate.match(ARXIV)?.[1] ?? (/^\d{4}\.\d{4,5}(?:v\d+)?$/u.test(candidate) ? candidate : null);
  return found ? found.replace(/v\d+$/u, "") : null;
}

export function semanticScholarPaperIdFromUrl(value: string | null | undefined): string | null {
  return (value ?? "").match(S2_PAPER_URL)?.[1]?.toLowerCase() ?? null;
}

function cleanTitle(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

/**
 * Conservative, deterministic eligibility. A plain article title is never enough: it needs a
 * stable scholarly ID, a known paper host, or citation-specific title/author metadata.
 */
export function identifyAcademicPaper(document: CandidateDocument): AcademicIdentity | null {
  const metadata = document.academic_metadata;
  const doi = normalizeDoi(metadata?.doi) ?? normalizeDoi(`${document.url}\n${document.text}\n${document.passage}`);
  if (doi) return { method: "doi", value: doi };

  const paperId = metadata?.semantic_scholar_paper_id?.trim() || semanticScholarPaperIdFromUrl(document.url);
  if (paperId) return { method: "semantic_scholar_paper_id", value: paperId };

  const arxiv = normalizeArxivId(metadata?.arxiv_id) ?? normalizeArxivId(document.url);
  if (arxiv) return { method: "arxiv", value: arxiv };

  // A recognized publisher/archive URL is a deterministic paper signal. The provider resolves it
  // with Semantic Scholar's URL identifier; it is not a free-text search.
  if (isRecognizedScholarlyUrl(document.url)) return { method: "scholarly_url", value: document.url };

  const title = metadata?.title?.trim() ?? "";
  const authors = metadata?.authors?.filter(Boolean) ?? [];
  if (cleanTitle(title).length >= 12 && authors.length > 0) {
    return { method: "title_author", title, authors, year: metadata?.year ?? null };
  }
  return null;
}

export function academicTitleKey(value: string): string {
  return cleanTitle(value);
}
