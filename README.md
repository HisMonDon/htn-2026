# Ariadne

**Ariadne** is a provenance engine for AI hallucinations, built at Hack the North 2026. Give it a claim or a source such as a research paper, legal filing or news article, and it recursively follows citations, links and borrowed phrasing upstream to reconstruct where a fake citation or false claim was born, how it mutated as it spread and who repeated it, then drafts a correction request backed only by independent evidence.

## Core Philosophy: Providers Propose, Evidence Decides

Hallucinations spread because each repetition looks like corroboration. Ariadne's answer is to separate **discovery** from **judgement**. GPTZero, web search, Semantic Scholar and a document's own outbound links are all allowed to *suggest* candidate ancestors, but none of them can create an edge. Every proposed parent is fetched, fingerprinted and scored by a deterministic, model-free scorer, and timestamps are a hard precondition: a later document can never be the parent of an earlier one. AI-writing scores are never treated as proof that something is false.

## Key Milestones Completed

- [x] **Recursive Provenance Traversal:** Breadth-bounded upstream search that expands accepted parents hop by hop, with `strict`, `exploratory` and `deep` modes controlling how far it trusts weaker links.
- [x] **Deterministic Edge Scoring:** Parents are ranked by explicit links, shared mutations (fabricated citations, invented authors, distinctive typos) weighted by rarity, rare shared word 6-grams and capped similarity. No LLM is involved.
- [x] **Temporal Reasoning:** Claimed dates are cross-checked against what a document links to. A page that links to something published later has its date marked as contradicted and treated only as a lower bound.
- [x] **Multi-Channel Discovery:** GPTZero bibliography proposals, Brave web search, the Semantic Scholar Academic Graph and document-native signals (DOIs, arXiv IDs, dockets, case names, outbound links) are merged into one candidate pool.
- [x] **Claim Mutation Analysis:** Sentence-level diffing of each hop's passage shows exactly how a claim drifted as it was repeated.
- [x] **Content Fingerprinting:** SHA-256 identity over NFKC-normalised text collapses mirrors and reposts without merging genuinely revised documents.
- [x] **Hybrid Retrieval:** Elasticsearch (semantic or lexical) when configured, with an in-memory BM25 index as the offline default.
- [x] **Safe Action Loop:** A Browserbase and Stagehand operator opens the source, verifies the false passage is really on the page, locates the correction route and fills the form, then stops for human approval.
- [x] **Submission Permits:** Real external sites may be inspected but never submitted to. Submission requires explicit approval and a controlled-target origin, enforced by permits that only the safety module can mint.
- [x] **Offline Mode:** `USE_MOCKS=true` runs the full pipeline against a synthetic corpus modelled on the Michael Cohen and Google Bard fabricated case citations incident, including decoy pages designed to mislead.
- [x] **Interactive Lineage Graph:** A Next.js frontend renders the provenance tree as a force-directed graph with accepted, rejected and candidate evidence panels.
- [x] **Heavily Tested:** Roughly 400 Vitest cases across schemas, scoring, traversal, ingestion, providers, safety and the API.

## Architecture

