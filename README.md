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

## Run

```bash
npm run typecheck
npm test
npm run dev      # Vitest watch mode
npm start        # API on :4000 and controlled target on :4100
npm run target   # controlled target only (TARGET_VARIANT=alt for the alternate markup)
npm run loop     # the full action loop against the controlled target, printed stage by stage
```

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

## Layout

- `shared/`: Zod data contract, inferred TypeScript types, validators, and tests
- `data/`: validated fixtures in step 2
- `server/target/`: controlled target (the only place submissions go)
- `server/agent/`: orchestrator, safety gate, Browserbase/Stagehand operator, offline test operator
- `server/gptzero/`: AI-writing detector interface, real and mock clients
- `server/provenance/`: deterministic parent scoring
- `server/api/`, `server/service.ts`: HTTP API and case state
- `client/`: API client and minimal UI wiring in step 4

## Safety

- Real external sites may be investigated for correction routes, but the agent never submits to them.
- Submission is limited to the controlled target and requires `approval.status === "approved"`.
- GPTZero evidence can support AI-writing analysis but never establishes falsehood or triggers an action.
- Falsehood requires at least one independent evidence URL.
- Submission needs a single-use permit from `server/agent/safety.ts`, bound to the controlled-target origin and to the exact draft that was approved. Editing the draft voids the approval.
- Verification runs only after a completed submit, on a freshly reopened page.
