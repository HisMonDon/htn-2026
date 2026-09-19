import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTargetApp, type TargetApp, type TargetVariant } from "./app";

export interface RunningTarget {
  app: TargetApp;
  server: Server;
  /** Local base URL, e.g. http://127.0.0.1:4100 */
  url: string;
  close(): Promise<void>;
}

export async function startTarget(
  options: { port?: number; host?: string; variant?: TargetVariant } = {},
): Promise<RunningTarget> {
  const app = createTargetApp(options.variant);
  const server = createServer((req, res) => {
    app.handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : "error");
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    app,
    server,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
