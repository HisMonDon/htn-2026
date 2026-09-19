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
- **Output** (`shared/tree.ts`): nodes, accepted edges with basis, mutations, timing, link evidence and alternatives, plus rejected edges, excluded candidates and stats.

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
| POST | `/api/research` | `{ claim, seed_url?, seed_source?, fabricated_citations?, include_ai_evidence? }` -> `{ id, tree }` |
| GET | `/api/research/:id` | a previously built tree |

## Layout

- `shared/`: Zod data contract, inferred TypeScript types, validators, and tests
- `data/`: validated fixtures in step 2
- `server/target/`: controlled target (the only place submissions go)
- `server/agent/`: orchestrator, safety gate, Browserbase/Stagehand operator, offline test operator
- `server/gptzero/`: AI-writing detector interface, real and mock clients
- `server/provenance/`: deterministic parent scoring
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
