import type { Graph } from "../src/graph.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataFilePath, emit, pageUrl } from "../src/emit.ts";
import { relations } from "../src/graph.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let workDirectory: string;
let site: string;
let graphPath: string;

function writeFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Probabilities in the order of `relations`, with all of `probability` on one relation. */
function probabilities(relation: string, probability: number) {
  return relations.map((name) => (name === relation ? probability : (1 - probability) / 4));
}

function section(id: string, pageTitle: string, heading: string) {
  return { id, page: id.split("#")[0]!, pageTitle, heading, hash: id };
}

/** A graph over a home page, a guide, a setup page and a page the site no longer builds. */
function fixtureGraph(): Graph {
  return {
    version: 1,
    model: "jev-test",
    questions: "q",
    relations,
    sections: [
      section("index.md", "Home", ""),
      section("guide.md#first-run", "Guide", "First run"),
      section("guide.md#settings", "Guide", "Settings"),
      section("setup.md#install", "Setup", "Install"),
      section("setup.md#removed", "Setup", "Removed"),
      section("notes.md#later", "Notes", "Later"),
    ],
    skipped: [],
    edges: [
      [1, 0, "detail", probabilities("detail", 0.7), 0.8],
      [1, 3, "next_step", probabilities("next_step", 0.8), 0.9],
      [1, 4, "detail", probabilities("detail", 0.9), 0.9],
      [1, 5, "prerequisite", probabilities("prerequisite", 0.65), 0.9],
      [2, 0, "detail", probabilities("detail", 0.5), 0.6],
      [2, 3, "unrelated", probabilities("unrelated", 0.9), 0.9],
      [3, 1, "prerequisite", probabilities("prerequisite", 0.7), 0.9],
    ],
    links: [
      [],
      [
        [0, "detail"],
        [3, "next_step"],
      ],
      [],
      [[1, "prerequisite"]],
      [],
      [],
    ],
    scoreQuestion: "s",
    concepts: [
      { id: "setup", label: "Setup", hash: "h1" },
      { id: "themes", label: "Themes", hash: "h2" },
      { id: "colours", label: "Colours", hash: "h3" },
    ],
    scores: [
      [1, 0, 1, 0.9],
      [1, 1, 3, 0.9],
      [2, 2, 2, 0.8],
      [3, 0, 2.5, 0.8],
      [0, 2, 0, 0.9],
    ],
    embeddingModel: "embed-test",
    origins: [[1, 3, 2, "a1b2c3", 0.8]],
  };
}

function writeGraphFile(graph: Graph) {
  writeFileSync(graphPath, JSON.stringify(graph));
}

function readDataFile(path: string) {
  return JSON.parse(readFileSync(join(site, "steerdown", path), "utf8"));
}

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "steerdown-emit-"));
  site = join(workDirectory, "site");
  graphPath = join(workDirectory, "steerdown.graph.json");
  writeFile(join(site, "index.html"), "<h1>Home</h1>");
  writeFile(
    join(site, "guide/index.html"),
    '<h2 id="first-run">First run</h2><h2 id="settings">Settings</h2>',
  );
  writeFile(join(site, "setup.html"), '<h2 id="install">Install</h2>');
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("page URLs", () => {
  test.each([
    ["index.html", "/", "steerdown/index.json"],
    ["guide/index.html", "/guide/", "steerdown/guide/index.json"],
    ["setup.html", "/setup.html", "steerdown/setup.json"],
    ["docs/cli/index.html", "/docs/cli/", "steerdown/docs/cli/index.json"],
  ])("%s is served at %s with its data in %s", (htmlFile, url, dataFile) => {
    expect(pageUrl(htmlFile)).toBe(url);
    expect(dataFilePath(htmlFile)).toBe(dataFile);
  });
});

