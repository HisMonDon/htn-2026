import type { IncomingMessage, ServerResponse } from "node:http";
import { ARTICLES, type Article } from "./content";

/**
 * The controlled target: a deliberately small "publisher" that Lineage is allowed to submit to.
 * Two markup variants exist so tests can prove the agent is not keyed to one page's selectors.
 */
export type TargetVariant = "classic" | "alt";

interface FieldNames {
  name: string;
  email: string;
  subject: string;
  passage: string;
  details: string;
  sources: string;
  article: string;
}

type LabelKey = Exclude<keyof FieldNames, "article">;

interface VariantMarkup {
  routePath: string;
  routeLinkText: string;
  routePlacement: "footer" | "nav";
  fields: FieldNames;
  labels: Record<LabelKey, string>;
  submitText: string;
}

const VARIANTS: Record<TargetVariant, VariantMarkup> = {
  classic: {
    routePath: "/corrections",
    routeLinkText: "Report an error in this article",
    routePlacement: "footer",
    fields: {
      name: "name",
      email: "email",
      subject: "subject",
      passage: "passage",
      details: "details",
      sources: "sources",
      article: "article",
    },
    labels: {
      name: "Your name",
      email: "Email",
      subject: "Subject",
      passage: "Passage that is wrong",
      details: "What is wrong and what it should say",
      sources: "Sources (one URL per line)",
    },
    submitText: "Send correction request",
  },
  alt: {
    routePath: "/feedback/errata",
    routeLinkText: "Request a correction",
    routePlacement: "nav",
    fields: {
      name: "fullname",
      email: "contact",
      subject: "headline",
      passage: "quoted_text",
      details: "explanation",
      sources: "evidence_links",
      article: "ref",
    },
    labels: {
      name: "Full name",
      email: "Contact address",
      subject: "Headline for your request",
      passage: "Quoted text",
      details: "Explanation",
      sources: "Evidence (links)",
    },
    submitText: "Submit",
  },
};

export interface CorrectionRecord {
  id: number;
  article: string;
  name: string;
  email: string;
  subject: string;
  passage: string;
  details: string;
  sources: string[];
  received_at: string;
  matched_paragraph: number | null;
}

interface ArticleState {
  article: Article;
  correctedParagraphs: Set<number>;
}

export interface TargetState {
  variant: TargetVariant;
  corrections: CorrectionRecord[];
}

export interface TargetApp {
  variant: TargetVariant;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  state(): TargetState;
  reset(): void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^a-z0-9.]+/)
      .filter((word) => word.length > 2),
  );
}

