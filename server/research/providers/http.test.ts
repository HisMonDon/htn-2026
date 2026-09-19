import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DirectHttpFetcher } from "./http";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    switch (req.url) {
      case "/article":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><title>Evidence</title><body>HTML evidence</body></html>");
        return;
      case "/filing":
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(Buffer.from("%PDF-1.4\nminimal fixture"));
        return;
      case "/redirect":
        res.writeHead(302, { location: "/article" });
        res.end();
        return;
      case "/slow":
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("too late");
        }, 100);
        return;
      case "/json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"not":"evidence"}');
        return;
      case "/error":
        res.writeHead(503, { "content-type": "text/html" });
        res.end("temporarily unavailable");
        return;
      default:
        res.writeHead(404, { "content-type": "text/html" });
        res.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("DirectHttpFetcher", () => {
  it("fetches HTML evidence", async () => {
    await withServer(async (baseUrl) => {
      const page = await new DirectHttpFetcher().fetch(`${baseUrl}/article`);
      expect(page).toMatchObject({ url: `${baseUrl}/article`, kind: "html" });
      expect(page?.kind === "html" && page.html).toContain("HTML evidence");
    });
  });

  it("fetches PDF evidence as bytes for the existing PDF extractor", async () => {
    await withServer(async (baseUrl) => {
      const page = await new DirectHttpFetcher().fetch(`${baseUrl}/filing`);
      expect(page).toMatchObject({ url: `${baseUrl}/filing`, kind: "pdf" });
      if (page?.kind !== "pdf") throw new Error("expected PDF page");
      expect(new TextDecoder().decode(page.bytes)).toMatch(/^%PDF-/);
    });
  });

  it("follows redirects and preserves the final evidence URL", async () => {
    await withServer(async (baseUrl) => {
      const page = await new DirectHttpFetcher().fetch(`${baseUrl}/redirect`);
      expect(page).toMatchObject({ url: `${baseUrl}/article`, kind: "html" });
    });
  });

  it("times out nonfatally", async () => {
    await withServer(async (baseUrl) => {
      await expect(new DirectHttpFetcher({ timeoutMs: 10 }).fetch(`${baseUrl}/slow`)).resolves.toBeNull();
    });
  });

  it("treats dead URLs, server errors, and unsupported content as absent evidence", async () => {
    await withServer(async (baseUrl) => {
      const fetcher = new DirectHttpFetcher();
      await expect(fetcher.fetch(`${baseUrl}/missing`)).resolves.toBeNull();
      await expect(fetcher.fetch(`${baseUrl}/error`)).resolves.toBeNull();
      await expect(fetcher.fetch(`${baseUrl}/json`)).resolves.toBeNull();
    });
  });
});
