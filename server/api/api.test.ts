import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASE_ID, harness, type Harness } from "../test-helpers";
import { createApi } from "./app";

let h: Harness;
let server: Server;
let base: string;

beforeEach(async () => {
  h = await harness();
  const handle = createApi(h.service, {
    mocks: true,
    operator: "offline-heuristic",
    detector: "mock",
    controlled_target_url: h.target.url,
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("API", () => {
  it("runs the full loop over HTTP", async () => {
    expect((await call("GET", "/api/health")).json.ok).toBe(true);
    expect((await call("GET", "/api/cases")).json).toHaveLength(1);

    const investigated = await call("POST", `/api/cases/${CASE_ID}/investigate`, { source_url: h.articleUrl });
    expect(investigated.status).toBe(200);
    expect(investigated.json.run.outcome).toBe("awaiting_approval");

    const early = await call("POST", `/api/cases/${CASE_ID}/execute`);
    expect(early.json.run.outcome).toBe("awaiting_approval");
    expect(h.target.app.state().corrections).toHaveLength(0);

    const approved = await call("POST", `/api/cases/${CASE_ID}/approval`, { status: "approved" });
    expect(approved.json.approval.status).toBe("approved");

    const executed = await call("POST", `/api/cases/${CASE_ID}/execute`);
    expect(executed.json.run.outcome).toBe("verified");
    expect(executed.json.case.verification.status).toBe("passed");

    const runs = await call("GET", `/api/cases/${CASE_ID}/runs`);
    expect(runs.json.map((run: { phase: string }) => run.phase)).toEqual(["investigate", "execute", "execute"]);
  });

  it("refuses approval before a draft exists", async () => {
    const response = await call("POST", `/api/cases/${CASE_ID}/approval`, { status: "approved" });
    expect(response.status).toBe(409);
  });

  it("validates bodies and reports unknown routes", async () => {
    expect((await call("POST", `/api/cases/${CASE_ID}/approval`, { status: "yes" })).status).toBe(400);
    expect((await call("POST", `/api/cases/${CASE_ID}/investigate`, { source_url: "not a url" })).status).toBe(400);
    expect((await call("GET", "/api/cases/nope")).status).toBe(404);
    expect((await call("DELETE", "/api/cases")).status).toBe(405);
  });

  it("records AI-writing evidence without starting any action", async () => {
    const response = await call("POST", `/api/cases/${CASE_ID}/nodes/bard-generation/ai-check`);
    expect(response.status).toBe(200);
    expect(response.json.node.ai_evidence.provider).toBe("gptzero");
    expect(response.json.case.action_log).toEqual([]);
  });

  it("scores provenance", async () => {
    const response = await call("POST", "/api/provenance/score", {
      target: { id: "t", timestamp: "2023-12-02T00:00:00Z", text: "cites United States v. Ortiz" },
      candidates: [
        { id: "later", timestamp: "2023-12-03T00:00:00Z", text: "cites United States v. Ortiz" },
        { id: "earlier", timestamp: "2023-12-01T00:00:00Z", text: "cites United States v. Ortiz" },
      ],
      known_mutations: ["United States v. Ortiz"],
    });
    expect(response.json.parent_id).toBe("earlier");
  });
});

describe("research API", () => {
  it("reconstructs a tree from a claim and serves it again by id", async () => {
    const { createLineageController, createLineageDeps } = await import("./lineage");
    const handle = createApi(
      h.service,
      { mocks: true, operator: "offline-heuristic", detector: "mock", controlled_target_url: h.target.url },
      {
        lineage: createLineageController(createLineageDeps({ useMocks: true, gptzeroApiKey: null }), "mock"),
      },
    );
    const research = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => research.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(research.address() as AddressInfo).port}`;
    try {
      const claim = "United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato were real decisions.";
      const created = await fetch(`${url}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim, seed_url: "https://daily-ledger.test/2023/12/29/cohen-bard-fake-cases", fabricated_citations: ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"] }),
      });
      expect(created.status).toBe(200);
      const body = (await created.json()) as any;
      expect(body.status).toBe("complete");
      expect(body.tree.status).toBe("complete");
      expect(body.tree.diagnostics).toEqual([]);
      expect(body.tree.nodes.length).toBe(5);
      // A validated DAG may have merge points, so it can carry more than one incoming edge per
      // non-root while still keeping every accepted relationship unique and acyclic.
      expect(body.tree.edges.length).toBeGreaterThanOrEqual(body.tree.nodes.length - body.tree.root_ids.length);
      expect(new Set(body.tree.edges.map((edge: any) => `${edge.parent_id}>${edge.child_id}`)).size).toBe(
        body.tree.edges.length,
      );
      expect(body.tree.edges.every((edge: any) => Array.isArray(edge.claim_mutations))).toBe(true);
      expect(body.tree.stats.pipeline).toBe("recursive-provenance");
      expect(body.execution.proposer).toBe("mock");

      const again = (await (await fetch(`${url}/api/research/${body.id}`)).json()) as any;
      expect(again.tree.edges).toEqual(body.tree.edges);

      const bad = await fetch(`${url}/api/research`, { method: "POST", body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const none = await fetch(`${url}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: "nothing citable here" }),
      });
      expect(none.status).toBe(200);
      expect((await none.json()).status).toBe("complete");
    } finally {
      await new Promise((resolve) => research.close(resolve));
    }
  });
});
