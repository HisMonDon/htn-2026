import { canonicalText } from "../agent/passage-integrity";

export { canonicalText };

/** Lowercased canonical form used for matching. */
export function matchKey(value: string): string {
  return canonicalText(value).toLowerCase();
}

export function tokens(value: string): string[] {
  return matchKey(value)
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);
}

export function shingles(value: string, size: number): Set<string> {
  const words = tokens(value);
  const out = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) out.add(words.slice(index, index + size).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const PARTY_WORD = /^(?:[A-Z][\w'&.-]*|of|the|de|la|&)$/;
const CAPITAL = /^[A-Z]/;

function party(words: string[]): string {
  // Trim connector words from either end.
  while (words.length && !CAPITAL.test(words[0]!)) words.shift();
  while (words.length && !CAPITAL.test(words[words.length - 1]!)) words.pop();
  return words.join(" ").replace(/[,;:.)?!]+$/, "");
}

/**
 * Case names of the form "A v. B" found in text. Deterministic token walk: up to four capitalized
 * words before " v. " and up to five after, stopping at punctuation.
 */
export function extractCaseNames(text: string): string[] {
  const clean = canonicalText(text);
  const found = new Set<string>();
  const pattern = /\sv\.\s/g;
  for (const match of clean.matchAll(pattern)) {
    const index = match.index!;
    const before = clean.slice(Math.max(0, index - 80), index).split(" ");
    const left: string[] = [];
    for (let i = before.length - 1; i >= 0 && left.length < 4; i -= 1) {
      const word = before[i]!;
      if (!word || /[,;:.]$/.test(word) || !PARTY_WORD.test(word)) break;
      left.unshift(word);
    }
    const after = clean.slice(index + match[0].length, index + match[0].length + 100).split(" ");
    const right: string[] = [];
    for (const word of after) {
      if (right.length >= 5) break;
      const bare = word.replace(/[,;:.)?!]+$/, "");
      if (!bare || !PARTY_WORD.test(bare)) break;
      right.push(bare);
      if (bare !== word) break;
    }
    // Citation signals and sentence openers are not part of a party name.
    while (left.length && /^(?:See|Cf|In|Also|Compare|Accord|But|Citing|Under|Per|From|And|The)$/.test(left[0]!)) {
      left.shift();
    }
    const a = party(left);
    const b = party(right);
    if (a && b) found.add(`${a} v. ${b}`);
  }
  return [...found];
}

/** Canonical identity of a case name: case-insensitive, dash and whitespace normalized. */
export function caseKey(name: string): string {
  return matchKey(name).replace(/\s*-\s*/g, "-");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[b.length]!;
}

/**
 * Match a case name to one of the known fabricated citations. Exact canonical match, or the same
 * first party and a second party within two edits (a spelling variant, which is itself recorded).
 */
export function matchFabricated(name: string, fabricated: string[]): { citation: string; variant: boolean } | null {
  const key = caseKey(name);
  for (const citation of fabricated) {
    const target = caseKey(citation);
    if (key === target) return { citation, variant: false };
    const [a1, b1] = key.split(" v. ");
    const [a2, b2] = target.split(" v. ");
    if (a1 && b1 && a2 && b2 && a1 === a2 && b2.length >= 5 && levenshtein(b1, b2) <= 2) {
      return { citation, variant: true };
    }
  }
  return null;
}
