# Ariadne frontend API handoff

## Inspection before changes

`server/api/app.ts` currently accepts `POST /api/research` with `{ claim, seed_url?, seed_source?: { url?, title?, citation?, author? }, fabricated_citations?, include_ai_evidence? }`. It calls the injected `research` function, wired in `server/index.ts` to `runResearch` in `server/research/pipeline.ts`. That function uses discovery, retrieval and `buildTree`, not `traverseProvenance`. The HTTP response is `{ id, status, tree: LineageTree }`; `GET /api/research/:id` retrieves an in-memory result. Research exceptions become HTTP 422.

`ariadne/lib/api.ts` calls both routes. `ariadne/app/tree/page.tsx` calls `createResearch(query)` with claim text only and passes `result.tree` to `ariadne/lib/graph.ts`. That adapter expects `TreeNode` fields (including canonical identity, timestamp evidence, passage, seed flag), `parent_id`/`child_id` edges, `root_ids`, rejected edges and excluded candidates. It treats every `tree.edges` entry as accepted. The existing frontend mirror omits backend reliability fields. The visual components do not use discovery/retrieval statistics.

The recursive demo directly calls `traverseProvenance`, whose acceptance gate is `scoreEdge`, not `validateProvenanceEdge`. Its documents need adaptation to `TreeNode`; accepted and rejected edges are separate, unresolved rejected sources have no document ID, and `paused` is an additional internal status. It already supplies mutations and traversal evidence. The separate validator can provide richer inspection signals, but its independently computed score must not replace the traversal score or change acceptance.

## Decision

Replace the implementation behind `/api/research` with the recursive pipeline. Keep one public research endpoint and the existing GET retrieval route. Keep `runResearch`, discovery and `buildTree` as internal/CLI functionality; they are not a fallback for provenance acceptance. Retain a backend-generated `tree` compatibility projection for the current visual components. New frontend work should consume the normalized top-level contract. Only validated edges enter `tree.edges`.

## Endpoint and request

`POST /api/research`, JSON body. Default backend base URL: `http://localhost:4000`.

```ts
type AriadneRequest = {
  claim: string;
  seed_url?: string;
  seed_text?: string;
  seed_source?: {
    url?: string | null;
    title?: string | null;
    citation?: string | null;
    author?: string | null;
  } | null;
  fabricated_citations?: string[];
  max_depth?: number;
  max_provider_requests?: number;
  include_ai_evidence?: boolean;
};
```

The runtime schema and exported TypeScript types are in [`shared/ariadne.ts`](../shared/ariadne.ts). Requests reject unknown fields. `claim` is trimmed, required and limited to 2,000 characters. Choose at most one of `seed_url`, `seed_source`, or `seed_text`. URLs must be HTTP(S) without embedded credentials. `seed_source` must contain at least one nonempty identifying field. `seed_text` is limited to 100,000 characters; fabricated citations to 20 strings of at most 2,000 characters. Citation fabrication labels come from the caller, not GPTZero, and should represent known case context.

`seed_url` acquires the actual HTML/PDF before analysis. A bibliographic `seed_source` uses the injected resolver if available. Live default dependencies provide direct HTTP acquisition and no bibliographic resolver, so a title-only reference produces a structured failure unless a resolver is configured. Mock mode provides the offline corpus resolver.

Without a source field, `claim` itself becomes submitted source text. It has no publication date and no inferred outbound links. A fetched provider proposal is exposed as a `candidate` edge from the submitted query anchor to the fetched candidate and becomes a traversal root. This discovery relationship has `directionality: "unknown"`; it is not provenance and does not manufacture chronology. Submitted nodes have `source_kind: "submitted"`; their `url` is an internal `https://submitted.ariadne.invalid/...` identity needed by the existing document contract, not a fetched/publication URL. Do not offer it as an external source link. `root.url` is `null` for this case. Prefer a real `seed_url` when publication chronology is part of the demonstration.

`max_depth` defaults to the server's `MAX_GRAPH_DEPTH` setting (5 unless configured), accepts 0–10, and bounds recursive hops. Claim-only candidate roots are bootstrap discovery and do not consume a hop. `max_provider_requests` defaults to 10 and accepts 1–10 per invocation. Server safety limits default to 25 expanded documents, 60 investigation edges, 6 accepted children per document, 4 related children, and 3 probable children. A limit bounds the run; `complete` does not claim the graph contains every possible ancestor. `include_ai_evidence` remains accepted for request compatibility but is deprecated: `true` produces an explicit warning and no AI-writing check. This endpoint runs bibliography proposals.

