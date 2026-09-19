import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { detectContentKind, looksLikePdfBytes } from "./content-type";
import { discover } from "./discovery";
import { contentFingerprint } from "./fingerprint";
import { extractPdfPages, MAX_PDF_BYTES, parsePdfDocument, pdfFingerprintText } from "./pdf";
import { MemoryIndex } from "./candidate-index";
import { runResearch } from "./pipeline";
import type { PageFetcher, SearchProvider } from "./providers";

const FAB = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];
const CLAIM = `A motion cited ${FAB.join(", ")}, none of which exist.`;

/** A small deterministic PDF fixture, generated at test time rather than committed as a binary. */
async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([400, 400]);
    let y = 360;
    for (const line of text.split("\n")) {
      page.drawText(line, { x: 40, y, size: 12, font });
      y -= 18;
    }
  }
  return doc.save();
}

describe("PDF content-type detection", () => {
  it("uses Content-Type even without a .pdf extension", () => {
    expect(detectContentKind({ contentType: "application/pdf", url: "https://court.example/doc/95" })).toBe("pdf");
  });

  it("does not treat a .pdf URL serving HTML as a PDF", () => {
    expect(detectContentKind({ contentType: "text/html; charset=utf-8", url: "https://court.example/motion.pdf" })).toBe(
      "html",
    );
  });

  it("falls back to the URL extension only when no Content-Type is available", () => {
    expect(detectContentKind({ url: "https://court.example/motion.pdf" })).toBe("pdf");
    expect(detectContentKind({ url: "https://court.example/motion" })).toBe("unknown");
  });

  it("recognizes PDF magic bytes when bytes are already in hand", () => {
    expect(looksLikePdfBytes(new TextEncoder().encode("%PDF-1.4\n..."))).toBe(true);
    expect(looksLikePdfBytes(new TextEncoder().encode("<html></html>"))).toBe(false);
  });
});

describe("deterministic PDF extraction", () => {
  it("extracts text from a multi-page PDF and preserves page boundaries", async () => {
    const bytes = await makePdf(["Page one content here.", "Page two content here.", "Page three content here."]);
    const result = await extractPdfPages(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page_count).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]).toEqual({ page: 1, text: "Page one content here." });
    expect(result.pages[1]).toEqual({ page: 2, text: "Page two content here." });
    expect(result.pages[2]!.page).toBe(3);
    expect(result.pages[0]!.text).not.toBe(result.pages[1]!.text);
    expect(result.text).toContain("Page one content here.");
    expect(result.text).toContain("Page two content here.");
    expect(result.text).toContain("Page three content here.");
  });

  it("accepts a Node Buffer (not just a plain Uint8Array) without the parser rejecting it", async () => {
    // Regression test: Buffer.from(...) in the Browserbase fetcher produces a Node Buffer, which
    // subclasses Uint8Array but is rejected at runtime by unpdf/pdf.js ("Please provide binary
    // data as Uint8Array, rather than Buffer."). extractPdfPages must convert it before parsing.
    const plain = await makePdf(["Buffer boundary content here.\nWell past the minimum extractable length."]);
    const buffer = Buffer.from(plain);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const result = await extractPdfPages(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0]!.text).toContain("Buffer boundary content here.");
  });

  it("rejects a PDF over the size cap without attempting to parse it", async () => {
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
    const result = await extractPdfPages(oversized);
    expect(result).toMatchObject({ ok: false, reason: "pdf-too-large" });
  });

  it("fails cleanly on bytes that are not a PDF at all", async () => {
    const result = await extractPdfPages(new TextEncoder().encode("<html><body>not a pdf</body></html>"));
    expect(result).toMatchObject({ ok: false, reason: "pdf-invalid" });
  });

  it("fails cleanly (nonfatal) on a corrupted/malformed PDF", async () => {
    const result = await extractPdfPages(new TextEncoder().encode("%PDF-1.4\nthis is not a valid PDF body"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pdf-parse-failed");
  });

  it("treats a scanned/blank PDF as no extractable text rather than empty evidence", async () => {
    const bytes = await makePdf(["", ""]);
    const result = await extractPdfPages(bytes);
    expect(result).toMatchObject({ ok: false, reason: "pdf-no-extractable-text" });
  });
});

