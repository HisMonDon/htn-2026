import { createHash } from "node:crypto";

/**
 * The deliberately narrow normalization used for artifact identity. It only removes extraction
 * differences that cannot change document content: Unicode compatibility representation and
 * whitespace. Case and punctuation remain significant, so a revised filing is not folded into
 * an earlier filing merely because most of its words are unchanged.
 */
export function normalizeFingerprintText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu, " ")
    .trim();
}

/** Stable, exact-content identifier for a normalized extracted artifact. */
export function contentFingerprint(text: string): string {
  return createHash("sha256").update(normalizeFingerprintText(text), "utf8").digest("hex");
}

/** Distinguishes the artifact identity from the URL-derived graph-node ID. */
export function canonicalDocumentId(fingerprint: string): string {
  return `sha256:${fingerprint}`;
}
