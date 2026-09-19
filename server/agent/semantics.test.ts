import { describe, expect, it } from "vitest";
import { seedCase } from "../test-helpers";
import { passageHints } from "./draft";
import { classifyField, routeScore } from "./semantics";

describe("route vocabulary", () => {
  it("scores correction links above everything else and ignores commercial links", () => {
    expect(routeScore("Report an error in this article")).toBeGreaterThan(0);
    expect(routeScore("Request a correction")).toBeGreaterThan(0);
    expect(routeScore("Errata")).toBeGreaterThan(0);
    expect(routeScore("Subscribe")).toBe(0);
    expect(routeScore("Advertise with us")).toBe(0);
    expect(routeScore("Newsletter")).toBe(0);
  });
});

describe("field classification", () => {
  it.each([
    ["Passage that is wrong passage", null, "passage"],
    ["Quoted text quoted_text", null, "passage"],
    ["What is wrong and what it should say details", null, "body"],
    ["Explanation explanation", null, "body"],
    ["Headline for your request headline", null, "subject"],
    ["Subject subject", null, "subject"],
    ["Contact address contact", "email", "email"],
    ["Evidence (links) evidence_links", null, "sources"],
    ["Full name fullname", "text", "name"],
  ])("%s -> %s", (descriptor, type, slot) => {
    expect(classifyField(descriptor, type)).toBe(slot);
  });
});

describe("passage hints", () => {
  it("extracts the fabricated case names from the claim", () => {
    expect(passageHints(seedCase())).toEqual([
      "United States v. Figueroa-Florez",
      "United States v. Ortiz",
      "United States v. Amato",
    ]);
  });
});
