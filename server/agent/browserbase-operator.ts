import {
  browserbase,
  Stagehand,
  type ModelName,
  type Page,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";
import { z } from "zod";
import { canonicalText, checkPassage } from "./passage-integrity";
import { consumePermit, isControlledTarget, type SubmissionPermit } from "./safety";
import { classifyField, type FieldSlot } from "./semantics";
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
    .describe("true only if this page itself contains form fields for reporting an error or requesting a correction"),
  corrections_email: z.string().describe("an email address for corrections shown on the page, or empty"),
  policy_summary: z.string().describe("one or two sentences summarizing the corrections policy on this page, or empty"),
});

/**
 * Kept flat on purpose: in live runs an array of objects with an enum made the Model Gateway's
 * default model return no output. The model lists labels; semantics.classifyField maps them.
 */
const FormFieldsSchema = z.object({
  fields: z.array(
    z.object({
      label: z.string(),
      required: z.boolean(),
    }),
  ),
});

const InspectionSchema = z.object({
  passage_marked_corrected: z
    .boolean()
    .describe("true if the passage is struck through, annotated as corrected, or replaced by a correction note"),
  notices: z.array(z.string()).describe("text of every correction or editor's note on the page"),
});

const SLOT_TO_VALUE: Record<FieldSlot, keyof CorrectionFormValues> = {
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
    // Free ngrok tunnels (how the controlled target is exposed to Browserbase) show an interstitial
    // to browsers unless this header is sent. Sent only to the allowlisted controlled-target origin.
    await page.setExtraHTTPHeaders(
      isControlledTarget(url, this.options.allowedOrigins) ? { "ngrok-skip-browser-warning": "1" } : {},
    );
    await page.goto(url);
    await page.waitForLoadState("load");
    this.filledOnUrl = null;
    return this.readPage();
  }

  async findPassage(hints: string[]): Promise<PassageResult> {
    const page = await this.page();
    const urlAtExtraction = await page.url();
    const data = await this.extract(
      `Find the passage on this page that mentions or relies on any of these: ${hints
        .map((hint) => `"${hint}"`)
        .join(", ")}. Copy the whole sentence or paragraph verbatim.`,
      PassageSchema,
    );
    if (!data.found || !data.passage.trim()) {
      return { found: false, passage: null, reason: "extraction reported no matching passage" };
    }
    // Do not trust the model's quote unless it is really on the page it was taken from.
    const check = checkPassage({
      passage: data.passage,
      pageText: await this.visibleText(),
      names: hints,
      urlAtExtraction,
      urlAtCheck: await page.url(),
    });
    if (!check.ok) return { found: false, passage: null, reason: check.reason };
    return { found: true, passage: data.passage.trim(), reason: check.reason };
  }

  /** Counts visible forms that take free text. Generic DOM facts, no site-specific selectors. */
  private async textFormCount(): Promise<number> {
    const page = await this.page();
    return page.evaluate<number>(`(() => {
      const skip = ["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"];
      return Array.from(document.forms).filter((form) => {
        const fields = Array.from(form.elements).filter((el) => {
          const tag = el.tagName;
          const type = (el.getAttribute("type") || "").toLowerCase();
          const visible = el.getClientRects().length > 0;
          return visible && (tag === "TEXTAREA" || (tag === "INPUT" && !skip.includes(type)));
        });
        return fields.some((el) => el.tagName === "TEXTAREA") || fields.length >= 2;
      }).length;
    })()`);
  }

  /** Current values of every visible text field on the page. */
  private async fieldValues(): Promise<string[]> {
    const page = await this.page();
    return page.evaluate<string[]>(`(() => {
      const skip = ["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"];
      return Array.from(document.querySelectorAll("textarea, input"))
        .filter((el) => el.getClientRects().length > 0 && !skip.includes((el.getAttribute("type") || "").toLowerCase()))
        .map((el) => el.value || "");
    })()`);
  }

  private async describeRoute(): Promise<RouteResult | null> {
    const page = await this.page();
    const data = await this.extract(
      "Does this page itself contain a form for reporting an error or requesting a correction? A link to such a form does not count.",
      RouteSchema,
    );
    // The model's yes is only accepted if the page really has a free-text form.
    if (data.has_correction_form && (await this.textFormCount()) > 0) {
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
    const attempted: { purpose: string; value: string }[] = [];
    const missing: string[] = [];
    const used = new Set<FieldSlot>();
    for (const field of data.fields) {
      const slot = classifyField(field.label, null);
      if (!slot || used.has(slot)) {
        if (field.required) missing.push(field.label);
        continue;
      }
      used.add(slot);
      const raw = values[SLOT_TO_VALUE[slot]];
      const value = Array.isArray(raw) ? raw.join("\n") : raw;
      // Variables keep the long draft text out of the instruction; Stagehand substitutes it locally.
      const result = await this.stagehand.act(
        `Type %value% into the form field labeled "${field.label}". Do not submit the form.`,
        { variables: { value } },
      );
      if (result.data.success) attempted.push({ purpose: slot, value });
      else if (field.required) missing.push(field.label);
    }
    // Count a field as filled only if its value is really in the DOM now.
    const present = (await this.fieldValues()).map(canonicalText);
    const filled: string[] = [];
    for (const { purpose, value } of attempted) {
      if (present.includes(canonicalText(value))) filled.push(purpose);
      else missing.push(`${purpose} (typed but not present in the form)`);
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
