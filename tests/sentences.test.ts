import { describe, expect, test } from "bun:test";
import { splitSentences } from "../src/sentences.ts";

describe("splitSentences", () => {
  test("splits paragraphs into sentences and strips inline Markdown", () => {
    expect(splitSentences("Run **the** [tool](a.md). Then stop.\nIt exits.")).toEqual([
      "Run the tool.",
      "Then stop.",
      "It exits.",
    ]);
  });

  test("keeps each list item and blockquote apart from the paragraph before it", () => {
    const markdown =
      "Choose one\n\n- First option\n  continues here\n- Second option\n\n> Quoted note";
    expect(splitSentences(markdown)).toEqual([
      "Choose one",
      "First option continues here",
      "Second option",
      "Quoted note",
    ]);
  });

  test("leaves out code, tables, headings, rules and link definitions", () => {
    const markdown = [
      "Before.",
      "```sh",
      "echo inside code.",
      "```",
      "| a | b |",
      "|---|---|",
      "### Sub-heading",
      "---",
      "[ref]: https://example.com",
      "After.",
    ].join("\n");
    expect(splitSentences(markdown)).toEqual(["Before.", "After."]);
  });
});
