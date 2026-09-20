# Lineage

Lineage traces an AI hallucination through the short chain of documents it propagated across, builds an evidence packet, finds a legitimate correction route, pauses for human approval, submits only to a controlled target, and verifies the result.

## Setup

Requires Node 24+ and npm 11+.

```bash
npm install
cp .env.example .env
```

Fill in `.env` locally. It is git-ignored. Only `.env.example` is committed.

| Variable | Purpose |
| --- | --- |
| `BROWSERBASE_API_KEY` | Browserbase session and Stagehand Model Gateway (no separate LLM key needed) |
| `BROWSERBASE_PROJECT_ID` | Optional; Browserbase infers the project from the key |
| `GPTZERO_API_KEY` | GPTZero `POST /v2/predict/text` |
| `BRAVE_SEARCH_API_KEY` | Optional. Enables the web-retrieval proposer that runs alongside GPTZero (Brave Search API). Unset: GPTZero-only discovery. Search hits are only candidates; they are fetched and validated like any GPTZero proposal |
| `WEB_SEARCH_MAX_QUERIES`, `WEB_SEARCH_RESULTS_PER_QUERY`, `WEB_SEARCH_MAX_CANDIDATES`, `WEB_SEARCH_TIMEOUT_MS` | Per-source search bounds (defaults 5, 4, 10, 10000) |
| `USE_MOCKS` | `true`: offline test operator and mock GPTZero. Anything else: real Browserbase and GPTZero, no silent fallback |
| `CONTROLLED_TARGET_URL` | Browser-facing URL of the controlled target. Must be a public tunnel for Browserbase |
| `STAGEHAND_MODEL` | Optional model, e.g. `anthropic/claude-sonnet-4-6`; omitted lets Model Gateway choose |
| `TARGET_PORT`, `API_PORT` | Local ports (default 4100, 4000) |
| `BROWSERBASE_SESSION_TIMEOUT_S` | How long a filled form waits for approval (default 900) |
| `LINEAGE_CONTACT_EMAIL` | Reply address typed into correction forms |
| `CORS_ORIGIN` | Origin allowed to call the API from a browser (unset: no CORS headers) |
| `ELASTIC_URL` / `ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY` | Elastic retrieval for the research tree (unset: in-memory BM25) |
| `ELASTIC_INDEX`, `ELASTIC_SEMANTIC`, `ELASTIC_INFERENCE_ID` | Index name, hybrid on/off (default on), `semantic_text` inference endpoint |

## Run

```bash
npm run typecheck
npm test
npm run dev      # Vitest watch mode
npm start        # API on :4000 and controlled target on :4100
npm run target   # controlled target only (TARGET_VARIANT=alt for the alternate markup)
npm run loop     # optional action loop against the controlled target (stops at approval; --approve to continue)
npm run research # reconstruct a provenance tree from a claim (USE_MOCKS=true: offline corpus)
```

### Provenance tree (primary feature)

Given a claim (and optionally a seed URL), Lineage discovers candidate pages, extracts structured evidence, retrieves candidate parent/child pairs, scores every pair deterministically, and assembles the most defensible short tree. It is never handed the known chain.

```
discover (direct source fetch -> optional resolution -> links) -> extract -> index/retrieve pairs -> score edges -> assemble tree
```

- **Discovery:** An upstream source URL is fetched directly over HTTP (with redirects, HTML/PDF detection, and a timeout). A provider-agnostic resolver may be injected for incomplete or dead citations. Research acquisition and resolution do not use Browserbase. The synthetic offline corpus in `data/research-corpus.ts` remains available under `USE_MOCKS=true`.
- **Evidence per page:** URL, publisher, timestamp and where it came from, relevant passage, outbound links, fabricated citations and spelling variants, optional GPTZero result.
- **Retrieval:** Elastic hybrid (RRF over lexical, `semantic_text` and a shared-citation keyword match) when `ELASTIC_URL` or `ELASTIC_CLOUD_ID` is set, otherwise in-memory BM25. Retrieval only proposes pairs.
- **Scoring** (`server/research/edges.ts`):
  - A later page never parents an earlier one. A page linking to something later than its own claimed date gets a flagged date conflict.
  - Links from the child prove order. Shared fabricated citations place a page in the lineage.
  - Copied phrasing outside quotations picks between parents. Similarity alone stays at 0.25 or below.
  - Same-day pages without a link get no direction.
