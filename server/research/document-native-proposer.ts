import { canonicalUrl, type CandidateDocument } from "./extract";
import { toAuditMetadata } from "./providers";
import type { UpstreamProposal, UpstreamSourceProposer } from "./traversal";

/**
 * A candidate-generation channel that reads a fetched document itself, rather than asking an
 * external provider about it. Live provider-only recursion (GPTZero rescanning a fetched page)
 * regularly finds nothing new to expand; the page usually already names or links its own upstream
 * sources. This channel surfaces those deterministically, exactly like `WebSearchProposer` or the
 * Semantic Scholar proposer: it hands `traverseProvenance` ordinary `UpstreamProposal`s, which are
 * fetched, canonicalized and scored through the same validator as every other channel. Nothing here
 * decides that a provenance edge exists.
 */

export const DOCUMENT_NATIVE_CHANNEL = "document-native";

/** Why a candidate was surfaced. Audit-only, carried in `metadata`; never read by scoring code. */
export type DocumentNativeSignal = "outbound_link" | "inline_citation" | "named_source" | "doi" | "arxiv";

const NOISE_PATH =
  /\/(log-?in|sign-?in|sign-?up|register|my-?account|account|subscribe|newsletter|privacy(?:-policy)?|terms(?:-of-(?:service|use))?|\bt(?:o|and)c\b|cookies?(?:-policy)?|about(?:-us)?|contact(?:-us)?|advertis(?:e|ing)|careers?|jobs?|search|tags?|categor(?:y|ies)|authors?)(?:\/|$|\?)/i;

const NOISE_HOST =
  /(^|\.)(facebook|twitter|x|instagram|linkedin|pinterest|reddit|whatsapp|t\.me|tiktok|snapchat)\.com$|(^|\.)t\.me$/i;

const ASSET_EXTENSION = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|mjs|woff2?|ttf|eot|mp4|mp3|avi|mov|webm|zip)(\?|#|$)/i;

function isHomePage(path: string): boolean {
  return path === "" || path === "/";
}

/** Classifies one already-resolved absolute http(s) URL, or returns null when it is noise. */
function classifyLink(url: string): DocumentNativeSignal | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (NOISE_HOST.test(host)) return null;
  if (isHomePage(path)) return null;
  if (NOISE_PATH.test(path)) return null;
  if (ASSET_EXTENSION.test(path)) return null;
  if (host === "doi.org" || host.endsWith(".doi.org")) return "doi";
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) return "arxiv";
  return "outbound_link";
}

const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>()[\]]+/g;
const ARXIV_PATTERN = /\barxiv[:\s]+(\d{4}\.\d{4,5})(?:v\d+)?\b/gi;
const RAW_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()[\]]+/g;
const DOCKET_PATTERN = /\b(?:No\.|Case No\.|Docket No\.)\s*[:.]?\s*(\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}|\d{2,4}-\d{3,6})\b/gi;

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:)\]]+$/, "");
}

function proposal(fields: UpstreamProposal, signal: DocumentNativeSignal): UpstreamProposal {
  return { ...fields, discovered_by: [DOCUMENT_NATIVE_CHANNEL], metadata: toAuditMetadata({ discovery_signal: signal }) };
}

/**
 * Deterministic extraction only, no LLM: outbound links already scoped to article/body content by
 * `parseHtmlPage`, filtered for navigation/social/legal noise; plus DOI, arXiv, docket numbers, raw
 * URLs and case names found in the document's own text. Every signal is discovery-only — none of it
 * implies validated provenance; the existing validator still decides relationship semantics.
 */
export function extractDocumentNativeProposals(document: CandidateDocument): UpstreamProposal[] {
  const proposals: UpstreamProposal[] = [];
  const seen = new Set<string>();

  const addByUrl = (url: string, signal: DocumentNativeSignal): void => {
    const key = `url:${canonicalUrl(url)}`;
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push(proposal({ url }, signal));
  };
  const addByReference = (key: string, fields: UpstreamProposal, signal: DocumentNativeSignal): void => {
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push(proposal(fields, signal));
  };

  for (const link of document.outbound_links) {
    const signal = classifyLink(link);
    if (signal) addByUrl(link, signal);
  }

  const text = document.text ?? "";

  for (const match of text.matchAll(DOI_PATTERN)) {
    const doi = stripTrailingPunctuation(match[0]);
    addByReference(`doi:${doi.toLowerCase()}`, { url: `https://doi.org/${doi}`, citation: doi }, "doi");
  }

  for (const match of text.matchAll(ARXIV_PATTERN)) {
    const id = match[1]!;
    addByReference(`arxiv:${id}`, { url: `https://arxiv.org/abs/${id}`, citation: `arXiv:${id}` }, "arxiv");
  }

  for (const match of text.matchAll(RAW_URL_PATTERN)) {
    const raw = stripTrailingPunctuation(match[0]);
    const signal = classifyLink(raw);
    if (signal) addByUrl(raw, signal === "outbound_link" ? "inline_citation" : signal);
  }

  for (const match of text.matchAll(DOCKET_PATTERN)) {
    const docket = match[0].trim();
    addByReference(`docket:${docket.toLowerCase()}`, { citation: docket }, "named_source");
  }

  for (const name of document.case_names) {
    addByReference(`case:${name.toLowerCase()}`, { title: name }, "named_source");
  }

  return proposals;
}

export interface DocumentNativeProposerOptions {
  /** Hard cap on candidates proposed per document, before traversal's own caps ever see them. Default 40. */
  maxProposals?: number;
}

const DEFAULT_MAX_PROPOSALS = 40;

export class DocumentNativeProposer implements UpstreamSourceProposer {
  readonly kind = "document-native" as const;
  private readonly maxProposals: number;

  constructor(options: DocumentNativeProposerOptions = {}) {
    this.maxProposals = options.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  }

  async analyze(document: CandidateDocument): Promise<readonly UpstreamProposal[]> {
    return extractDocumentNativeProposals(document).slice(0, this.maxProposals);
  }
}

export function createDocumentNativeProposer(options?: DocumentNativeProposerOptions): UpstreamSourceProposer {
  return new DocumentNativeProposer(options);
}