Execution is selected by server configuration, never by a request field. `TRAVERSAL_MODE` accepts `strict`, `exploratory`, or `deep` (`PROVENANCE_MODE` is a compatible alias). Strict recurses only validated links; exploratory also recurses probable links; deep also recurses related links. `USE_MOCKS=true` uses the offline corpus. Live mode uses the GPTZero bibliography proposer and, when `BRAVE_SEARCH_API_KEY` is configured, an independent web-search proposer. Search only supplies candidates: traversal fetches and scores every proposed URL without using a provider rank or score as evidence.

For nodes with deterministic academic-paper signals, live mode also enables Semantic Scholar's official Academic Graph API. `SEMANTIC_SCHOLAR_API_KEY` is optional and stays server-side; without it the provider uses unauthenticated limits. Resolution is DOI, Semantic Scholar paper ID, arXiv ID, recognized scholarly URL, then exact normalized title plus an author surname. `SEMANTIC_SCHOLAR_MAX_REFERENCES` and `SEMANTIC_SCHOLAR_MAX_CITATIONS` bound each direction (10 each by default), and `SEMANTIC_SCHOLAR_TIMEOUT_MS` bounds a call (10 seconds by default).

Citation edges have `status: "citation"` and `relationship_kind: "citation"`, so they never become `validated`, `probable`, or `related` provenance. `direction: "references"` means `source` cites `target`; `direction: "cited_by"` means `source` cites `target` and was found while expanding `target`. `provider_metadata` contains the citation context, intent and influence flag for display/audit only. None of it enters `scoreEdge`, independent provenance validation, confidence, or mutation analysis. Citation nodes with no acquired body are marked `source_kind: "citation-metadata"` and `academic_metadata.metadata_only: true`.

## Response contract

Every completed research invocation, including domain failure, returns HTTP 200 with `AriadneResponse`. Inspect `status`; HTTP success alone does not mean a valid chain was found. Invalid requests return HTTP 400; malformed JSON/oversized bodies retain the existing 400/413 error envelope. Unexpected server faults return a generic HTTP 500 error without a stack. These HTTP errors use `{ status: "failed", stage: string | null, error: string }`, not a graph result.

The following shape reuses the existing evidence schemas; the linked source is the exact contract:

```ts
import type { AriadneDiagnostic, AriadneNode } from "../shared/ariadne";
import type { ValidationEvidence, ValidationSignal } from "../shared/provenance-validation";
import type { ClaimMutation, TreeEdge } from "../shared/tree";

type EdgeEndpoints = {
  id: string;
  source: string | null;
  target: string;
  reference_url: string | null;
};

type AriadneEdge = EdgeEndpoints & (
  | {
      status: "validated";
      source: string;
      ariadne_score: number;
      score_method: "traversal-scoreEdge";
      type: "propagation" | "similarity";
      evidence: Pick<TreeEdge,
        "basis" | "explicit_link" | "shared_mutations" |
        "rare_shared_phrases" | "similarity" | "temporal">;
      inspection: {
        validator: "lineage-deterministic-v1";
        role: "supplementary-inspection";
        signals: ValidationSignal[];
        evidence: ValidationEvidence;
      } | null;
      claim_mutations: ClaimMutation[];
      recursed: boolean;
    }
  | {
      status: "rejected";
      ariadne_score: number | null;
      score_method: "traversal-scoreEdge";
      reason: string;
      termination: "invalid-proposal" | "fetch-failure" | "duplicate-source" |
        "cycle" | "already-visited" | "already-accepted" | "validation-rejected";
    }
  | { status: "candidate"; reason: string }
);

type AriadneResponse = {
  id: string;
  status: "complete" | "partial" | "failed";
  root: {
    id: string;
    url: string | null;
    title: string | null;
    date: string | null;
    text: string | null;
  };
  nodes: AriadneNode[];
  edges: AriadneEdge[];
  terminations: Array<{
    source_id: string;
    url: string;
    depth: number;
    reason: "no-proposals" | "max-depth" | "provider-failure" |
      "all-proposals-rejected" | "accepted-parents";
    detail: string | null;
  }>;
  warnings: AriadneDiagnostic[];
  errors: AriadneDiagnostic[];
  execution: {
    proposer: "live" | "cached_demo_fallback" | "mock";
    fallbacks: Array<{ source_id: string; captured_at: string }>;
  };
  pending: Array<{
    source_id: string;
    reason: "provider-pending" | "rate-limit";
    retry_after_ms: number | null;
  }>;
  resume_url: string | null;
  tree: import("../shared/ariadne").AriadneResponse["tree"];
};
```

