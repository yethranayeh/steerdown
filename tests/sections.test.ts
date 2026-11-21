import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { judgedState, judgedWordLimit } from "../src/judge.ts";
import { findHtmlPages, readSections } from "../src/sections.ts";

let site: string;

beforeEach(() => {
  site = mkdtempSync(join(tmpdir(), "steerdown-sections-"));
});

afterEach(() => {
  rmSync(site, { recursive: true, force: true });
});

/** Writes the pages, keyed by path, and reads the site's sections. */
function readSite(pages: Record<string, string>, excluded: Array<string> = []) {
  for (const [page, html] of Object.entries(pages)) {
    const path = join(site, page);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
  return readSections(site, findHtmlPages(site, excluded));
}

/** Reads one page, `guide/index.html`, with the given body. */
function readPage(body: string) {
  return readSite({ "guide/index.html": `<!doctype html><html><body>${body}</body></html>` });
}

const textOf = (body: string, id: string) =>
  readPage(body).sections.find((section) => section.id === id)?.text;

describe("readSections", () => {
  test("splits at h2 headings with ids and keeps deeper headings inside", () => {
    const { sections } = readPage(
      `<main><h1>Guide</h1><p>Intro text.</p>
      <h2 id="install">Install</h2><p>Run it.</p><h3 id="linux">On Linux</h3><p>Use a package.</p>
      <h2 id="use">Use</h2><p>Call it.</p></main>`,
    );
    expect(sections.map((section) => [section.id, section.pageTitle, section.heading])).toEqual([
      ["guide/index.html", "Guide", ""],
      ["guide/index.html#install", "Guide", "Install"],
      ["guide/index.html#use", "Guide", "Use"],
    ]);
    expect(sections[0]!.text).toBe("Intro text.");
    expect(sections[1]!.text).toBe("Run it.\n### On Linux\nUse a package.");
  });

  test("leaves out an empty intro", () => {
    const { sections } = readPage('<h1>Guide</h1><h2 id="only">Only</h2><p>Text.</p>');
    expect(sections.map((section) => section.id)).toEqual(["guide/index.html#only"]);
  });

  test("starts a section at a wrapper's id when it holds the h2 alone and no text before it", () => {
    const { sections } = readPage(
      `<p>Intro.</p>
      <div id="how"><h2>How it works</h2><p>Like this.</p></div>
      <div id="mixed"><p>Before.</p><h2>Mixed</h2><p>After.</p></div>
      <section id="pair"><h2>First</h2><h2>Second</h2></section>
      <section id="outer"><h2 id="own">Own id</h2><p>Own text.</p></section>`,
    );
    expect(sections.map((section) => [section.id, section.heading])).toEqual([
      ["guide/index.html", ""],
      ["guide/index.html#how", "How it works"],
      ["guide/index.html#own", "Own id"],
    ]);
    expect(sections[1]!.text).toBe("Like this.\nBefore.\nMixed\nAfter.\nFirst\nSecond");
  });

  test("keeps the text of an h2 without an id in the section before and lists it", () => {
    const { sections, idlessHeadings } = readPage(
      '<h2 id="one">One</h2><p>First.</p><h2>No id</h2><p>Second.</p>',
    );
    expect(sections.map((section) => section.id)).toEqual(["guide/index.html#one"]);
    expect(sections[0]!.text).toBe("First.\nNo id\nSecond.");
    expect(idlessHeadings).toEqual([{ page: "guide/index.html", heading: "No id" }]);
  });

  test("leaves out page chrome, controls and hidden decoration, and keeps hidden panels", () => {
    const text = textOf(
      `<h2 id="a">A</h2>
      <nav>Breadcrumb</nav><p>Kept<span aria-hidden="true"> icon</span>.</p>
      <aside data-pagefind-ignore><p>On this page</p></aside>
      <button>Copy</button><form><label>Name</label><input value="x"></form>
      <script>var x = "script";</script><style>p{}</style><svg><title>Logo</title></svg>
      <noscript>Enable scripts.</noscript><template><p>Template.</p></template>
      <div hidden><p>Tab panel.</p></div><footer>Footer</footer>`,
      "guide/index.html#a",
    );
    expect(text).toBe("Kept.\nTab panel.");
  });

  test("leaves out links to a heading's own anchor", () => {
    const { sections } = readPage(
      `<h2 id="setup"><a href="#setup">#</a>Setup</h2><a href="#setup">Section titled Setup</a>
      <p>See <a href="#later">later</a>.</p>
      <h3 id="more">More <a href="#more">¶</a></h3>`,
    );
    expect(sections[0]!.heading).toBe("Setup");
    expect(sections[0]!.text).toBe("See later.\n### More");
  });

  test("writes lists, headings, code, tables and links as structured lines", () => {
    const text = textOf(
      `<h2 id="a">A</h2>
      <p>Run <code>zinn task list</code> or read <a href="/docs/">the docs</a>.</p>
      <ul><li>First</li><li><p>Second</p><p>More.</p></li></ul>
      <h4>Deep</h4>
      <pre><code><span class="line">if (x) {</span>
<span class="line">  y();</span>
<span class="line">}</span></code></pre>
      <pre>
        <span><span aria-hidden="true">$ </span>zinn backup</span>
        <span>zinn restore</span>
      </pre>
      <table><tr><th>Option</th><th>Default</th></tr><tr><td>rows</td><td>1</td></tr></table>`,
      "guide/index.html#a",
    );
    expect(text).toBe(
      [
        "Run zinn task list or read the docs.",
        "- First",
        "- Second",
        "More.",
        "### Deep",
        "```\nif (x) {\n  y();\n}\n```",
        "```\nzinn backup\nzinn restore\n```",
        "Option | Default",
        "rows | 1",
      ].join("\n"),
    );
  });

  test("takes the first h1 as the title, then the head's title, then the path", () => {
    const { sections } = readSite({
      "a.html": "<title>Head A</title><h1>Heading A</h1><p>Text.</p>",
      "b.html": "<title>Head B</title><svg><title>Icon</title></svg><p>Text.</p>",
      "c.html": "<p>Text.</p>",
    });
    expect(sections.map((section) => section.pageTitle)).toEqual(["Heading A", "Head B", "c.html"]);
  });

  test("reads only data-pagefind-body content, leaving out pages without it", () => {
    const { sections, skipped } = readSite({
      "a.html":
        "<header><p>Site header.</p></header><main data-pagefind-body><p>Body A.</p></main>",
      "b.html": "<main><p>Body B.</p></main>",
    });
    expect(sections.map((section) => [section.id, section.text])).toEqual([["a.html", "Body A."]]);
    expect(skipped.map((section) => section.id)).toEqual(["b.html"]);
  });

  test("reads main, then body, when no page marks data-pagefind-body", () => {
    const { sections } = readSite({
      "a.html": "<header><p>Site header.</p></header><main><p>Main A.</p></main>",
      "b.html": "<p>Body B.</p>",
    });
    expect(sections.map((section) => section.text)).toEqual(["Main A.", "Body B."]);
  });

  test("reads only HTML pages, leaving out excluded files and folders", () => {
    const { sections } = readSite(
      {
        "a.html": "<p>A.</p>",
        "changelog/index.html": "<p>Log.</p>",
        "b.html": "<p>B.</p>",
        "notes.md": "Notes.",
      },
      ["changelog/", "b.html"],
    );
    expect(sections.map((section) => section.id)).toEqual(["a.html"]);
  });
});

describe("link hubs", () => {
  const hubIds = (body: string) => readPage(body).skipped.map((section) => section.id);

  test("treats a list of links as a hub", () => {
    expect(
      hubIds(
        '<h2 id="a">A</h2><ul><li><a href="/one/">One</a>: the first.</li><li><a href="/two/">Two</a></li></ul>',
      ),
    ).toEqual(["guide/index.html#a"]);
  });

  test("treats a grid of linked cards as a hub", () => {
    expect(
      hubIds(
        '<h2 id="a">A</h2><a href="/one/"><h3>One</h3><p>The first.</p></a><a href="/two/"><h3>Two</h3><p>The second.</p></a>',
      ),
    ).toEqual(["guide/index.html#a"]);
  });

  test("keeps prose that links to other pages", () => {
    expect(
      hubIds(
        '<h2 id="a">A</h2><p>Read <a href="/one/">one</a> and <a href="/two/">two</a> first.</p><p>Then <a href="/three/">three</a>.</p>',
      ),
    ).toEqual([]);
  });
});

describe("judgedState", () => {
  test("cuts the text at the word limit and keeps its line breaks", () => {
    const paragraphs = Array.from(
      { length: judgedWordLimit },
      (_, index) => `<p>w${index} more</p>`,
    );
    const { sections } = readPage(`<h2 id="a">A</h2>${paragraphs.join("")}`);
    const { text } = judgedState(sections[0]!);
    expect(text.split(/\s+/)).toHaveLength(judgedWordLimit);
    expect(text.split("\n")).toHaveLength(judgedWordLimit / 2);
  });
});
