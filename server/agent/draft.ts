import type { Case } from "../../shared/schema";

/** Distinctive token included in every draft so verification can find our correction after reopening. */
export function correctionReference(value: Case): string {
  return `LINEAGE-${value.id}`;
}

/**
 * Phrases that identify the false passage on a page: case-style names ("X v. Y") and quoted
 * strings from the claim, falling back to the claim itself.
 */
export function passageHints(value: Case): string[] {
  const claim = value.falsehood.claim;
  const hints = new Set<string>();
  for (const match of claim.matchAll(/\b(?:[A-Z][\w.'-]*\s)+v\.\s(?:[A-Z][\w.'-]*(?:\s|,|$))+/g)) {
    hints.add(match[0].replace(/[,\s]+$/, ""));
  }
  for (const match of claim.matchAll(/["“]([^"”]{6,})["”]/g)) {
    hints.add(match[1]!);
  }
  if (hints.size === 0) hints.add(claim);
  return [...hints];
}

/**
 * Builds the correction request from independent evidence only. AI-writing evidence is
 * deliberately not cited as a reason the claim is false.
 */
export function buildDraft(value: Case, passage: string): Case["correction"]["draft_fields"] {
  const evidence = value.falsehood.independent_evidence_urls.map((url) => `- ${url}`).join("\n");
  return {
    subject: `Correction request: nonexistent citations (${correctionReference(value)})`,
    body: [
      `The following passage states or relies on something that is not true:`,
      `"${passage}"`,
      ``,
      `Claim: ${value.falsehood.claim}`,
      `Why it is false: ${value.falsehood.why_false}`,
      ``,
      `Independent sources:`,
      evidence,
      ``,
      `Please correct or annotate the passage. Reference: ${correctionReference(value)}`,
    ].join("\n"),
  };
}