`AriadneNode` reuses `TreeNode` (canonical identity, URL/mirrors, publisher/title, timestamps and their provenance, passage, citations, seed flag) and adds `source_kind`. Authors are not extracted by the current document model, so they are not invented. `root` is the submitted seed, not necessarily the earliest upstream document. A failed seed acquisition has an unavailable root ID and empty `nodes`; it is not represented as an acquired document. `nodes` includes acquired rejected candidates for inspection. Validated and probable links use upstream `source` → downstream `target` whenever their `directionality` permits it. Candidate and related links use discovery order and always have `directionality: "unknown"`.

| Edge state | Meaning |
| --- | --- |
| `validated` | Passes strict provenance validation. It is part of the provenance graph and can recurse in every mode. |
| `probable` | Has meaningful provenance evidence below the strict threshold. It is part of the provenance graph and recurses in exploratory and deep modes. It is never serialized as `validated`. |
| `related` | A genuinely connected fetched document worth investigating, below the probable threshold. It is part of the investigation graph, recurses only in deep mode, has `directionality: "unknown"`, and never receives mutation analysis or provenance inspection. A related back-link can close an investigation cycle, but reused documents are never expanded twice. |
| `rejected` | The traversal did not accept this proposed relationship. A failed fetch is rejected with a null score and usually a null `source`, never promoted to provenance. |
| `candidate` | A fetched claim-only source match. It runs as an investigation root; its submitted-text-to-candidate link is discovery only and has no Ariadne score. |

The top-level `nodes` and `edges` are the authoritative investigation graph. The provenance graph is `validated + probable`; the investigation graph is `candidate + validated + probable + related`. Numeric values and `type` do not override state. In particular, a rejected proposal with a score is still rejected. A duplicate rejected proposal can coexist with a separately accepted relationship.

The exact traversal basis, temporal evidence, explicit-link flag, shared fabricated citations/variants, rare-phrase count and similarity survive under `evidence`. `inspection` calls the existing independent validator over the final acquired corpus to expose matched links/citations, shared phrases, matched passage coverage, document passages, timestamps, canonical identity and structured signal outcomes. It is labelled supplementary because that validator and `scoreEdge` are distinct existing algorithms. Its aggregation/acceptance result is not used or exposed as the traversal decision. An unavailable supplementary inspection produces a warning without deleting the edge or its traversal evidence.

Mutation output is unchanged from `analyzeClaimMutations`: `{ type: "added" | "omitted" | "reframed", summary, before, after }`. `before` refers to the upstream passage and `after` to the downstream passage. Added content has `before: null`; omitted content has `after: null`; reframed content has both. Full selected upstream/downstream passages are also available under `inspection.evidence.parent.passage` and `.child.passage`, and on the nodes. An empty array means no supported wording change was detected.

Diagnostics retain stage, safe source URL, category, readable message and recoverability. Raw provider errors, response bodies, stacks, authorization headers, opaque GPTZero audit metadata and internal checkpoints/job IDs are not serialized. Failure messages are built from public categories; diagnostic URLs omit credentials/query strings. Unknown internal categories become `stage-failed`. Fetch/provider interruptions produce `partial` plus warnings when a validated chain exists; otherwise `failed` plus errors. A paused run maps to `partial`, even before any edge is accepted. Fallback alone does not change a completed traversal to `partial`.

## Live, fallback and mock labels

| `execution.proposer` | Meaning |
| --- | --- |
| `live` | Live provider configuration and no cached substitution recorded. Check status/diagnostics: this does not certify a successful scan, and seed acquisition may have failed before any scan. |
| `cached_demo_fallback` | At least one analysis in this run used the existing cached demo fallback. The label persists across resume, even when other scans are live. Per-source capture times are in `execution.fallbacks`; they are not fresh scan times. |
| `mock` | Offline stand-in selected through server configuration. No live GPTZero scan occurred. |

There is no generic GPTZero `confidence` field. Top-level edge `ariadne_score` belongs exclusively to the deterministic traversal. The old `tree.edges[].confidence` is an explicitly retained compatibility alias of that same score, never GPTZero relevance or confidence. `timestamp_confidence` describes extracted date evidence only.

## Retrieval and resume

