import {
  browserbase,
  Stagehand,
  type ModelName,
  type Page,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";
import { z } from "zod";
import { consumePermit, type SubmissionPermit } from "./safety";
import { normalizeText } from "./semantics";
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
 * Browserbase operator built on Stagehand v4 (docs.stagehand.dev/v4).
 *
 * Every page decision (which passage, which link, which field, which button) is made by Stagehand's
 * natural-language act/observe/extract calls. There are no site-specific selectors here. Results the
 * model returns are cross-checked against the page's actual text before we trust them.
 *
 * Browserbase browsers run in the cloud and cannot reach localhost. For live runs the controlled
 * target must be exposed through a public tunnel and CONTROLLED_TARGET_URL set to that URL.
 */

export interface BrowserbaseOperatorOptions {
  apiKey: string;
  projectId: string | null;
  model: string | null;
  sessionTimeoutS: number;
  allowedOrigins: readonly string[];
}

const PassageSchema = z.object({
  found: z.boolean().describe("true only if the page contains a passage that states or relies on the claim"),
  passage: z.string().describe("the exact passage text, copied verbatim from the page; empty if not found"),
});

const RouteSchema = z.object({
  has_correction_form: z
    .boolean()
    .describe("true if this page has a form for reporting an error or requesting a correction"),
  corrections_email: z.string().describe("an email address for corrections shown on the page, or empty"),
  policy_summary: z.string().describe("one or two sentences summarizing the corrections policy on this page, or empty"),
});

const FormFieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        label: z.string().describe("the visible label of the field"),
        purpose: z
          .enum(["name", "email", "subject", "passage", "body", "sources", "other"])
          .describe(
            "name: reporter's name; email: reporter's email; subject: title/headline of the request; passage: the quoted wrong text; body: explanation/details of the correction; sources: supporting links",
          ),
        required: z.boolean(),
      }),
    )
    .describe("every visible input, textarea and select in the correction form, excluding buttons"),
});

const InspectionSchema = z.object({
  passage_marked_corrected: z
    .boolean()
    .describe("true if the passage is struck through, annotated as corrected, or replaced by a correction note"),
  notices: z.array(z.string()).describe("text of every correction or editor's note on the page"),
});

const PURPOSE_TO_VALUE: Record<string, keyof CorrectionFormValues> = {
  name: "name",
  email: "email",
  subject: "subject",
  passage: "passage",
  body: "body",
  sources: "sources",
};

export class BrowserbaseOperator implements BrowserOperator {
  readonly kind = "browserbase" as const;
  private filledOnUrl: string | null = null;

  private constructor(
    private readonly browser: StagehandBrowser,
    private readonly stagehand: Stagehand,
    private readonly options: BrowserbaseOperatorOptions,
  ) {}

