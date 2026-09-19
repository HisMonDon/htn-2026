import type { Correction } from "../../shared/schema";
import type { SubmissionPermit } from "./safety";

export interface PassageResult {
  found: boolean;
  /** Exact text of the affected passage as it appears on the page. */
  passage: string | null;
  /** Why the passage was accepted or rejected by the integrity check. */
  reason?: string;
}

export interface RouteResult {
  route_type: Correction["route_type"];
  /** Page holding the correction form, or the mailto:/contact URL. */
  route_url: string | null;
  policy_summary: string;
}

/** Values the operator maps onto whatever fields the discovered form has. */
export interface CorrectionFormValues {
  name: string;
  email: string;
  subject: string;
  passage: string;
  body: string;
  sources: string[];
}

export interface FillResult {
  /** Semantic slots that were typed into the form, e.g. ["email", "subject", "body"]. */
  filled: string[];
  /** Labels of required fields the operator could not fill. */
  missing_required: string[];
}

export interface SubmitResult {
  submitted: boolean;
  result_url: string | null;
  message: string;
}

export interface PageReading {
  url: string;
  /** Visible text of the page. */
  text: string;
}

export interface CorrectionInspection {
  /** true if the passage is visibly marked as corrected/struck, false if it is shown unmarked, null if unknown. */
  passage_marked_corrected: boolean | null;
  /** Visible correction notices on the page. */
  notices: string[];
}

/**
 * Browser-side operations. Implementations decide *how* to find things on a page (natural-language
 * agent calls for Browserbase); orchestration and safety decisions live in the orchestrator.
 */
export interface BrowserOperator {
  readonly kind: "browserbase" | "offline-heuristic";
  /** Browserbase session replay URL, null when the operator has no recording. */
  replayUrl(): string | null;
  open(url: string): Promise<PageReading>;
  findPassage(hints: string[]): Promise<PassageResult>;
  locateCorrectionRoute(): Promise<RouteResult>;
  /** Types values into the correction form without submitting it. */
  fillCorrectionForm(values: CorrectionFormValues): Promise<FillResult>;
  /** Submits the filled form. Must refuse unless the permit is valid for the current page. */
  submitCorrectionForm(permit: SubmissionPermit): Promise<SubmitResult>;
  readPage(): Promise<PageReading>;
  inspectCorrection(passage: string): Promise<CorrectionInspection>;
  currentUrl(): Promise<string>;
  close(): Promise<void>;
}

export type OperatorFactory = () => Promise<BrowserOperator>;