`GET /api/research/:id` returns the same normalized result. If `resume_url` is non-null, wait at least the largest non-null `pending[].retry_after_ms` value, then `POST` `{}` to that URL. The server retains the opaque checkpoint and provider continuation ID and resumes `traverseProvenance`; it does not reacquire the seed or restart discovery. The response keeps the result ID, prior edges and fallback attribution. A premature resume returns HTTP 429; simultaneous resume returns 409. GET reads the last finished invocation while a resume is running. Resuming a terminal result returns it unchanged.

Storage is process-local and bounded to 100 results. Restart/eviction makes retrieval and resume return 404. This is not a durable job service. The existing per-invocation provider budget and upstream rate-limit handling remain in force; this adapter does not add a global multi-user scheduler.

## Current frontend compatibility and handoff

`ariadne/lib/api.ts`, `ariadne/app/tree/page.tsx`, `ariadne/lib/graph.ts` and visual components require no visual edits to keep loading `result.tree`. The backend projection includes only the seed and validated DAG members; `tree.edges` intentionally excludes probable, related, candidate, and rejected links because a DAG must not be falsely represented as the old compatibility tree. Render the top-level graph for the full investigation network. Root IDs represent nodes without accepted parents. Acquired nonmembers are listed as excluded; the old rejected panel receives only scored rejections with known parent IDs, because its numeric confidence field cannot represent an unscored failure. All rejected relationships and acquisition failures remain inspectable at the top level.

The frontend's handwritten `ResearchResult` type is now incomplete. New frontend work should use `import type { AriadneResponse, AriadneRequest } from "../../shared/ariadne"` (adjust path to the importing file); a type-only import adds no Zod runtime dependency. `tree.stats` now identifies `pipeline: "recursive-provenance"` and traversal counts; there are no fabricated discovery/retrieval stats. The current visual components do not read those old stats. The frontend team still needs to display `status`, warnings/errors, execution labeling, submitted-text identity and resume controls: the compatibility projection alone cannot show that information. Do not present a result as live or complete solely because the old graph rendered.

```ts
import type { AriadneResponse, AriadneRequest } from "../../shared/ariadne";

const input: AriadneRequest = {
  claim: "The fictional amber lantern study reported improved local outcomes.",
  seed_url: "https://synthetic.test/downstream",
};
const http = await fetch(`${API_BASE_URL}/api/research`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
if (!http.ok) throw new Error(`Research request failed (${http.status})`);
const result: AriadneResponse = await http.json();
const graph = {
  nodes: result.nodes,
  links: result.edges.filter((x) => x.status !== "rejected"),
};
const displayState = {
  status: result.status,
  proposer: result.execution.proposer,
  warnings: result.warnings,
  errors: result.errors,
};
```

The synthetic URL above is an example, not a live resource. A UI can keep a partial graph visible while displaying the failed continuation and execution label.

## Synthetic complete, partial and failed responses

Full JSON examples, generated through the real controller and checked against `AriadneResponse`, are checked in alongside this handoff:

- [Complete response](examples/ariadne-complete.json): two acquired documents, one validated upstream → downstream edge, validator evidence and mutations, `execution.proposer: "mock"`.
- [Partial response](examples/ariadne-partial.json): the same validated edge survives a subsequent missing-source acquisition; the extra relationship stays rejected, with a fetch warning.
- [Failed response](examples/ariadne-failed.json): seed acquisition fails, leaving no acquired nodes/edges and a structured fetch error.

These fixtures use invented reports and `.test` URLs. They include the full compatibility `tree`, not abbreviated placeholders.

## Validation performed

Deterministic HTTP tests exercise production-shaped GPTZero bibliography response parsing, recursive expansion, accepted/rejected state preservation, candidate exclusion from the compatibility graph, evidence and mutation serialization, partial/failed states, fallback persistence across resume, provider/acquisition error sanitization, request limits and claim-only input. No ordinary test contacts GPTZero.

Manual `npm start` with `USE_MOCKS=true` and isolated ports exercised the actual server wiring: the Cohen seed returned 5 validated edges, 0 rejected edges, 5 inspected edges and 12 mutation records; a one-request provider budget returned a partial graph with 2 retained validated edges; a missing seed returned a normalized failed response. GET returned the saved result. The temporary server was stopped afterward.

Final repository checks: `npm test` passed 30 files / 278 tests; `npm run typecheck` passed; `git diff --check` passed. The full synthetic complete/partial/failed responses also passed the existing frontend `toGraphData` adapter with exactly their validated edges. No frontend visual components or core GPTZero/traversal/scoring/mutation files were changed, and no commit was made.