  static async launch(options: BrowserbaseOperatorOptions): Promise<BrowserbaseOperator> {
    const browser = await browserbase.launch({
      apiKey: options.apiKey,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      api_timeout: options.sessionTimeoutS,
    });
    try {
      const stagehand = await Stagehand.create({
        browser,
        ...(options.model ? { model: { modelName: options.model as ModelName } } : {}),
        systemPrompt:
          "You are assisting a fact-correction workflow. Never submit a form, click a submit/send button, or press Enter in a form unless the instruction explicitly says to submit.",
      });
      return new BrowserbaseOperator(browser, stagehand, options);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  replayUrl(): string | null {
    const id = this.browser.sessionId;
    return id ? `https://www.browserbase.com/sessions/${id}` : null;
  }

  private async page(): Promise<Page> {
    const page = await this.browser.context.activePage();
    if (page) return page;
    const [first] = await this.browser.context.pages();
    if (!first) throw new Error("Browserbase session has no page");
    return first;
  }

  /**
   * Stagehand pins zod 4.4 while this repo uses 4.6. At runtime Stagehand only needs parse/safeParse
   * and z.toJSONSchema, which work across 4.x; the TypeScript types do not line up, so we pass the
   * schema untyped and re-validate the result with our own copy.
   */
  private async extract<S extends z.ZodType>(instruction: string, schema: S): Promise<z.output<S>> {
    const result = await this.stagehand.extract(instruction, schema as never);
    return schema.parse(result.data);
  }

  private async visibleText(): Promise<string> {
    const page = await this.page();
    const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
    return text.replace(/\s+/g, " ").trim();
  }

  async open(url: string): Promise<PageReading> {
    const page = await this.page();
    await page.goto(url);
    await page.waitForLoadState("load");
    this.filledOnUrl = null;
    return this.readPage();
  }

  async findPassage(hints: string[]): Promise<PassageResult> {
    const data = await this.extract(
      `Find the passage on this page that mentions or relies on any of these: ${hints
        .map((hint) => `"${hint}"`)
        .join(", ")}. Copy the whole sentence or paragraph verbatim.`,
      PassageSchema,
    );
    const { found, passage } = data;
    if (!found || !passage.trim()) return { found: false, passage: null };
    // Do not trust the model's quote unless it is really on the page.
    const pageText = normalizeText(await this.visibleText());
    if (!pageText.includes(normalizeText(passage))) return { found: false, passage: null };
    return { found: true, passage: passage.trim() };
  }

  private async describeRoute(): Promise<RouteResult | null> {
    const page = await this.page();
    const data = await this.extract(
      "Does this page offer a way to report an error or request a correction to published content?",
      RouteSchema,
    );
    if (data.has_correction_form) {
      return { route_type: "form", route_url: await page.url(), policy_summary: data.policy_summary };
    }
    if (data.corrections_email.includes("@")) {
      return {
        route_type: "editorial_email",
        route_url: `mailto:${data.corrections_email.trim()}`,
        policy_summary: data.policy_summary,
      };
    }
    return null;
  }

  async locateCorrectionRoute(): Promise<RouteResult> {
    const here = await this.describeRoute();
    if (here) return here;
    for (let hop = 0; hop < 2; hop += 1) {
      const { data: candidates } = await this.stagehand.observe(
        "Find the link or button that leads to reporting an error, requesting a correction, or contacting the editors about an inaccuracy. Ignore subscribe, advertising, newsletter and login links.",
      );
      const [best] = candidates;
      if (!best) break;
      await this.stagehand.act(best);
      const page = await this.page();
      await page.waitForLoadState("load");
      const route = await this.describeRoute();
      if (route) return route;
    }
    return { route_type: "none", route_url: null, policy_summary: "No correction route found." };
  }

  async fillCorrectionForm(values: CorrectionFormValues): Promise<FillResult> {
    const data = await this.extract(
      "List the fields of the error-report or correction form on this page.",
      FormFieldsSchema,
    );
    const filled: string[] = [];
    const missing: string[] = [];
    for (const field of data.fields) {
      const key = PURPOSE_TO_VALUE[field.purpose];
      if (!key) {
        if (field.required) missing.push(field.label);
        continue;
      }
      const raw = values[key];
      const value = Array.isArray(raw) ? raw.join("\n") : raw;
      // Variables keep the long draft text out of the instruction; Stagehand substitutes it locally.
      const result = await this.stagehand.act(
        `Type %value% into the form field labeled "${field.label}". Do not submit the form.`,
        { variables: { value } },
      );
      if (result.data.success) filled.push(field.purpose);
      else if (field.required) missing.push(field.label);
    }
    this.filledOnUrl = await (await this.page()).url();
    return { filled, missing_required: missing };
  }

  async submitCorrectionForm(permit: SubmissionPermit): Promise<SubmitResult> {
    const page = await this.page();
    const formUrl = await page.url();
    if (this.filledOnUrl !== formUrl) throw new Error("no filled form on the current page");
    consumePermit(permit, formUrl, this.options.allowedOrigins);
    // Keep the browser on the permitted origin while submitting. DomainPolicy is part of the
    // Stagehand v4 BrowserContext API; failure to set it does not bypass the permit check above.
    await this.browser.context
      .setDomainPolicy({ allowedDomains: [new URL(permit.origin).hostname] })
      .catch(() => undefined);
    const result = await this.stagehand.act("Click the button that submits the correction form.");
    await page.waitForLoadState("load");
    this.filledOnUrl = null;
    const resultUrl = await page.url();
    return {
      submitted: result.data.success,
      result_url: resultUrl,
      message: result.data.message,
    };
  }

  async readPage(): Promise<PageReading> {
    const page = await this.page();
    return { url: await page.url(), text: await this.visibleText() };
  }

  async inspectCorrection(passage: string): Promise<CorrectionInspection> {
    const data = await this.extract(
      `Is this passage marked as corrected on the page, and what correction notices are shown? Passage: "${passage}"`,
      InspectionSchema,
    );
    return data;
  }

  async currentUrl(): Promise<string> {
    return (await this.page()).url();
  }

  async close(): Promise<void> {
    try {
      await this.stagehand.close();
    } finally {
      await this.browser.close();
    }
  }
}
