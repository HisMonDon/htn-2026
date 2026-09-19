/**
 * Deterministic check that a passage an extraction model returned really is on the page.
 * No semantic similarity: either the text is there after canonical normalization, or a long
 * contiguous run of it is there together with every fabricated name it mentions.
 */

/** Canonical form for comparing visible text. Case is preserved. */
export function canonicalText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(/[\s\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ")
    .trim();
}

/** Length of the longest substring shared by a and b (dynamic programming, O(|a|*|b|) time, O(|b|) space). */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const char = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      if (char === b.charCodeAt(j - 1)) {
        const run = previous[j - 1]! + 1;
        current[j] = run;
        if (run > best) best = run;
      } else {
        current[j] = 0;
      }
    }
    [previous, current] = [current, previous];
  }
  return best;
}

/** A shortened extraction still needs this share of its text, contiguous, on the page... */
export const MIN_CONTIGUOUS_FRACTION = 0.6;
/** ...and at least this many characters of it. */
export const MIN_CONTIGUOUS_CHARS = 40;

export interface PassageCheckInput {
  /** The passage the extraction returned. */
  passage: string;
  /** Visible text of the page the extraction ran on. */
  pageText: string;
  /** Distinctive names that identify the false claim (e.g. fabricated case names). */
  names: string[];
  /** URL of the active page when extraction started and when the page text was read. */
  urlAtExtraction: string;
  urlAtCheck: string;
}

export type PassageCheck =
  | { ok: true; method: "exact" | "contiguous"; reason: string }
  | { ok: false; reason: string };

export function checkPassage(input: PassageCheckInput): PassageCheck {
  const passage = canonicalText(input.passage);
  const page = canonicalText(input.pageText);
  if (!passage) return { ok: false, reason: "extraction returned an empty passage" };
  if (input.urlAtExtraction !== input.urlAtCheck) {
    return { ok: false, reason: `active page changed during extraction (${input.urlAtExtraction} -> ${input.urlAtCheck})` };
  }

  const names = input.names.map(canonicalText).filter(Boolean);
  const namedInPassage = names.filter((name) => passage.includes(name));
  if (namedInPassage.length === 0) {
    return { ok: false, reason: "passage mentions none of the claim's identifying names" };
  }
  const missingOnPage = namedInPassage.filter((name) => !page.includes(name));
  if (missingOnPage.length > 0) {
    return { ok: false, reason: `names in the passage are not on the page: ${missingOnPage.join(", ")}` };
  }

  if (page.includes(passage)) return { ok: true, method: "exact", reason: "passage appears verbatim after normalization" };

  const run = longestCommonSubstring(passage, page);
  const needed = Math.max(MIN_CONTIGUOUS_CHARS, Math.ceil(passage.length * MIN_CONTIGUOUS_FRACTION));
  if (run >= needed) {
    return {
      ok: true,
      method: "contiguous",
      reason: `${run} of ${passage.length} characters appear contiguously on the page; all ${namedInPassage.length} names present`,
    };
  }
  return {
    ok: false,
    reason: `only ${run} of ${passage.length} characters appear contiguously on the page (needs ${needed})`,
  };
}
