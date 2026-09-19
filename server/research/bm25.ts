import { matchKey, tokens } from "./text";

/**
 * Small deterministic BM25 index. Used as the offline search engine over the fixture corpus and
 * as the in-memory fallback when Elastic is not configured. Quoted phrases in a query must
 * appear verbatim (after normalization) in a matching document.
 */
export class Bm25<T extends { id: string }> {
  private readonly docs = new Map<string, { item: T; terms: Map<string, number>; length: number; raw: string }>();
  private readonly docFreq = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  add(item: T, text: string): void {
    if (this.docs.has(item.id)) this.remove(item.id);
    const words = tokens(text);
    const terms = new Map<string, number>();
    for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
    for (const term of terms.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    this.docs.set(item.id, { item, terms, length: words.length, raw: matchKey(text) });
    this.totalLength += words.length;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.terms.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 1) - 1);
    this.totalLength -= doc.length;
    this.docs.delete(id);
  }

  search(query: string, limit: number, filter?: (item: T) => boolean): { item: T; score: number }[] {
    const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) => matchKey(match[1]!));
    const queryTerms = [...new Set(tokens(query.replace(/"/g, " ")))];
    const count = this.docs.size;
    const average = count ? this.totalLength / count : 0;
    const results: { item: T; score: number }[] = [];
    for (const doc of this.docs.values()) {
      if (filter && !filter(doc.item)) continue;
      if (phrases.some((phrase) => !doc.raw.includes(phrase))) continue;
      let score = 0;
      for (const term of queryTerms) {
        const frequency = doc.terms.get(term);
        if (!frequency) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
        score += (idf * frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + (this.b * doc.length) / (average || 1)));
      }
      if (score > 0) results.push({ item: doc.item, score });
    }
    return results.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, limit);
  }
}
