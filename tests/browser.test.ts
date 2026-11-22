import type { PageFile } from "../src/emit.ts";
import type { BrowserRange, PageSentence } from "../src/browser.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { loadPage, pageFromData } from "../src/browser.ts";

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

/**
 * Two sections whose links grow out of numbered sentences. /p/#a and /p/#d share a page, and the
 * last link of `one` has no origin. Sentence 3 of `one` repeats sentence 1.
 */
function rankedFile(): PageFile {
  return {
    targets: [
      ["/p/#a", "P", "A"],
      ["/q/#b", "Q", "B"],
      ["/r/#c", "R", "C"],
      ["/p/#d", "P", "D"],
      ["/s/", "S", ""],
    ],
    sections: [
      {
        id: "doc/index.html#one",
        links: [
          [0, "detail", 0.9, 0, "h0"],
          [3, "detail", 0.85, 2, "h2"],
          [2, "prerequisite", 0.8, 2, "h2"],
          [4, "prerequisite", 0.7, 1, "h1"],
          [1, "next_step", 0.6, 1, "h1"],
          [2, "detail", 0.5],
        ],
        defaults: [0, 1, 2],
      },
      { id: "doc/index.html#two", links: [[4, "alternative", 0.95, 0, "hx"]], defaults: [0] },
    ],
  };
}

function rankedSentences(): Array<PageSentence> {
  const sentence = (anchor: string, position: number, hash: string) => ({
    anchor,
    position,
    hash,
    range: {} as BrowserRange,
  });
  return [
    sentence("one", 0, "h0"),
    sentence("one", 1, "h1"),
    sentence("one", 2, "h2"),
    sentence("one", 3, "h1"),
    sentence("two", 0, "hx"),
  ];
}

/** Weights sentences by `anchor:position`, leaving the rest at 0. */
function weights(byKey: Record<string, number>) {
  return (sentence: PageSentence) => byKey[`${sentence.anchor}:${sentence.position}`] ?? 0;
}

describe("rank", () => {
  test("gives the links of the weighted sentences, best first, each with its sentence", () => {
    const links = pageFromData(rankedFile()).rank(rankedSentences(), weights({ "one:2": 1 }));
    expect(urls(links)).toEqual(["/p/#d", "/r/#c"]);
    expect(links.map((link) => [link.sentence.anchor, link.sentence.position])).toEqual([
      ["one", 2],
      ["one", 2],
    ]);
  });

  test("scores probability times weight, across sections", () => {
    const weighted = weights({ "one:0": 0.5, "two:0": 1 });
    const links = pageFromData(rankedFile()).rank(rankedSentences(), weighted);
    expect(urls(links)).toEqual(["/s/", "/p/#a"]);
    expect(links[0]!.sentence.anchor).toBe("two");
  });

  test("keeps the variety rules of the default links", () => {
    const all = weights({ "one:0": 1, "one:1": 1, "one:2": 1 });
    const links = pageFromData(rankedFile()).rank(rankedSentences(), all);
    // The next step is kept, /p/#d shares a page with /p/#a, /s/ would be a second prerequisite.
    expect(urls(links)).toEqual(["/p/#a", "/r/#c", "/q/#b"]);
  });

  test("ties an origin to the repeated sentence nearest its stored position", () => {
    const page = pageFromData(rankedFile());
    expect(page.rank(rankedSentences(), weights({ "one:3": 1 }))).toEqual([]);
    expect(urls(page.rank(rankedSentences(), weights({ "one:1": 1 })))).toEqual(["/s/", "/q/#b"]);
  });

  test("gives nothing when no weighted sentence has a link", () => {
    const page = pageFromData(rankedFile());
    expect(page.rank(rankedSentences(), () => 0)).toEqual([]);
    expect(page.rank([], () => 1)).toEqual([]);
  });

  test("lists every judged link of a section", () => {
    const page = pageFromData(rankedFile());
    expect(page.allLinks("one")).toHaveLength(6);
    expect(page.allLinks("one")[5]!.origin).toBeUndefined();
    expect(page.allLinks("missing")).toEqual([]);
  });
});

describe("loadPage", () => {
  const globals = globalThis as unknown as { location?: { pathname: string } };
  const realFetch = globalThis.fetch;

  /** Serves the page file at the given data path only, and records every requested URL. */
  function serveAt(pathname: string, dataPath: string) {
    const requested: Array<string> = [];
    globals.location = { pathname };
    globalThis.fetch = (async (url: string) => {
      requested.push(url);
      return url === dataPath
        ? Response.json(pageFile())
        : new Response("Not found", { status: 404 });
    }) as typeof fetch;
    return requested;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globals.location;
  });

  test("finds a folder page's data for a URL without a trailing slash", async () => {
    const requested = serveAt("/guide", "/steerdown/guide/index.json");
    const page = await loadPage();
    expect(page.allLinks("start")).toHaveLength(5);
    expect(requested).toEqual(["/steerdown/guide/index.json"]);
  });

  test("falls back to a file page's data", async () => {
    const requested = serveAt("/guide", "/steerdown/guide.json");
    await loadPage();
    expect(requested).toEqual(["/steerdown/guide/index.json", "/steerdown/guide.json"]);
  });

  test("asks once for a URL with a trailing slash, and fails when no data exists", async () => {
    const requested = serveAt("/guide/", "/steerdown/other.json");
    await expect(loadPage()).rejects.toThrow("/steerdown/guide/index.json");
    expect(requested).toEqual(["/steerdown/guide/index.json"]);
  });
});