- **Output** (`shared/tree.ts`): a validated tree/DAG with all explicit accepted parents, roots derived from accepted ancestry, and accepted edges carrying basis, timing, link evidence, alternatives, and human-readable added/omitted/reframed claim mutations. Rejected edges, excluded candidates, and run stats remain available for audit.

### Independent edge validation

A proposer (today GPTZero, through `server/gptzero/proposal.ts`) can point at a pair of documents
and say "this claim may have come from there". `server/provenance/validator.ts` decides on its own
whether that pair is a provenance edge, and returns a `ProvenanceEdgeValidation`
(`shared/provenance-validation.ts`) with a relationship type, a confidence, every signal marked
passed/failed/not-applicable, the reasons, and evidence the graph can render directly — including a
ready-made `TreeEdge` when the edge is accepted.

The scoring core takes two documents, their candidate pool and known fabrications, and nothing
else: there is no parameter through which a proposer's probability could reach it. Three signals
are preconditions that can only rule an edge out — `distinct_artifact` (not the same text twice),
`chronology` (the child can have been written after the parent) and `canonical_metadata` (the
named URL really resolves to this artifact). Four can corroborate one: `explicit_link`,
`citation_reference`, `shared_fabrications` (invented citations, the same misspelling of one, other
hallucinated entities, discounted by how many candidates carry them) and, weakly,
`shared_phrasing` and `passage_overlap`. Without a link, a named reference or a shared fabrication,
confidence is capped at 0.25; undated pairs at 0.3 and same-day pairs at 0.6, which report
`shared-source` rather than pick a direction.

### Action loop

```
investigate: open_source -> verify_passage -> locate_route -> fill_fields -> await_approval (stops, pending)
execute:     approval gate -> submit -> reopen -> verify
```

`USE_MOCKS=true npm run loop` exercises the loop with the offline test operator, which reads pages over HTTP and is not Browserbase. The real loop needs Browserbase. Its cloud browsers cannot reach `localhost`, so tunnel the target first:

```bash
ngrok http 4100
```

Then set `CONTROLLED_TARGET_URL` to the tunnel URL and `BROWSERBASE_API_KEY` in `.env`, and run `npm run loop`. Each action log entry carries the Browserbase session replay URL.

### API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | mode, operator, detector |
| GET | `/api/cases`, `/api/cases/:id`, `/api/cases/:id/runs` | cases and per-run stage reports |
| POST | `/api/cases/:id/investigate` | `{ source_url? }`; stops at approval |
| PUT | `/api/cases/:id/draft` | `{ subject, body }`; resets approval to pending |
| POST | `/api/cases/:id/approval` | `{ status: "approved" \| "rejected" }` |
| POST | `/api/cases/:id/execute` | submit, reopen, verify; refused unless approved |
| POST | `/api/cases/:id/nodes/:nodeId/ai-check` | GPTZero evidence on one chain node |
| POST | `/api/cases/:id/reset` | restore the seed |
| POST | `/api/provenance/score` | `{ target, candidates, known_mutations? }` |
| POST | `/api/research` | Recursive GPTZero proposal → traversal → validation/mutation API; [request, response and frontend handoff](docs/ariadne-api.md) |
| GET | `/api/research/:id` | Saved normalized Ariadne response, including the compatibility tree |
| POST | `/api/research/:id/resume` | `{}`; resume pending recursive traversal after its retry delay |

## Layout

- `shared/`: Zod data contract, inferred TypeScript types, validators, and tests
- `data/`: validated fixtures in step 2
- `server/target/`: controlled target (the only place submissions go)
- `server/agent/`: orchestrator, safety gate, Browserbase/Stagehand operator, offline test operator
- `server/gptzero/`: AI-writing detector interface, real and mock clients
- `server/provenance/`: deterministic parent scoring and the independent edge validator
- `server/research/`: discovery, evidence extraction, candidate index (Elastic/BM25), edge scoring, tree assembly
- `server/api/`, `server/service.ts`: HTTP API and case state
- `client/`: API client and minimal UI wiring in step 4

## Safety

- Real external sites may be investigated for correction routes, but the agent never submits to them.
- Submission is limited to the controlled target and requires `approval.status === "approved"`.
- GPTZero evidence can support AI-writing analysis but never establishes falsehood or triggers an action.
- Falsehood requires at least one independent evidence URL.
- Submission needs a single-use permit from `server/agent/safety.ts`, bound to the controlled-target origin and to the exact draft that was approved. Editing the draft voids the approval.
- Verification runs only after a completed submit, on a freshly reopened page.
