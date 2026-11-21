import { describe, expect, test } from "bun:test";
import { isLinkHub, renderedHeading, splitPage } from "../src/sections.ts";

const ids = (markdown: string) => splitPage("guide.md", markdown).map((section) => section.id);

describe("splitPage", () => {
  test("splits at level-two headings and keeps deeper headings inside", () => {
    const sections = splitPage(
      "guide.md",
      [
        "# Guide",
        "",
        "Intro text.",
        "",
        "## Install",
        "",
        "Run it.",
        "",
        "### On Linux",
        "",
        "Use a package.",
        "",
        "## Use",
        "",
        "Call it.",
      ].join("\n"),
    );
    expect(sections.map((section) => [section.id, section.pageTitle, section.heading])).toEqual([
      ["guide.md", "Guide", ""],
      ["guide.md#install", "Guide", "Install"],
      ["guide.md#use", "Guide", "Use"],
    ]);
    expect(sections[1]!.text).toContain("### On Linux");
    expect(sections[1]!.text).toContain("Use a package.");
    expect(sections[0]!.text).not.toContain("# Guide");
  });

  test("leaves out an empty intro", () => {
    expect(ids("# Guide\n\n## Only\n\nText.")).toEqual(["guide.md#only"]);
  });

  test("ignores headings inside fenced code", () => {
    const markdown = [
      "## Real",
      "",
      "```sh",
      "## not a heading",
      "```",
      "",
      "~~~~",
      "## also not",
      "```",
      "~~~~",
      "",
      "## Second",
    ].join("\n");
    expect(ids(markdown)).toEqual(["guide.md#real", "guide.md#second"]);
  });

  test("takes the title from front matter and skips it", () => {
    const sections = splitPage(
      "guide.md",
      ["---", 'title: "From front matter"', "---", "", "Intro.", "", "## Next"].join("\n"),
    );
    expect(sections.map((section) => [section.id, section.pageTitle])).toEqual([
      ["guide.md", "From front matter"],
      ["guide.md#next", "From front matter"],
    ]);
    expect(sections[0]!.text).toBe("Intro.");
  });

  test("numbers repeated slugs across every heading level", () => {
    const markdown = ["# Options", "", "## Options", "", "### Options", "", "## Options"].join(
      "\n",
    );
    expect(ids(markdown)).toEqual(["guide.md#options-1", "guide.md#options-3"]);
  });

  test("slugs the rendered heading text", () => {
    const markdown = [
      "## The `task list` command",
      "",
      "## [Links](other.md) and snake_case",
      "",
      "## *Emphasis* <code>tags</code>",
    ].join("\n");
    expect(ids(markdown)).toEqual([
      "guide.md#the-task-list-command",
      "guide.md#links-and-snake_case",
      "guide.md#emphasis-tags",
    ]);
  });

  test("uses the file name when the page has no title", () => {
    expect(splitPage("notes/today.md", "## One\n\nText.")[0]!.pageTitle).toBe("notes/today");
  });
});

describe("renderedHeading", () => {
  test("keeps intraword underscores", () => {
    expect(renderedHeading("Use __bold__ and snake_case_name")).toBe(
      "Use bold and snake_case_name",
    );
  });
});

describe("isLinkHub", () => {
  test("treats a list of links as a hub", () => {
    expect(isLinkHub("- [One](one.md)\n- [Two](two.md)\n- [Three](three.md)")).toBe(true);
  });

  test("keeps prose that links to other pages", () => {
    expect(
      isLinkHub("Read [one](one.md), [two](two.md) and [three](three.md) before you start."),
    ).toBe(false);
  });

  test("needs more than a couple of links", () => {
    expect(isLinkHub("- [One](one.md)\n- [Two](two.md)")).toBe(false);
  });
});
