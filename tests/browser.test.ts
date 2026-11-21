import type { PageFile } from "../src/emit.ts";

import { describe, expect, test } from "bun:test";
import { pageFromData } from "../src/browser.ts";

/**
 * A page with one section and an intro. Target 0 and 3 share page /a/ and cover concept `cli`,
 * target 2 covers `api`. Links are stored most probable first, and the build's defaults leave out
 * the next step, as its cap on one target can.
 */
function pageFile(): PageFile {
  return {
    concepts: [
      ["cli", "Command line"],
      ["api", "Library API"],
    ],
    targets: [
      ["/a/#x", "A", "X", [[0, 3]]],
      ["/b/#y", "B", "Y"],
      ["/c/#z", "C", "Z", [[1, 2]]],
      ["/a/#w", "A", "W", [[0, 2]]],
      ["/d/", "D", ""],
    ],
    sections: [
      { id: "guide/index.html", links: [[4, "detail", 0.7]], defaults: [0] },
      {
        id: "guide/index.html#start",
        links: [
          [1, "next_step", 0.9],
          [4, "detail", 0.85, 2, "abc"],
          [2, "detail", 0.8],
          [0, "detail", 0.7],
          [3, "prerequisite", 0.65],
        ],
        defaults: [1, 2],
      },
    ],
  };
}

const urls = (links: Array<{ url: string }>) => links.map((link) => link.url);

describe("pageFromData", () => {
  test("gives the build's default links without pins", () => {
    const page = pageFromData(pageFile());
    expect(urls(page.links("start"))).toEqual(["/d/", "/c/#z"]);
    expect(urls(page.links(""))).toEqual(["/d/"]);
  });

  test("puts targets that cover a pinned concept first, under the variety rules", () => {
    const links = pageFromData(pageFile()).links("start", ["cli"]);
    // /a/#w also covers `cli` but shares a page with /a/#x. The next step is always kept.
    expect(urls(links)).toEqual(["/a/#x", "/b/#y", "/d/"]);
    expect(links.map((link) => link.relation)).toEqual(["detail", "next_step", "detail"]);
  });

  test("keeps the default links when no target covers a pinned concept", () => {
    const page = pageFromData(pageFile());
    expect(urls(page.links("start", ["unknown"]))).toEqual(["/d/", "/c/#z"]);
    expect(urls(page.links("", ["cli"]))).toEqual(["/d/"]);
  });

  test("gives each link its title, heading and origin sentence when stored", () => {
    const [first, second] = pageFromData(pageFile()).links("start");
    expect(first).toEqual({
      url: "/d/",
      pageTitle: "D",
      heading: "",
      relation: "detail",
      probability: 0.85,
      origin: { position: 2, hash: "abc" },
    });
    expect(second!.origin).toBeUndefined();
  });

  test("lists the concepts and gives no links for an unknown section", () => {
    const page = pageFromData(pageFile());
    expect(page.concepts).toEqual([
      { id: "cli", label: "Command line" },
      { id: "api", label: "Library API" },
    ]);
    expect(page.links("missing")).toEqual([]);
  });
});
