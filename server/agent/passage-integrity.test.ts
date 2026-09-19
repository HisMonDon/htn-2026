import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { canonicalText, checkPassage, longestCommonSubstring } from "./passage-integrity";
import { normalizeText } from "./semantics";

const NAMES = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const URL_A = "https://target.example/articles/cohen-supervised-release";

/**
 * The same visible sentence the controlled target shows, but authored with hard line breaks,
 * indentation, a non-breaking space, curly quotes and an en dash where the extraction has a hyphen.
 */
const MESSY_HTML = `<article>
  <p>The motion relies on
     <em>United States v. Figueroa\u2013Florez</em>,
     United States v.\u00a0Ortiz, and
     United States v. Amato, three \u201cSecond Circuit\u201d decisions that it says granted
     early termination of supervised release in similar circumstances.</p>
</article>`;

const EXTRACTED =
  'The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, three "Second Circuit" decisions that it says granted early termination of supervised release in similar circumstances.';

function visibleText(html: string): string {
  return cheerio.load(html)("body").text();
}

function check(passage: string, pageText: string, overrides: Partial<Parameters<typeof checkPassage>[0]> = {}) {
  return checkPassage({ passage, pageText, names: NAMES, urlAtExtraction: URL_A, urlAtCheck: URL_A, ...overrides });
}

describe("canonicalText", () => {
  it("normalizes NFKC, quotes, dashes and whitespace, and keeps case", () => {
    expect(canonicalText("  \uff21\u00a0\u201cx\u201d \u2018y\u2019\u2014z\n\t w ")).toBe(`A "x" 'y'-z w`);
  });
});

describe("passage integrity", () => {
  it("accepts an equivalent passage despite line breaks, curly quotes, nbsp and dash variants", () => {
    const result = check(EXTRACTED, visibleText(MESSY_HTML));
    expect(result).toMatchObject({ ok: true, method: "exact" });
  });

  it("documents why the previous check could fail on the same page", () => {
    // The old normalizer did not unify dash variants, so an en dash on the page broke the match.
    const page = visibleText(MESSY_HTML).replace(/\s+/g, " ").trim();
    expect(normalizeText(page).includes(normalizeText(EXTRACTED))).toBe(false);
  });

  it("accepts a slightly shortened extraction when a long contiguous run and all names are on the page", () => {
    const shortened = EXTRACTED.replace(" in similar circumstances.", ".");
    const result = check(shortened, visibleText(MESSY_HTML));
    expect(result).toMatchObject({ ok: true, method: "contiguous" });
  });

  it("rejects a paraphrase even though it names the same cases", () => {
    const paraphrase =
      "Cohen's lawyers cited United States v. Figueroa-Florez, United States v. Ortiz and United States v. Amato as Second Circuit precedent for ending supervision early.";
    const result = check(paraphrase, visibleText(MESSY_HTML));
    expect(result.ok).toBe(false);
  });

  it("rejects a passage naming a case that is not on the page", () => {
    const invented = EXTRACTED.replace("United States v. Amato", "United States v. Hollister");
    const result = check(invented, visibleText(MESSY_HTML), {
      names: [...NAMES, "United States v. Hollister"],
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("Hollister");
  });

  it("rejects text that mentions none of the claim's names", () => {
    const page = "Prosecutors have not yet filed a response. The judge has not said when he will rule.";
    expect(check(page, page).ok).toBe(false);
  });

  it("rejects when the active page changed during extraction", () => {
    const result = check(EXTRACTED, visibleText(MESSY_HTML), { urlAtCheck: "https://target.example/other" });
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("active page changed");
  });

  it("rejects an interstitial page that does not contain the passage", () => {
    const interstitial = "You are about to visit: example.ngrok-free.dev. Visit Site";
    expect(check(EXTRACTED, interstitial).ok).toBe(false);
  });
});

describe("longestCommonSubstring", () => {
  it("measures the longest contiguous shared run", () => {
    expect(longestCommonSubstring("abcdef", "zzcdezz")).toBe(3);
    expect(longestCommonSubstring("", "abc")).toBe(0);
  });
});
