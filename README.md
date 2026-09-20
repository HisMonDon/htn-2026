# Ariadne

Ariadne takes a source such as a research paper and recursively investigates fake citations and false claims to track down AI hallucinations.

## Setup

Requires Node 24+ and npm 11+.

```bash
npm install
cp .env.example .env   # fill in locally; .env is git-ignored
```

Set `USE_MOCKS=true` to run fully offline without external API keys.

## Run

```bash
npm test         # test suite
npm start        # API on :4000, controlled target on :4100
npm run research # reconstruct a provenance tree from a claim
npm run loop     # action loop against the controlled target
```

## Layout

- `shared/` — data contract and types
- `server/research/` — discovery, evidence extraction, edge scoring, tree assembly
- `server/provenance/` — parent scoring and edge validation
- `server/agent/` — orchestrator, safety gate, browser operator
- `server/api/` — HTTP API
- `ariadne/` — frontend