describe("PDF document assembly", () => {
  it("does not treat generic PDF creation metadata as a publication timestamp", async () => {
    const bytes = await makePdf(["IN THE UNITED STATES DISTRICT COURT", "Motion for early termination."]);
    const extraction = await extractPdfPages(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const parsed = parsePdfDocument("https://court.example/dockets/95", extraction);
    expect(parsed.title).toBe("IN THE UNITED STATES DISTRICT COURT");
    expect(parsed.publisher).toBe("court.example");
    expect(parsed.timestamp).toBeNull();
    expect(parsed.timestamp_source).toBe("none");
    expect(parsed.timestamp_confidence).toBe("none");
  });

  it("extracts an unambiguous date from a court filing header", async () => {
    const extraction = await extractPdfPages(
      await makePdf(["Case 1:23-cv-00001 Document 88 Filed 11/29/23 Page 1 of 5\nA court filing with enough text to be parsed deterministically." ]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/docket/88", extraction);
    expect(parsed).toMatchObject({
      timestamp: "2023-11-29T00:00:00.000Z",
      timestamp_source: "court-filing-header",
      timestamp_confidence: "strong",
      timestamp_conflict: null,
    });
  });

  it("keeps a repeated docket header as one stable timestamp", async () => {
    const header = "Document 88 Filed 11/29/23 Page 1 of 5";
    const extraction = await extractPdfPages(
      await makePdf([`${header}\nOpening filing text with enough deterministic content.`, `${header}\nSecond page text with enough deterministic content.`]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/docket/88", extraction);
    expect(parsed.timestamp).toBe("2023-11-29T00:00:00.000Z");
    expect(parsed.timestamp_conflict).toBeNull();
  });

  it("records conflicting strong filing dates instead of choosing one", async () => {
    const extraction = await extractPdfPages(
      await makePdf([
        "Document 88 Filed 11/29/23 Page 1 of 5\nFirst page filing text with enough content for extraction.",
        "Document 88 Filed 12/14/23 Page 2 of 5\nSecond page filing text with enough content for extraction.",
      ]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/docket/88", extraction);
    expect(parsed.timestamp).toBeNull();
    expect(parsed.timestamp_source).toBe("none");
    expect(parsed.timestamp_conflict).toContain("court-filing-header (2023-11-29)");
    expect(parsed.timestamp_conflict).toContain("court-filing-header (2023-12-14)");
  });

  it("does not guess an ambiguous numeric court date", async () => {
    const extraction = await extractPdfPages(
      await makePdf(["Document 88 Filed 04/05/23 Page 1 of 5\nText long enough that the PDF is otherwise a valid extraction candidate."]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/docket/88", extraction);
    expect(parsed.timestamp).toBeNull();
    expect(parsed.timestamp_source).toBe("none");
  });

  it("uses a clearly labelled filing date when no docket header is present", async () => {
    const extraction = await extractPdfPages(
      await makePdf(["Filing date: November 29, 2023\nText long enough to establish a labelled document-date fallback deterministically."]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/docket/88", extraction);
    expect(parsed).toMatchObject({
      timestamp: "2023-11-29T00:00:00.000Z",
      timestamp_source: "document-publication-label",
      timestamp_confidence: "moderate",
    });
  });

  it("does not let a URL date override a court filing header", async () => {
    const extraction = await extractPdfPages(
      await makePdf(["Document 88 Filed 11/29/23 Page 1 of 5\nText long enough to prove that the filing header takes priority over the URL."]),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const parsed = parsePdfDocument("https://court.example/2024/02/10/docket/88", extraction);
    expect(parsed).toMatchObject({ timestamp: "2023-11-29T00:00:00.000Z", timestamp_source: "court-filing-header" });
  });
});

describe("PDF ingestion reaches the same pipeline as HTML", () => {
  const pdfUrl = "https://court.example/dockets/18-cr-602/doc-95-motion";
  const htmlUrl = "https://news.example/story";

  function providers(pdfBytes: Uint8Array): { search: SearchProvider; fetcher: PageFetcher } {
    const search: SearchProvider = {
      kind: "offline-corpus",
      async search() {
        return [
          { url: pdfUrl, title: "Motion", published: null },
          { url: htmlUrl, title: "Story", published: "2023-12-13" },
        ];
      },
    };
    const fetcher: PageFetcher = {
      async fetch(url: string) {
        if (url === pdfUrl) return { url, kind: "pdf", bytes: pdfBytes };
        if (url === htmlUrl) {
          return {
            url,
            kind: "html",
            html: `<html><body><article><p>The motion cited ${FAB.join(" and ")}.</p></article></body></html>`,
          };
        }
        return null;
      },
    };
    return { search, fetcher };
  }

  it("produces a candidate document from a PDF alongside one from HTML", async () => {
    const bytes = await makePdf([`Motion citing ${FAB.join(",\n")} for early termination.`]);
    const result = await discover({ claim: CLAIM }, providers(bytes));
    const pdfDoc = result.documents.find((doc) => doc.url === pdfUrl);
    const htmlDoc = result.documents.find((doc) => doc.url === htmlUrl);
    expect(pdfDoc).toBeDefined();
    expect(htmlDoc).toBeDefined();
    expect(pdfDoc!.fabricated_citations).toEqual(FAB);
    expect(pdfDoc!.passage).toContain("Motion citing");
    // Same shape either way: the provenance scorer never needs to know which extractor ran.
    expect(Object.keys(pdfDoc!).sort()).toEqual(Object.keys(htmlDoc!).sort());
  });

  it("records a nonfatal extraction failure for a broken PDF and continues the run", async () => {
    const brokenBytes = new TextEncoder().encode("%PDF-1.4\nnot actually parseable");
    const result = await discover({ claim: CLAIM }, providers(brokenBytes));
    expect(result.documents.find((doc) => doc.url === pdfUrl)).toBeUndefined();
    expect(result.documents.find((doc) => doc.url === htmlUrl)).toBeDefined();
    expect(result.extractionFailures.some((failure) => failure.includes(pdfUrl))).toBe(true);
  });
});

describe("PDF mirror detection", () => {
  const mirrorA = "https://courtlistener.example/docket/95";
  const mirrorB = "https://documentcloud.example/documents/95";
  const citationPages = ["COURT FILING", ...FAB.map((citation) => `See ${citation}.`)];

  function pdfProviders(pages: Map<string, Uint8Array>): { search: SearchProvider; fetcher: PageFetcher } {
    const search: SearchProvider = {
      kind: "offline-corpus",
      async search() {
        return [...pages.keys()].map((url) => ({ url, title: "Court filing", published: null }));
      },
    };
    const fetcher: PageFetcher = {
      async fetch(url: string) {
        const bytes = pages.get(url);
        return bytes ? { url, kind: "pdf", bytes } : null;
      },
    };
    return { search, fetcher };
  }

  it("groups the same PDF bytes fetched from two URLs before retrieval and scoring", async () => {
    const bytes = await makePdf(citationPages);
    const extraction = await extractPdfPages(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const result = await discover({ claim: CLAIM }, pdfProviders(new Map([[mirrorA, bytes], [mirrorB, bytes]])));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      url: mirrorA,
      mirror_urls: [mirrorB],
      content_fingerprint: contentFingerprint(pdfFingerprintText(extraction)),
    });

    const tree = await runResearch({ claim: CLAIM }, { ...pdfProviders(new Map([[mirrorA, bytes], [mirrorB, bytes]])), index: new MemoryIndex() });
    expect(tree.nodes).toHaveLength(1);
    expect(tree.edges).toEqual([]);
    expect(tree.root_ids).toEqual([tree.nodes[0]!.id]);
  });

  it("keeps similar but non-identical PDFs separate", async () => {
    const original = await makePdf([...citationPages, "The requested relief is granted."]);
    const revised = await makePdf([...citationPages, "The requested relief is denied."]);
    const result = await discover({ claim: CLAIM }, pdfProviders(new Map([[mirrorA, original], [mirrorB, revised]])));

    expect(result.documents).toHaveLength(2);
    expect(new Set(result.documents.map((document) => document.content_fingerprint)).size).toBe(2);
  });

  it("keeps different PDFs with the same extracted title separate", async () => {
    const first = await makePdf(["ORDER OF THE COURT", ...FAB, "First filing text."]);
    const second = await makePdf(["ORDER OF THE COURT", ...FAB, "Second filing text."]);
    const result = await discover({ claim: CLAIM }, pdfProviders(new Map([[mirrorA, first], [mirrorB, second]])));

    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((document) => document.title)).toEqual(["ORDER OF THE COURT", "ORDER OF THE COURT"]);
  });

  it("keeps identical normalized PDF text with different page boundaries separate", async () => {
    const fourPages = await makePdf(citationPages);
    const twoPages = await makePdf(["COURT FILING", citationPages.slice(1).join("\n")]);
    const result = await discover({ claim: CLAIM }, pdfProviders(new Map([[mirrorA, fourPages], [mirrorB, twoPages]])));

    expect(result.documents).toHaveLength(2);
    expect(new Set(result.documents.map((document) => document.content_fingerprint)).size).toBe(2);
  });
});
