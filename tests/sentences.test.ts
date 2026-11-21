import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSections } from "../src/sections.ts";
import { sentenceKey, splitSentences } from "../src/split.ts";

/** The sentences of the one section a page body holds. */
function sentencesOf(body: string) {
  const site = mkdtempSync(join(tmpdir(), "steerdown-sentences-"));
  try {
    writeFileSync(join(site, "page.html"), `<body>${body}</body>`);
    const [section] = readSections(site, ["page.html"]).sections;
    return splitSentences(section!.blocks);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
}

describe("splitSentences", () => {
  test("splits paragraphs into sentences, reading inline markup as text", () => {
    expect(
      sentencesOf("<p>Run <strong>the</strong> <a href='/a/'>tool</a>. Then stop.\nIt exits.</p>"),
    ).toEqual(["Run the tool.", "Then stop.", "It exits."]);
  });

  test("keeps each list item, blockquote and callout apart from the paragraph before it", () => {
    const body =
      "<p>Choose one</p><ul><li>First option\n  continues here</li><li>Second option</li></ul><blockquote><p>Quoted note</p></blockquote><aside><p>Note</p><p>Callout body.</p></aside>";
    expect(sentencesOf(body)).toEqual([
      "Choose one",
      "First option continues here",
      "Second option",
      "Quoted note",
      "Note",
      "Callout body.",
    ]);
  });

  test("leaves out code, tables and headings", () => {
    const body =
      "<p>Before.</p><pre><code>echo inside code.</code></pre><table><tr><td>a</td><td>b.</td></tr></table><h3>Sub-heading.</h3><p>After.</p>";
    expect(sentencesOf(body)).toEqual(["Before.", "After."]);
  });
});

describe("sentenceKey", () => {
  test("keeps letters and digits only, NFKC-normalized and lowercased", () => {
    expect(sentenceKey("It’s “ready” — run ﬁle 2.")).toBe("itsreadyrunfile2");
    expect(sentenceKey('It\'s "ready" - run file 2')).toBe("itsreadyrunfile2");
  });
});
