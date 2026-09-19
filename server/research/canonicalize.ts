import { documentId, type CandidateDocument } from "./extract";

export interface CanonicalizeResult {
  /** One document per exact extracted-text fingerprint. */
  documents: CandidateDocument[];
  /** Resolves every fetched source URL to its artifact's graph-node ID. */
  idByUrl: Map<string, string>;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Collapse exact-content mirrors after extraction and before retrieval/scoring. The canonical
 * URL is selected lexicographically so the aggregate is deterministic regardless of discovery
 * order. All source URLs survive as `url` plus `mirror_urls`; outbound links are unioned so an
 * exact link observed on a mirror is still available to the provenance graph.
 */
export function canonicalizeDocuments(documents: CandidateDocument[]): CanonicalizeResult {
  const groups = new Map<string, CandidateDocument[]>();
  for (const document of documents) {
    const group = groups.get(document.content_fingerprint);
    if (group) group.push(document);
    else groups.set(document.content_fingerprint, [document]);
  }

  const ordered = [...groups.values()]
    .map((group) => [...group].sort((a, b) => a.url.localeCompare(b.url)))
    .sort((a, b) => a[0]!.url.localeCompare(b[0]!.url));
  const baseIdCounts = new Map<string, number>();
  for (const group of ordered) {
    const baseId = documentId(group[0]!.url);
    baseIdCounts.set(baseId, (baseIdCounts.get(baseId) ?? 0) + 1);
  }

  const idByUrl = new Map<string, string>();
  const canonical = ordered.map((group) => {
    const representative = group[0]!;
    const baseId = documentId(representative.url);
    // URL-derived IDs predate artifact grouping. Keep them for non-colliding documents so the
    // public graph remains stable, but make a genuine URL-slug collision unambiguous.
    const id = baseIdCounts.get(baseId) === 1 ? baseId : `${baseId}-${representative.content_fingerprint}`;
    const aggregate: CandidateDocument = {
      ...representative,
      id,
      mirror_urls: group.slice(1).map((document) => document.url),
      outbound_links: unique(group.flatMap((document) => document.outbound_links)).sort((a, b) => a.localeCompare(b)),
      case_names: unique(group.flatMap((document) => document.case_names)),
      fabricated_citations: unique(group.flatMap((document) => document.fabricated_citations)),
      citation_variants: unique(group.flatMap((document) => document.citation_variants)),
      discovered_via: unique(group.flatMap((document) => document.discovered_via)),
    };
    // `group` holds raw source documents at this boundary, so every URL maps to this one node.
    for (const member of group) idByUrl.set(member.url, id);
    return aggregate;
  });

  return { documents: canonical, idByUrl };
}
