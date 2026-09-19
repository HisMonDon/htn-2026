import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { consumePermit, type SubmissionPermit } from "./safety";
import { classifyField, normalizeText, routeScore, type FieldSlot } from "./semantics";
import type {
  BrowserOperator,
  CorrectionFormValues,
  CorrectionInspection,
  FillResult,
  PageReading,
  PassageResult,
  RouteResult,
  SubmitResult,
} from "./types";

/**
 * OFFLINE TEST OPERATOR. Not Browserbase, and never reported as Browserbase.
 *
 * Reads pages over HTTP and applies the same site-independent heuristics a reader would
 * (link wording, form labels). It exists so the orchestration and safety gates can be tested in CI
 * without cloud credentials. It has no replay URL. Selected only when USE_MOCKS is on.
 */

interface LoadedPage {
  url: string;
  html: string;
  $: cheerio.CheerioAPI;
}

interface FilledForm {
  pageUrl: string;
  action: string;
  method: string;
  values: [string, string][];
}

const MAX_ROUTE_HOPS = 2;

export class OfflineOperator implements BrowserOperator {
  readonly kind = "offline-heuristic" as const;
  private page: LoadedPage | null = null;
  private filled: FilledForm | null = null;

  constructor(
    private readonly allowedOrigins: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  replayUrl(): string | null {
    return null;
  }

  private async load(url: string, init?: RequestInit): Promise<LoadedPage> {
    const response = await this.fetchImpl(url, { redirect: "follow", ...init });
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
    const html = await response.text();
    this.page = { url: response.url || url, html, $: cheerio.load(html) };
    return this.page;
  }

  private requirePage(): LoadedPage {
    if (!this.page) throw new Error("no page is open");
    return this.page;
  }

  private reading(page: LoadedPage): PageReading {
    return { url: page.url, text: page.$("body").text().replace(/\s+/g, " ").trim() };
  }

  async open(url: string): Promise<PageReading> {
    this.filled = null;
    return this.reading(await this.load(url));
  }

  async findPassage(hints: string[]): Promise<PassageResult> {
    const { $ } = this.requirePage();
    const wanted = hints.map(normalizeText).filter(Boolean);
    let best: { text: string; score: number } | null = null;
    $("p, li, blockquote, td, dd").each((_, element) => {
      const text = $(element).text().replace(/\s+/g, " ").trim();
      const normalized = normalizeText(text);
      const score = wanted.filter((hint) => normalized.includes(hint)).length;
      if (score > 0 && (!best || score > best.score)) best = { text, score };
    });
    const found = best as { text: string; score: number } | null;
    return found ? { found: true, passage: found.text } : { found: false, passage: null };
  }

  /** A form that asks for free text and looks like it is about corrections. */
  private correctionForm(page: LoadedPage): cheerio.Cheerio<Element> | null {
    const { $ } = page;
    const pageScore = routeScore($("h1, h2, title").text());
    let chosen: cheerio.Cheerio<Element> | null = null;
    $("form").each((_, element) => {
      const form = $(element);
      const hasText = form.find("textarea").length > 0;
      const formText = `${form.text()} ${form.find("button, input[type=submit]").text()}`;
      if (hasText && (pageScore > 0 || routeScore(formText) > 0)) {
        chosen = form;
        return false;
      }
      return undefined;
    });
    return chosen;
  }

  async locateCorrectionRoute(): Promise<RouteResult> {
    const visited = new Set<string>();
    let frontier = [this.requirePage().url];
    for (let hop = 0; hop <= MAX_ROUTE_HOPS; hop += 1) {
      const next: { href: string; score: number }[] = [];
      for (const url of frontier) {
        if (visited.has(url)) continue;
        visited.add(url);
        const page = this.page?.url === url ? this.page : await this.load(url);
        if (this.correctionForm(page)) {
          const policy = page.$("main p, body > p").first().text().replace(/\s+/g, " ").trim();
          return { route_type: "form", route_url: page.url, policy_summary: policy };
        }
        page.$("a[href]").each((_, element) => {
          const anchor = page.$(element);
          const href = anchor.attr("href") ?? "";
          const score = routeScore(`${anchor.text()} ${anchor.attr("title") ?? ""} ${anchor.attr("aria-label") ?? ""}`);
          if (score <= 0) return;
          if (href.startsWith("mailto:")) {
            next.push({ href, score: score + 0.5 });
            return;
          }
          next.push({ href: new URL(href, page.url).toString(), score });
        });
      }
      const mail = next.find((candidate) => candidate.href.startsWith("mailto:"));
      frontier = next
        .filter((candidate) => !candidate.href.startsWith("mailto:"))
        .sort((a, b) => b.score - a.score)
        .map((candidate) => candidate.href)
        .slice(0, 3);
      if (frontier.length === 0 && mail) {
        return { route_type: "editorial_email", route_url: mail.href, policy_summary: "Corrections by email." };
      }
      if (frontier.length === 0) break;
    }
    return { route_type: "none", route_url: null, policy_summary: "No correction route found." };
  }

  async fillCorrectionForm(values: CorrectionFormValues): Promise<FillResult> {
    const page = this.requirePage();
    const form = this.correctionForm(page);
    if (!form) throw new Error("no correction form on the current page");
    const { $ } = page;
    const bySlot: Record<FieldSlot, string> = {
      name: values.name,
      email: values.email,
      subject: values.subject,
      passage: values.passage,
      body: values.body,
      sources: values.sources.join("\n"),
    };
    const filled: string[] = [];
    const missing: string[] = [];
    const entries: [string, string][] = [];
    form.find("input, textarea, select").each((_, element) => {
      const control = $(element);
      const name = control.attr("name");
      const type = (control.attr("type") ?? "").toLowerCase();
      if (!name || ["submit", "button", "reset", "image", "file"].includes(type)) return;
      if (type === "hidden") {
        entries.push([name, control.attr("value") ?? ""]);
        return;
      }
      const id = control.attr("id");
      const label = id ? $(`label[for="${id}"]`).text() : control.closest("label").text();
      const descriptor = [label, name, id, control.attr("placeholder"), control.attr("aria-label")]
        .filter(Boolean)
        .join(" ");
      const slot = classifyField(descriptor, type || null);
      if (slot) {
        entries.push([name, bySlot[slot]]);
        filled.push(slot);
      } else if (control.attr("required") !== undefined) {
        missing.push(label.trim() || name);
      }
    });
    this.filled = {
      pageUrl: page.url,
      action: new URL(form.attr("action") ?? page.url, page.url).toString(),
      method: (form.attr("method") ?? "get").toLowerCase(),
      values: entries,
    };
    return { filled, missing_required: missing };
  }

  async submitCorrectionForm(permit: SubmissionPermit): Promise<SubmitResult> {
    if (!this.filled) throw new Error("no filled form to submit");
    consumePermit(permit, this.filled.pageUrl, this.allowedOrigins);
    // The form action must also stay on the permitted origin.
    consumeActionOrigin(this.filled.action, permit.origin);
    const body = new URLSearchParams(this.filled.values);
    const page =
      this.filled.method === "post"
        ? await this.load(this.filled.action, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          })
        : await this.load(`${this.filled.action}?${body}`);
    this.filled = null;
    return { submitted: true, result_url: page.url, message: page.$("h1").first().text().trim() };
  }

