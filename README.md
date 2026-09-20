# Ariadne

Traces an AI hallucination back through the documents it spread across, builds an evidence packet, and drafts a correction that a human approves before anything is submitted.

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
