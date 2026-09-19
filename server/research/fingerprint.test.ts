import { describe, expect, it } from "vitest";
import { canonicalizeDocuments } from "./canonicalize";
import { assembleDocument } from "./extract";
import { contentFingerprint, normalizeFingerprintText } from "./fingerprint";

const FAB = ["United States v. Ortiz"];

function document(url: string, text: string, outboundLinks: string[] = []) {
  return assembleDocument(
    {
      url,
      title: "Court filing",
      publisher: new URL(url).hostname,
      timestamp: null,
      timestamp_source: "none",
      timestamp_confidence: "none",
      timestamp_conflict: null,
      text,
      outbound_links: outboundLinks,
    },
    { fabricated: FAB, claimTerms: [], discoveredVia: "test" },
  );
}

describe("exact-content document fingerprints", () => {
  it("groups harmless whitespace-only extraction differences and preserves both source URLs", () => {
    const text = "The filing cites United States v. Ortiz.\n\nThe motion remains pending.";
    const whitespaceVariant = "  The filing cites United States v. Ortiz.\u00a0 The motion remains pending.  ";
    expect(normalizeFingerprintText(whitespaceVariant)).toBe(normalizeFingerprintText(text));
    expect(contentFingerprint(whitespaceVariant)).toBe(contentFingerprint(text));

    const grouped = canonicalizeDocuments([
      document("https://documentcloud.example/filing", whitespaceVariant, ["https://source.example/order"]),
      document("https://courtlistener.example/filing", text, ["https://source.example/docket"]),
    ]).documents;

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      url: "https://courtlistener.example/filing",
      mirror_urls: ["https://documentcloud.example/filing"],
      outbound_links: ["https://source.example/docket", "https://source.example/order"],
    });
  });

  it("keeps text that differs by one non-whitespace character separate", () => {
    const original = "The court grants the motion.";
    const revised = "The court denies the motion.";
    expect(contentFingerprint(original)).not.toBe(contentFingerprint(revised));
    expect(canonicalizeDocuments([document("https://court.example/original", original), document("https://court.example/revised", revised)]).documents).toHaveLength(2);
  });
});