  async readPage(): Promise<PageReading> {
    return this.reading(this.requirePage());
  }

  async inspectCorrection(passage: string): Promise<CorrectionInspection> {
    const { $ } = this.requirePage();
    const needle = normalizeText(passage);
    let marked: boolean | null = null;
    $("p, li, blockquote, td, dd").each((_, element) => {
      const block = $(element);
      if (!normalizeText(block.text()).includes(needle)) return;
      const struck = block.find("del, s, strike").filter((__, el) => normalizeText($(el).text()).includes(needle));
      const annotated = /correct/i.test(block.find("ins, mark, em, small").text());
      marked = struck.length > 0 || annotated || marked === true;
    });
    const notices: string[] = [];
    $("h1, h2, h3, h4, strong").each((_, element) => {
      const heading = $(element);
      if (!/\bcorrect(ion|ed)\b/i.test(heading.text())) return;
      const section = heading.parent();
      notices.push(section.text().replace(/\s+/g, " ").trim());
    });
    return { passage_marked_corrected: marked, notices };
  }

  async currentUrl(): Promise<string> {
    return this.requirePage().url;
  }

  async close(): Promise<void> {
    this.page = null;
    this.filled = null;
  }
}

function consumeActionOrigin(action: string, origin: string): void {
  if (new URL(action).origin !== origin) {
    throw new Error("submission blocked: form action posts to a different origin");
  }
}
