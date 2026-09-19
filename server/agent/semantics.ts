/**
 * Site-independent vocabulary for recognizing correction routes and form fields. Nothing here
 * refers to a specific site's markup; it is how a reader would recognize these things.
 */

const ROUTE_POSITIVE: [RegExp, number][] = [
  [/\bcorrections?\b|\bcorrect(ing)?\b/i, 5],
  [/report (an? )?(error|mistake|inaccuracy)/i, 6],
  [/\berrat(a|um)\b/i, 5],
  [/\b(error|mistake|inaccura\w*)\b/i, 3],
  [/\bfact.?check\b/i, 2],
  [/\bcontact (the )?(editors?|newsroom)\b/i, 3],
  [/\bfeedback\b/i, 1],
];

const ROUTE_NEGATIVE = /\b(subscribe|subscription|advertis\w*|newsletter|sign ?in|log ?in|donate|careers?|privacy|cookie|terms)\b/i;

/** Score how likely a link or button leads to a correction route. 0 means "not a route". */
export function routeScore(text: string): number {
  if (ROUTE_NEGATIVE.test(text)) return 0;
  return ROUTE_POSITIVE.reduce((score, [pattern, weight]) => (pattern.test(text) ? score + weight : score), 0);
}

export type FieldSlot = "passage" | "email" | "name" | "subject" | "sources" | "body";

/** Ordered: earlier rules win, so "Passage that is wrong" is a passage field, not the body. */
const FIELD_RULES: [FieldSlot, RegExp][] = [
  ["passage", /\b(passage|quot(e|ed|ation)|excerpt|original text|text in question)\b/i],
  ["email", /\be-?mail\b|\bcontact (address|email)\b/i],
  ["sources", /\b(sources?|evidence|links?|urls?|references?|citations?)\b/i],
  ["subject", /\b(subject|headline|title|summary)\b/i],
  ["name", /\b(name)\b/i],
  ["body", /\b(details?|explanation|explain|message|description|comments?|correction|what is wrong|should say|body)\b/i],
];

export function classifyField(descriptor: string, inputType: string | null): FieldSlot | null {
  if (inputType === "email") return "email";
  for (const [slot, pattern] of FIELD_RULES) {
    if (pattern.test(descriptor)) return slot;
  }
  return null;
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
