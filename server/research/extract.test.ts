import { describe, expect, it } from "vitest";
import { extractDocument } from "./extract";
import { extractCaseNames, matchFabricated } from "./text";

const FAB = ["United States v. Figueroa-Florez", "United States v. Ortiz", "United States v. Amato"];

describe("case-name extraction", () => {
  it("finds case names and drops citation signals", () => {
    expect(
      extractCaseNames("See United States v. Figueroa-Florez; United States v. Ortiz; United States v. Amato."),
    ).toEqual(FAB);
  });

  it("handles questions, conjunctions and lowercase context", () => {
    expect(extractCaseNames("Has anyone pulled United States v. Ortiz, or United States v. Amato?")).toEqual([
      "United States v. Ortiz",
      "United States v. Amato",
    ]);
    expect(extractCaseNames("a brief in Mata v. Avianca cited Varghese v. China Southern Airlines.")).toEqual([
      "Mata v. Avianca",
      "Varghese v. China Southern Airlines",
    ]);
  });

  it("matches fabricated citations exactly or as recorded spelling variants", () => {
    expect(matchFabricated("united states v. figueroa–florez", FAB)).toEqual({ citation: FAB[0], variant: false });
    expect(matchFabricated("United States v. Figueroa-Flores", FAB)).toEqual({ citation: FAB[0], variant: true });
    expect(matchFabricated("United States v. Smith", FAB)).toBeNull();
  });
});

function html(head: string, body: string) {
  return `<html><head>${head}</head><body><nav><a href="/">Home</a></nav><article>${body}</article><footer><a href="https://ads.example/">ad</a></footer></body></html>`;
}

function extract(page: string, url = "https://news.example/story", searchPublished?: string) {
  return extractDocument({ url, html: page, fabricated: FAB, claimTerms: ["termination"], searchPublished, discoveredVia: "test" });
}

describe("document extraction", () => {
  it("reads publisher, timestamp source, passage, citations and article links", () => {
    const doc = extract(
      html(
        `<title>Story</title><meta property="og:site_name" content="News Example"><meta property="article:published_time" content="2023-12-13T15:00:00Z">`,
        `<p>Intro paragraph.</p><p>The motion cited United States v. Ortiz and United States v. Amato for early termination.</p><p>See the <a href="/docs/order#top">order</a> and <a href="mailto:x@y.z">email</a>.</p>`,
      ),
    );
    expect(doc.publisher).toBe("News Example");
    expect(doc.timestamp).toBe("2023-12-13T15:00:00.000Z");
    expect(doc.timestamp_source).toBe("meta");
    expect(doc.passage).toContain("United States v. Ortiz");
    expect(doc.fabricated_citations).toEqual(["United States v. Ortiz", "United States v. Amato"]);
    expect(doc.outbound_links).toEqual(["https://news.example/docs/order"]);
  });

  it.each([
    [`<script type="application/ld+json">{"@graph":[{"datePublished":"2023-12-29T21:00:00Z"}]}</script>`, "", "json-ld"],
    ["", `<time datetime="2024-01-05">Jan 5</time><p>x</p>`, "time-element"],
  ])("falls back through timestamp sources (%#)", (head, body, source) => {
    expect(extract(html(head, body)).timestamp_source).toBe(source);
  });

  it("uses a date in the URL, then the search result date, then nothing", () => {
    expect(extract(html("", "<p>x</p>"), "https://d.example/2023/12/01/story").timestamp_source).toBe("url");
    expect(extract(html("", "<p>x</p>"), "https://d.example/story", "2023-12-13").timestamp_source).toBe("search-result");
    const none = extract(html("", "<p>x</p>"));
    expect(none.timestamp).toBeNull();
    expect(none.timestamp_source).toBe("none");
  });

  it("falls back to the hostname for the publisher and ignores implausible dates", () => {
    const doc = extract(html(`<meta name="date" content="1850-01-01">`, "<p>x</p>"), "https://www.forum.example/t/1");
    expect(doc.publisher).toBe("forum.example");
    expect(doc.timestamp).toBeNull();
  });
});