| Component | Description |
| --- | --- |
| `shared/` | The data contract. Zod schemas and types for cases, trees, the Ariadne request and response, and provenance validation. |
| `server/research/traversal.ts` | The recursive engine. Fetches, scores and expands proposals within depth, node, edge and per-node child budgets. |
| `server/research/edges.ts` | Timing computation and deterministic edge scoring with accept, exploratory and related thresholds. |
| `server/research/ingestion.ts` / `extract.ts` / `pdf.ts` | Acquires HTML and PDF sources, extracts the relevant passage, links and dates. |
| `server/research/timestamps.ts` | Ranks competing date signals and flags conflicts. |
| `server/research/mutations.ts` | Claim mutation analysis between parent and child passages. |
| `server/research/fingerprint.ts` / `canonicalize.ts` | Content-addressed document identity and duplicate collapsing. |
| `server/research/multi-proposer.ts` | Merges the discovery channels into one proposer, recording each channel for audit only. |
| `server/research/providers/` | Brave Search, Semantic Scholar, HTTP fetching, the offline corpus and resolvers. |
| `server/research/candidate-index.ts` / `bm25.ts` | Elasticsearch hybrid retrieval with an in-memory BM25 fallback. |
| `server/provenance/` | Standalone parent scoring, tree reconstruction and an independent edge validator used for inspection. |
| `server/gptzero/` | GPTZero client, bibliography proposals, relevant-source lookup and a demo cache. |
| `server/agent/` | The action loop: orchestrator, draft builder, passage-integrity check, semantics and the safety gate. |
| `server/api/` | HTTP API for cases, investigations, approvals, execution and research. |
| `server/target/` | A controlled correction-form target site, the only place submissions are allowed. |
| `ariadne/` | Next.js 16 frontend: landing page, search and the lineage graph view. |

## Under the Hood

### How an Investigation Runs

1. **Seed:** A claim, a URL, raw text or a bibliographic reference becomes the root document.
2. **Propose:** Every discovery channel suggests upstream candidates for the current document.
3. **Acquire:** Each candidate is fetched, parsed and fingerprinted. Failures, duplicates and cycles are recorded as rejected edges with a reason.
4. **Score:** The deterministic scorer decides acceptance (0.35 threshold in strict mode). Exploratory mode also follows probable links above 0.2, and deep mode follows related links above 0.05.
5. **Recurse:** Accepted parents become the next frontier until no proposals remain, every proposal is rejected or a budget is hit (default depth 5, 25 expanded nodes, 60 edges).
6. **Report:** The response lists nodes, validated, rejected and candidate edges, per-branch termination reasons, warnings and errors, with a status of `complete`, `partial` or `failed`.

### The Action Loop

```
investigate:  open_source -> verify_passage -> locate_route -> fill_fields -> await_approval (stop)
execute:      [approval gate] -> submit -> reopen -> verify
```

The draft cites only independent evidence URLs and carries a unique `LINEAGE-<case>` token so the agent can reopen the page and confirm the correction landed.

### Key Endpoints

| Route | Purpose |
| --- | --- |
| `POST /api/research` | Run a recursive provenance investigation. See [docs/ariadne-api.md](docs/ariadne-api.md). |
| `GET /api/research/:id` | Retrieve a previous result. |
| `POST /api/cases/:id/investigate` | Run the action loop up to the approval gate. |
| `POST /api/cases/:id/approval` | Approve or reject the drafted correction. |
| `POST /api/cases/:id/execute` | Submit, reopen and verify (approved cases only). |
| `POST /api/provenance/score` | Score candidate parents for a target document. |

## Quick Start

Requires Node 24+ and npm 11+.

```bash
npm install
cp .env.example .env   # fill in locally; .env is git-ignored
```

Set `USE_MOCKS=true` to run fully offline without any API keys. For live runs, configure `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` and `GPTZERO_API_KEY`, plus optional `BRAVE_SEARCH_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` and Elastic settings. Every option is documented in `.env.example`.

### Backend

```bash
npm start              # API on :4000, controlled target on :4100
npm test               # Vitest suite
npm run typecheck      # TypeScript
npm run research       # reconstruct a provenance tree from a claim
npm run loop           # run the action loop against the controlled target
npm run demo:cohen     # the Cohen and Bard fabricated citations demo
npm run demo:academic  # Semantic Scholar citation graph demo
```

### Frontend

```bash
cd ariadne
npm install
npm run dev            # http://localhost:3000
```

Set `NEXT_PUBLIC_API_URL` if the backend is not on `http://localhost:4000`.

## Team

Built at Hack the North 2026 by HisMonDon, Sucram314, Edlyn To and Ryan Zhang.
