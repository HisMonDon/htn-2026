import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DraftFields } from "../../shared/schema";
import type { LineageTree } from "../../shared/tree";
import type { ResearchInput } from "../research/pipeline";
import { scoreParents } from "../provenance/score";
import { HttpError, type LineageService } from "../service";

/**
 * JSON API for the UI (step 4).
 *
 *   GET  /api/health
 *   GET  /api/cases
 *   GET  /api/cases/:id
 *   GET  /api/cases/:id/runs
 *   POST /api/cases/:id/investigate          { source_url? }   stages 1-5, stops at approval
 *   PUT  /api/cases/:id/draft                { subject, body } resets approval to pending
 *   POST /api/cases/:id/approval             { status: "approved" | "rejected" }
 *   POST /api/cases/:id/execute                                submit, reopen, verify (approved only)
 *   POST /api/cases/:id/nodes/:nodeId/ai-check                 GPTZero evidence on one node
 *   POST /api/cases/:id/reset                                  restore the seed
 *   POST /api/provenance/score               { target, candidates, known_mutations? }
 *   POST /api/research                       { claim, seed_url?, fabricated_citations?, include_ai_evidence? }
 *   GET  /api/research/:id                                     a previously built lineage tree
 */

const InvestigateBody = z.object({ source_url: z.url().optional() }).strict();
const ApprovalBody = z.object({ status: z.enum(["approved", "rejected"]) }).strict();
const ProvenanceDoc = z.object({
  id: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  text: z.string(),
  url: z.string().optional(),
  links: z.array(z.string()).optional(),
});
const ResearchBody = z
  .object({
    claim: z.string().min(1).max(2000),
    seed_url: z.url().optional(),
    fabricated_citations: z.array(z.string().min(1)).max(20).optional(),
    include_ai_evidence: z.boolean().optional(),
  })
  .strict();
const ProvenanceBody = z.object({
  target: ProvenanceDoc,
  candidates: z.array(ProvenanceDoc).max(200),
  known_mutations: z.array(z.string()).max(100).optional(),
});

export interface ApiInfo {
  mocks: boolean;
  operator: string;
  detector: string;
  controlled_target_url: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1024 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

export interface ApiOptions {
  corsOrigin?: string | null;
  research?: (input: ResearchInput) => Promise<LineageTree>;
}

export function createApi(service: LineageService, info: ApiInfo, options: ApiOptions = {}) {
  type Handler = (params: string[], req: IncomingMessage) => Promise<unknown>;
  const trees = new Map<string, LineageTree>();
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, ...info })],
    ["GET", /^\/api\/cases$/, async () => service.list()],
    ["GET", /^\/api\/cases\/([^/]+)$/, async ([id]) => service.get(id!)],
    ["GET", /^\/api\/cases\/([^/]+)\/runs$/, async ([id]) => service.runsFor(id!)],
    [
      "POST",
      /^\/api\/cases\/([^/]+)\/investigate$/,
      async ([id], req) => service.investigate(id!, parseBody(InvestigateBody, await readJson(req)).source_url),
    ],
    [
      "PUT",
      /^\/api\/cases\/([^/]+)\/draft$/,
      async ([id], req) => service.updateDraft(id!, parseBody(DraftFields, await readJson(req))),
    ],
    [
      "POST",
      /^\/api\/cases\/([^/]+)\/approval$/,
      async ([id], req) => service.decide(id!, parseBody(ApprovalBody, await readJson(req)).status),
    ],
    ["POST", /^\/api\/cases\/([^/]+)\/execute$/, async ([id]) => service.execute(id!)],
    [
      "POST",
      /^\/api\/cases\/([^/]+)\/nodes\/([^/]+)\/ai-check$/,
      async ([id, nodeId]) => service.checkAiWriting(id!, nodeId!),
    ],
    ["POST", /^\/api\/cases\/([^/]+)\/reset$/, async ([id]) => service.reset(id!)],
    [
      "POST",
      /^\/api\/research$/,
      async (_, req) => {
        if (!options.research) throw new HttpError(501, "research is not configured");
        const body = parseBody(ResearchBody, await readJson(req));
        let tree: LineageTree;
        try {
          tree = await options.research(body);
        } catch (error) {
          throw new HttpError(422, error instanceof Error ? error.message : "research failed");
        }
        const id = randomUUID();
        trees.set(id, tree);
        return { id, tree };
      },
    ],
    [
      "GET",
      /^\/api\/research\/([^/]+)$/,
      async ([id]) => {
        const tree = trees.get(id!);
        if (!tree) throw new HttpError(404, `unknown research result "${id}"`);
        return { id, tree };
      },
    ],
    [
      "POST",
      /^\/api\/provenance\/score$/,
      async (_, req) => {
        const body = parseBody(ProvenanceBody, await readJson(req));
        return scoreParents(body.target, body.candidates, { knownMutations: body.known_mutations ?? [] });
      },
    ],
  ];

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://api.local");
    const method = req.method ?? "GET";
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    if (options.corsOrigin) {
      headers["access-control-allow-origin"] = options.corsOrigin;
      headers["access-control-allow-methods"] = "GET, POST, PUT, OPTIONS";
      headers["access-control-allow-headers"] = "content-type";
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    if (method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    let pathMatched = false;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      pathMatched = true;
      if (routeMethod !== method) continue;
      try {
        const params = match.slice(1).map((part) => decodeURIComponent(part));
        return send(200, await handler(params, req));
      } catch (error) {
        if (error instanceof HttpError) return send(error.status, { error: error.message });
        return send(500, { error: error instanceof Error ? error.message : "internal error" });
      }
    }
    send(pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "not found" });
  };
}