describe("emit", () => {
  test("writes one file per built page and leaves out a page with no HTML", () => {
    writeGraphFile(fixtureGraph());
    const report = emit({ graphPath, htmlDirectory: site });

    expect(report.written).toBe(3);
    expect(report.leftOut.map((page) => page.page)).toEqual(["notes.md"]);
    expect(existsSync(join(site, "steerdown/index.json"))).toBe(true);
    expect(existsSync(join(site, "steerdown/guide/index.json"))).toBe(true);
    expect(existsSync(join(site, "steerdown/setup.json"))).toBe(true);
    expect(existsSync(join(site, "steerdown/notes.json"))).toBe(false);
  });

  test("holds a page's sections, showable links, defaults, targets and covered scores", () => {
    writeGraphFile(fixtureGraph());
    const report = emit({ graphPath, htmlDirectory: site });

    expect(readDataFile("guide/index.json")).toEqual({
      sections: [
        {
          id: "guide.md#first-run",
          links: [
            [0, "next_step", 0.8, 2, "a1b2c3"],
            [1, "detail", 0.7],
          ],
          defaults: [1, 0],
          scores: [[1, 3]],
        },
        { id: "guide.md#settings", links: [], defaults: [], scores: [[2, 2]] },
      ],
      targets: [
        ["/setup.html#install", "Setup", "Install", [[0, 2.5]]],
        ["/", "Home", "", []],
      ],
      concepts: [
        ["setup", "Setup"],
        ["themes", "Themes"],
        ["colours", "Colours"],
      ],
    });
    expect(report.linksWithoutId).toBe(1);
    expect(report.linksWithoutPage).toBe(1);
    expect(readDataFile("setup.json").targets[0][0]).toBe("/guide/#first-run");
  });

  test("leaves out concepts and scores when the graph has none", () => {
    writeGraphFile({
      ...fixtureGraph(),
      scoreQuestion: undefined,
      concepts: undefined,
      scores: undefined,
    });
    emit({ graphPath, htmlDirectory: site });

    const file = readDataFile("guide/index.json");
    expect(file.concepts).toBeUndefined();
    expect(file.sections[0].scores).toBeUndefined();
    expect(file.targets[0]).toEqual(["/setup.html#install", "Setup", "Install"]);
  });

  test("links sections in two scopes only as alternatives", () => {
    writeGraphFile({ ...fixtureGraph(), scopes: ["guide.md", "setup.md"] });
    emit({ graphPath, htmlDirectory: site });

    const file = readDataFile("guide/index.json");
    expect(file.sections[0].links).toEqual([[0, "detail", 0.7]]);
    expect(file.targets.map((target: Array<unknown>) => target[0])).toEqual(["/"]);
  });
});

describe("steerdown emit", () => {
  function runCli(...args: Array<string>) {
    const result = Bun.spawnSync(["bun", cliPath, ...args], { cwd: workDirectory });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("writes the page files and reports them", () => {
    writeGraphFile(fixtureGraph());
    const result = runCli("emit", "--html", "site");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("notes.md");
    expect(existsSync(join(site, "steerdown/guide/index.json"))).toBe(true);
  });

  test("reads the graph file named by --graph", () => {
    writeFileSync(join(workDirectory, "other.json"), JSON.stringify(fixtureGraph()));
    const result = runCli("emit", "--html", "site", "--graph", "other.json");

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(site, "steerdown/setup.json"))).toBe(true);
  });

  test.each([[["emit"]], [["emit", "extra", "--html", "site"]], [["emit", "--out", "x"]]])(
    "rejects %p as a usage error",
    (args) => {
      writeGraphFile(fixtureGraph());
      const result = runCli(...args);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("steerdown --help");
      expect(existsSync(join(site, "steerdown"))).toBe(false);
    },
  );

  test.each([
    [["emit", "--html", "missing"], "missing"],
    [["emit", "--html", "site", "--graph", "none.json"], "none.json"],
  ])("rejects %p", (args, named) => {
    writeGraphFile(fixtureGraph());
    const result = runCli(...args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(named);
    expect(existsSync(join(site, "steerdown"))).toBe(false);
  });
});
