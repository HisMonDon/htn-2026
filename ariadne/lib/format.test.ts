import { describe, expect, it } from "vitest";
import { passagePreview } from "./format";

describe("passagePreview", () => {
  it("shows four sentences by default and keeps the rest available", () => {
    const preview = passagePreview("One. Two. Three. Four. Five. Six.");

    expect(preview).toEqual({ text: "One. Two. Three. Four.", truncated: true });
  });

  it("caps long unpunctuated extractions without dropping the full-text signal", () => {
    const preview = passagePreview("word ".repeat(300), 4, 120);

    expect(preview.text.length).toBeLessThanOrEqual(121);
    expect(preview.text.endsWith("…")).toBe(true);
    expect(preview.truncated).toBe(true);
  });
});
