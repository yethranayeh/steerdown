import type { Browser, Page } from "playwright-core";
import type { PageFile } from "../src/emit.ts";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { hash } from "../src/judge.ts";
import { readSections } from "../src/sections.ts";
import { sentenceKey, splitSentences } from "../src/split.ts";

const origin = "https://steerdown.test";

const guideHtml = `<!doctype html><html><head><title>Guide</title></head><body>
<nav>Home Guide</nav>
<main data-pagefind-body>
<h1>Guide</h1>
<p>Intro text comes first. It has two sentences.</p>
<h2 id="start">Start</h2>
<p>Run <code>zinn init</code> in a <a href="/docs/">new folder</a>. Then add a task.</p>
<aside><p>Note: it’s safe to run twice.</p></aside>
<ul><li>Then add a task.</li><li>Check the <em>board</em>
  after.</li></ul>
<pre><code>zinn task create</code></pre>
<div id="wrapped"><h2>Wrapped</h2><p>Text in a wrapped section.</p></div>
</main></body></html>`;

const guideData: PageFile = {
  targets: [["/docs/#setup", "Docs", "Setup"]],
  sections: [{ id: "guide/index.html#start", links: [[0, "next_step", 0.9]], defaults: [0] }],
};

/** Each section's sentences as the build splits them, keyed by anchor. */
function buildSentences() {
  const site = mkdtempSync(join(tmpdir(), "steerdown-origin-"));
  mkdirSync(join(site, "guide"));
  writeFileSync(join(site, "guide/index.html"), guideHtml);
  const { sections } = readSections(site, ["guide/index.html"]);
  rmSync(site, { recursive: true, force: true });
  return new Map(
    sections.map((section) => [section.id.split("#")[1] ?? "", splitSentences(section.blocks)]),
  );
}

let browser: Browser;
let page: Page;
let sentences: Map<string, Array<string>>;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/browser.ts", import.meta.url))],
    target: "browser",
    format: "esm",
  });
  const script = await bundle.outputs[0]!.text();
  const files: Record<string, { body: string; contentType: string }> = {
    "/guide/": { body: guideHtml, contentType: "text/html; charset=utf-8" },
    "/steerdown.js": { body: script, contentType: "text/javascript" },
    "/steerdown/guide/index.json": {
      body: JSON.stringify(guideData),
      contentType: "application/json",
    },
  };
  sentences = buildSentences();
  browser = await chromium.launch({ channel: "chrome" });
  page = await browser.newPage();
  await page.route(`${origin}/**`, (route) => {
    const file = files[new URL(route.request().url()).pathname];
    return file === undefined ? route.fulfill({ status: 404 }) : route.fulfill(file);
  });
  await loadGuide();
});

afterAll(async () => {
  await browser?.close();
});

async function loadGuide() {
  await page.goto(`${origin}/guide/`);
  await page.addScriptTag({
    type: "module",
    content: 'import * as api from "/steerdown.js"; window.steerdown = api;',
  });
  await page.waitForFunction(() => "steerdown" in globalThis);
}

type Found = { text: string; inItem: boolean } | null;

/** Asks the page for the Range of a stored origin and returns its text, or null for none. */
function findRange(anchor: string, origin: { position: number; hash: string } | undefined) {
  return page.evaluate(
    async ({ anchor, origin }) => {
      const api = (globalThis as unknown as { steerdown: typeof import("../src/browser.ts") })
        .steerdown;
      const link = { url: "/x/", pageTitle: "X", heading: "", relation: "detail", probability: 1 };
      const range = (await api.originRange(anchor, { ...link, origin })) as unknown as
        | {
            toString: () => string;
            startContainer: { parentElement: { closest: (selector: string) => unknown } };
          }
        | undefined;
      if (range === undefined) {
        return null;
      }
      return {
        text: range.toString(),
        inItem: range.startContainer.parentElement.closest("li") !== null,
      };
    },
    { anchor, origin },
  ) as Promise<Found>;
}

function storedOrigin(anchor: string, position: number) {
  return { position, hash: hash(sentenceKey(sentences.get(anchor)![position]!)) };
}

describe("originRange", () => {
  test("covers each stored sentence of a section, across inline elements and callouts", async () => {
    const start = sentences.get("start")!;
    expect(start).toHaveLength(5);
    for (const [position, sentence] of start.entries()) {
      const found = await findRange("start", storedOrigin("start", position));
      expect(found).not.toBeNull();
      expect(sentenceKey(found!.text)).toBe(sentenceKey(sentence));
    }
  });

  test("picks the repeated sentence nearest to the stored position", async () => {
    const start = sentences.get("start")!;
    expect(start[1]).toBe(start[3]);
    expect((await findRange("start", storedOrigin("start", 1)))!.inItem).toBe(false);
    expect((await findRange("start", storedOrigin("start", 3)))!.inItem).toBe(true);
  });

  test("finds a sentence that moved away from its stored position", async () => {
    const moved = { ...storedOrigin("start", 4), position: 0 };
    const found = await findRange("start", moved);
    expect(sentenceKey(found!.text)).toBe(sentenceKey(sentences.get("start")![4]!));
  });

  test("works for a page intro and a section whose id wraps its heading", async () => {
    for (const anchor of ["", "wrapped"]) {
      const found = await findRange(anchor, storedOrigin(anchor, 0));
      expect(sentenceKey(found!.text)).toBe(sentenceKey(sentences.get(anchor)![0]!));
    }
  });

  test("gives no Range for a sentence the page no longer has or a link without an origin", async () => {
    expect(await findRange("start", { position: 0, hash: "0000000000000000" })).toBeNull();
    expect(await findRange("start", undefined)).toBeNull();
    expect(await findRange("missing", storedOrigin("start", 0))).toBeNull();
  });
});

describe("readSentences", () => {
  test("gives every sentence of the page as the build splits and hashes it", async () => {
    const found = await page.evaluate(async () => {
      const api = (globalThis as unknown as { steerdown: typeof import("../src/browser.ts") })
        .steerdown;
      const sentences = await api.readSentences();
      return sentences.map(({ anchor, position, hash, range }) => ({
        anchor,
        position,
        hash,
        text: (range as unknown as { toString: () => string }).toString(),
      }));
    });
    const expected = [...sentences].flatMap(([anchor, texts]) =>
      texts.map((text, position) => ({ anchor, position, key: sentenceKey(text) })),
    );
    expect(found.map(({ anchor, position }) => ({ anchor, position }))).toEqual(
      expected.map(({ anchor, position }) => ({ anchor, position })),
    );
    for (const [index, sentence] of found.entries()) {
      expect(sentenceKey(sentence.text)).toBe(expected[index]!.key);
      expect(sentence.hash).toBe(hash(expected[index]!.key));
    }
  });
});

describe("loadPage and pins", () => {
  test("loads the current page's emitted data file", async () => {
    const urls = await page.evaluate(async () => {
      const api = (globalThis as unknown as { steerdown: typeof import("../src/browser.ts") })
        .steerdown;
      return (await api.loadPage()).links("start").map((link) => link.url);
    });
    expect(urls).toEqual(["/docs/#setup"]);
  });

  test("keeps saved pins across a reload", async () => {
    await page.evaluate(() => {
      (
        globalThis as unknown as { steerdown: typeof import("../src/browser.ts") }
      ).steerdown.savePins(["cli"]);
    });
    await loadGuide();
    const pins = await page.evaluate(() =>
      (
        globalThis as unknown as { steerdown: typeof import("../src/browser.ts") }
      ).steerdown.readPins(),
    );
    expect(pins).toEqual(["cli"]);
  });
});
