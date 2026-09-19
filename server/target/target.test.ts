import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTarget, type RunningTarget } from "./server";

let target: RunningTarget;
beforeEach(async () => {
  target = await startTarget();
});
afterEach(async () => {
  await target.close();
});

async function html(path: string) {
  const response = await fetch(`${target.url}${path}`);
  return { status: response.status, body: await response.text() };
}

function form(fields: Record<string, string>) {
  return fetch(`${target.url}/corrections`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const valid = {
  article: "cohen-supervised-release",
  email: "a@example.com",
  subject: "Nonexistent cases",
  passage: "The motion relies on United States v. Figueroa-Florez",
  details: "These cases do not exist.",
};

describe("controlled target", () => {
  it("serves the article with the false passage and a discoverable correction link", async () => {
    const { status, body } = await html("/articles/cohen-supervised-release");
    expect(status).toBe(200);
    expect(body).toContain("United States v. Figueroa-Florez");
    expect(body).toContain("Report an error in this article");
  });

  it("serves a correction form", async () => {
    const { body } = await html("/corrections?article=cohen-supervised-release");
    expect(body).toContain("<form");
    expect(body).toContain("textarea");
  });

  it("rejects a submission missing required fields and changes nothing", async () => {
    const response = await form({ ...valid, details: "" });
    expect(response.status).toBe(422);
    expect(target.app.state().corrections).toHaveLength(0);
  });

  it("publishes an accepted correction on the article", async () => {
    const response = await form(valid);
    expect(response.status).toBe(303);
    const { body } = await html("/articles/cohen-supervised-release");
    expect(body).toContain("<del>The motion relies on United States v. Figueroa-Florez");
    expect(body).toContain("Nonexistent cases");
    expect(target.app.state().corrections[0]?.matched_paragraph).toBe(1);
  });

  it("escapes submitted content", async () => {
    await form({ ...valid, subject: "<script>alert(1)</script>" });
    const { body } = await html("/articles/cohen-supervised-release");
    expect(body).not.toContain("<script>alert(1)</script>");
  });
});