/** Pick the paragraph the reporter quoted: substring match first, then best word overlap. */
function matchParagraph(paragraphs: string[], passage: string): number | null {
  const needle = normalize(passage);
  if (!needle) return null;
  const exact = paragraphs.findIndex((paragraph) => {
    const own = normalize(paragraph);
    return own.includes(needle) || needle.includes(own);
  });
  if (exact >= 0) return exact;
  const quoted = words(passage);
  let bestIndex: number | null = null;
  let bestScore = 0;
  paragraphs.forEach((paragraph, index) => {
    const own = words(paragraph);
    const shared = [...quoted].filter((word) => own.has(word)).length;
    const score = shared / Math.max(1, quoted.size);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore >= 0.5 ? bestIndex : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createTargetApp(variant: TargetVariant = "classic"): TargetApp {
  const markup = VARIANTS[variant];
  let articles = new Map<string, ArticleState>();
  let corrections: CorrectionRecord[] = [];

  function reset() {
    articles = new Map(
      ARTICLES.map((article) => [
        article.slug,
        { article: structuredClone(article), correctedParagraphs: new Set<number>() },
      ]),
    );
    corrections = [];
  }
  reset();

  function routeHref(slug: string): string {
    return `${markup.routePath}?${new URLSearchParams({ [markup.fields.article]: slug })}`;
  }

  function page(title: string, body: string, slug?: string): string {
    const routeLink = slug
      ? `<a href="${escapeHtml(routeHref(slug))}">${escapeHtml(markup.routeLinkText)}</a>`
      : "";
    const nav = [
      `<a href="/">Home</a>`,
      `<a href="/subscribe">Subscribe</a>`,
      `<a href="/advertise">Advertise with us</a>`,
      markup.routePlacement === "nav" ? routeLink : "",
    ]
      .filter(Boolean)
      .join(" | ");
    const footer = [
      `<a href="/about">About</a>`,
      `<a href="/newsletter">Newsletter</a>`,
      markup.routePlacement === "footer" ? routeLink : "",
    ]
      .filter(Boolean)
      .join(" | ");
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)} | The Docket Digest</title></head>
<body>
<header><strong>The Docket Digest</strong> <nav>${nav}</nav></header>
<main>${body}</main>
<footer>${footer}</footer>
</body>
</html>`;
  }

  function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  }

  function renderArticle(entry: ArticleState): string {
    const { article, correctedParagraphs } = entry;
    const paragraphs = article.paragraphs
      .map((text, index) =>
        correctedParagraphs.has(index)
          ? `<p><del>${escapeHtml(text)}</del> <ins>[This passage was corrected. See the correction below.]</ins></p>`
          : `<p>${escapeHtml(text)}</p>`,
      )
      .join("\n");
    const notices = corrections
      .filter((correction) => correction.article === article.slug)
      .map(
        (correction) => `<section>
<h2>Correction</h2>
<p>Correction #${correction.id} (${escapeHtml(correction.received_at.slice(0, 10))}): ${escapeHtml(correction.subject)}</p>
<blockquote>${escapeHtml(correction.details)}</blockquote>
</section>`,
      )
      .join("\n");
    return page(
      article.headline,
      `<article>
<h1>${escapeHtml(article.headline)}</h1>
<p>By ${escapeHtml(article.byline)} | Published ${escapeHtml(article.published)}</p>
${paragraphs}
</article>
${notices}`,
      article.slug,
    );
  }

  function renderForm(slug: string, errors: string[] = []): string {
    const { fields, labels } = markup;
    const control = (key: LabelKey, type: "text" | "email" | "textarea", required: boolean) => {
      const id = `f-${fields[key]}`;
      const input =
        type === "textarea"
          ? `<textarea id="${id}" name="${fields[key]}" rows="5"${required ? " required" : ""}></textarea>`
          : `<input id="${id}" type="${type}" name="${fields[key]}"${required ? " required" : ""}>`;
      return `<p><label for="${id}">${escapeHtml(labels[key])}${required ? " (required)" : ""}</label><br>${input}</p>`;
    };
    const article = articles.get(slug);
    return page(
      "Corrections",
      `<h1>Corrections</h1>
<p>We correct errors of fact promptly. Tell us what is wrong, quote the passage, and include sources. Accepted corrections are published at the foot of the article.</p>
${article ? `<p>You are reporting an error in: <em>${escapeHtml(article.article.headline)}</em></p>` : ""}
${errors.length ? `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
<form method="post" action="${markup.routePath}">
<input type="hidden" name="${fields.article}" value="${escapeHtml(slug)}">
${control("name", "text", false)}
${control("email", "email", true)}
${control("subject", "text", true)}
${control("passage", "textarea", true)}
${control("details", "textarea", true)}
${control("sources", "textarea", false)}
<p><button type="submit">${escapeHtml(markup.submitText)}</button></p>
</form>`,
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://target.local");
    const method = req.method ?? "GET";

    // Test/demo hooks. Not linked from any page, so a browsing agent never sees them.
    if (url.pathname === "/__target/state" && method === "GET") {
      return send(res, 200, JSON.stringify({ variant, corrections }), "application/json");
    }
    if (url.pathname === "/__target/reset" && method === "POST") {
      reset();
      return send(res, 200, JSON.stringify({ ok: true }), "application/json");
    }

    if (url.pathname === "/" && method === "GET") {
      const list = [...articles.values()]
        .map(({ article }) => `<li><a href="/articles/${article.slug}">${escapeHtml(article.headline)}</a></li>`)
        .join("");
      return send(res, 200, page("Home", `<h1>Latest</h1><ul>${list}</ul>`));
    }

    const articleMatch = url.pathname.match(/^\/articles\/([a-z0-9-]+)$/);
    if (articleMatch && method === "GET") {
      const entry = articles.get(articleMatch[1]!);
      if (!entry) return send(res, 404, page("Not found", "<h1>Not found</h1>"));
      return send(res, 200, renderArticle(entry));
    }

    if (url.pathname === markup.routePath && method === "GET") {
      return send(res, 200, renderForm(url.searchParams.get(markup.fields.article) ?? ""));
    }

    if (url.pathname === markup.routePath && method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        return send(res, 413, page("Too large", "<h1>Request too large</h1>"));
      }
      const form = new URLSearchParams(raw);
      const get = (key: keyof FieldNames) => (form.get(markup.fields[key]) ?? "").trim();
      const slug = get("article");
      const entry = articles.get(slug);
      const errors: string[] = [];
      if (!entry) errors.push("Unknown article.");
      for (const key of ["email", "subject", "passage", "details"] as const) {
        if (!get(key)) errors.push(`${markup.labels[key]} is required.`);
      }
      if (errors.length || !entry) return send(res, 422, renderForm(slug, errors));

      const matched = matchParagraph(entry.article.paragraphs, get("passage"));
      if (matched !== null) entry.correctedParagraphs.add(matched);
      const record: CorrectionRecord = {
        id: corrections.length + 1,
        article: slug,
        name: get("name"),
        email: get("email"),
        subject: get("subject"),
        passage: get("passage"),
        details: get("details"),
        sources: get("sources").split(/\s+/).filter(Boolean),
        received_at: new Date().toISOString(),
        matched_paragraph: matched,
      };
      corrections.push(record);
      res.writeHead(303, { location: `${markup.routePath}/receipt/${record.id}` });
      res.end();
      return;
    }

    const receiptPrefix = `${markup.routePath}/receipt/`;
    if (url.pathname.startsWith(receiptPrefix) && method === "GET") {
      const id = Number(url.pathname.slice(receiptPrefix.length));
      const record = corrections.find((correction) => correction.id === id);
      if (!record) return send(res, 404, page("Not found", "<h1>Not found</h1>"));
      return send(
        res,
        200,
        page(
          "Correction received",
          `<h1>Thank you</h1>
<p>Correction request #${record.id} was received and published.</p>
<p><a href="/articles/${record.article}">View the corrected article</a></p>`,
        ),
      );
    }

    if (["/subscribe", "/advertise", "/about", "/newsletter"].includes(url.pathname)) {
      return send(res, 200, page("Info", "<h1>Coming soon</h1><p>Nothing to see here yet.</p>"));
    }

    return send(res, 404, page("Not found", "<h1>Not found</h1>"));
  }

  return {
    variant,
    handle,
    state: () => ({ variant, corrections: structuredClone(corrections) }),
    reset,
  };
}
