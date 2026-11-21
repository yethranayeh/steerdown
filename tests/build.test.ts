import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const relations = ["prerequisite", "next_step", "detail", "alternative", "unrelated"];

type Graph = {
  version: number;
  relations: Array<string>;
  sections: Array<{ id: string; hash: string }>;
  skipped: Array<{ id: string; reason: string }>;
  edges: Array<[number, number, string, Array<number>, number]>;
  links: Array<Array<[number, string]>>;
};

type FakeJev = {
  url: string;
  requests: Array<{
    authorization: string | null;
    candidates: number;
    reading: string;
    candidateHeadings: Array<string>;
  }>;
  /** Status to answer with for each next request, before falling back to 200. */
  statuses: Array<number>;
  stop: () => void;
};

function startFakeJev(): FakeJev {
  const fake: FakeJev = { url: "", requests: [], statuses: [], stop: () => {} };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      type Judged = { heading: string };
      const body = (await request.json()) as {
        state: { reading: Judged; candidates: Array<Judged> };
        questions: Record<string, unknown>;
      };
      fake.requests.push({
        authorization: request.headers.get("authorization"),
        candidates: body.state.candidates.length,
        reading: body.state.reading.heading,
        candidateHeadings: body.state.candidates.map((candidate) => candidate.heading),
      });
      const status = fake.statuses.shift() ?? 200;
      if (status !== 200) {
        return new Response("{}", { status, headers: { "retry-after": "0" } });
      }
      const answers: Record<string, object> = {};
      for (const key of Object.keys(body.questions)) {
        answers[key] = {
          type: "choice",
          choice: "next_step",
          probabilities: {
            prerequisite: 0.05,
            next_step: 0.7,
            detail: 0.1,
            alternative: 0.05,
            unrelated: 0.1,
          },
          confidence: 0.8,
        };
      }
      return Response.json({
        model: "jev-test",
        answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/v1/systemone`;
  fake.stop = () => server.stop(true);
  return fake;
}

let workDirectory: string;
let docs: string;
let graphPath: string;
let jev: FakeJev;

function writeFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function runCli(
  args: Array<string>,
  env: Record<string, string | undefined> = { JEV_URL: jev.url },
) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    JEV_URL: undefined,
    TYPESAFE_API_KEY: undefined,
    STEERDOWN_EMBEDDING_URL: undefined,
    STEERDOWN_EMBEDDING_MODEL: undefined,
    ...env,
  };
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: workDirectory,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const readGraph = () => JSON.parse(readFileSync(graphPath, "utf8")) as Graph;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "steerdown-build-"));
  docs = join(workDirectory, "docs");
  graphPath = join(workDirectory, "steerdown.graph.json");
  writeFile(
    join(docs, "install.html"),
    '<h1>Install</h1><p>Get it running.</p><h2 id="on-macos">On macOS</h2><p>Use the installer.</p><h2 id="on-linux">On Linux</h2><p>Use the package.</p>',
  );
  writeFile(
    join(docs, "guide/use.html"),
    '<h1>Use</h1><h2 id="first-run">First run</h2><p>Run the command.</p><h2 id="pages">Pages</h2><ul><li><a href="a.html">One</a></li><li><a href="b.html">Two</a></li><li><a href="c.html">Three</a></li></ul>',
  );
  writeFile(
    join(docs, "guide/config.html"),
    '<title>Config</title><h2 id="settings">Settings</h2><p>Set the options.</p>',
  );
  jev = startFakeJev();
});

afterEach(() => {
  jev.stop();
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("steerdown build", () => {
  test("judges every pair of sections on different pages and writes the graph", async () => {
    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const graph = readGraph();
    expect(graph.relations).toEqual(relations);
    expect(graph.sections.map((section) => section.id)).toEqual([
      "guide/config.html#settings",
      "guide/use.html#first-run",
      "install.html",
      "install.html#on-macos",
      "install.html#on-linux",
    ]);
    expect(graph.skipped).toEqual([{ id: "guide/use.html#pages", reason: expect.any(String) }]);
    expect(result.stdout).toContain("guide/use.html#pages");

    const pagesBySection = graph.sections.map((section) => section.id.split("#")[0]);
    const crossPagePairs = 5 * 4 - 3 * 2;
    expect(graph.edges).toHaveLength(crossPagePairs);
    for (const [from, to, relation, probabilities] of graph.edges) {
      expect(pagesBySection[from]).not.toBe(pagesBySection[to]);
      expect(relations).toContain(relation);
      expect(probabilities).toHaveLength(relations.length);
    }
    expect(jev.requests.reduce((count, request) => count + request.candidates, 0)).toBe(
      crossPagePairs,
    );
    expect(jev.requests.every((request) => request.authorization === null)).toBe(true);
  });

  test("writes each section's links and keeps scopes apart", async () => {
    const result = await runCli(["build", "docs", "--scope", "guide", "--scope", "install.html"]);
    expect(result.exitCode).toBe(0);

    const graph = readGraph();
    expect(graph.links).toHaveLength(graph.sections.length);
    const guideSections = [0, 1];
    expect(graph.links[0]).toEqual([[1, "next_step"]]);
    expect(graph.links[1]).toEqual([[0, "next_step"]]);
    for (const [from, links] of graph.links.entries()) {
      if (!guideSections.includes(from)) {
        expect(links).toEqual([]);
      }
    }
  });

  test("records the scopes in the graph, and none without --scope", async () => {
    await runCli(["build", "docs", "--scope", "guide", "--scope", "install.html"]);
    const scoped = JSON.parse(readFileSync(graphPath, "utf8")) as { scopes?: Array<string> };
    expect(scoped.scopes).toEqual(["guide", "install.html"]);

    await runCli(["build", "docs"]);
    const unscoped = JSON.parse(readFileSync(graphPath, "utf8")) as { scopes?: Array<string> };
    expect(unscoped.scopes ?? []).toEqual([]);
  });

  test("puts the candidates most similar in wording first", async () => {
    const similar = join(workDirectory, "similar");
    writeFile(
      join(similar, "a.html"),
      '<h2 id="colours">Colours</h2><p>Pick colours for the theme palette.</p>',
    );
    writeFile(
      join(similar, "b.html"),
      '<h2 id="fonts">Fonts</h2><p>Pick a font.</p><h2 id="palette">Palette</h2><p>The theme palette lists colours.</p><h2 id="shipping">Shipping</h2><p>Orders ship weekly.</p>',
    );

    const result = await runCli(["build", "similar"]);
    expect(result.exitCode).toBe(0);
    const colours = jev.requests.find((request) => request.reading === "Colours");
    expect(colours?.candidateHeadings[0]).toBe("Palette");
  });

  test("makes no requests when nothing changed", async () => {
    await runCli(["build", "docs"]);
    const first = readFileSync(graphPath, "utf8");
    jev.requests.length = 0;

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(jev.requests).toHaveLength(0);
    expect(readFileSync(graphPath, "utf8")).toBe(first);
  });

  test("judges again only the pairs of a changed section", async () => {
    await runCli(["build", "docs"]);
    jev.requests.length = 0;
    writeFile(
      join(docs, "guide/config.html"),
      '<title>Config</title><h2 id="settings">Settings</h2><p>Set the options, now with defaults.</p>',
    );

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    const otherPageSections = 4;
    expect(jev.requests.reduce((count, request) => count + request.candidates, 0)).toBe(
      2 * otherPageSections,
    );
    expect(readGraph().edges).toHaveLength(14);
  });

  test("reports h2 headings without an id and keeps their text in the section before", async () => {
    writeFile(
      join(docs, "install.html"),
      '<h1>Install</h1><h2 id="on-macos">On macOS</h2><p>Use the installer.</p><h2>On Linux</h2><p>Use the package.</p>',
    );

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(readGraph().sections.map((section) => section.id)).toEqual([
      "guide/config.html#settings",
      "guide/use.html#first-run",
      "install.html#on-macos",
    ]);
    expect(result.stdout).toContain("install.html: On Linux");
  });

  test("leaves out excluded files and folders", async () => {
    const result = await runCli(["build", "docs", "--exclude", "guide"]);
    expect(result.exitCode).toBe(0);
    expect(readGraph().sections.every((section) => section.id.startsWith("install.html"))).toBe(
      true,
    );
    expect(jev.requests).toHaveLength(0);
  });

  test("retries rate-limited and overloaded responses", async () => {
    jev.statuses.push(429, 529);
    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(readGraph().edges).toHaveLength(14);
  });

  test("keeps the pairs judged before a failed request and continues from them", async () => {
    jev.statuses.push(200, 500);
    const failed = await runCli(["build", "docs"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("500");
    const partial = readGraph().edges.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(14);

    jev.requests.length = 0;
    const resumed = await runCli(["build", "docs"]);
    expect(resumed.exitCode).toBe(0);
    expect(jev.requests.reduce((count, request) => count + request.candidates, 0)).toBe(
      14 - partial,
    );
    expect(readGraph().edges).toHaveLength(14);
  });

  test("stops before judging more pairs than --max-pairs", async () => {
    const result = await runCli(["build", "docs", "--max-pairs", "10"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--max-pairs");
    expect(jev.requests).toHaveLength(0);
  });

  test("needs an API key for the official endpoint", async () => {
    const result = await runCli(["build", "docs"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });

  test("sends the API key as a bearer token", async () => {
    const result = await runCli(["build", "docs"], {
      JEV_URL: jev.url,
      TYPESAFE_API_KEY: "test-key",
    });
    expect(result.exitCode).toBe(0);
    expect(jev.requests.every((request) => request.authorization === "Bearer test-key")).toBe(true);
  });

  test.each([
    [["build"]],
    [["build", "docs", "extra"]],
    [["build", "docs", "--max-pairs", "many"]],
    [["build", "docs", "--html", "docs"]],
  ])("rejects %p as a usage error", async (args) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("steerdown --help");
    expect(jev.requests).toHaveLength(0);
  });

  test("rejects a missing directory", async () => {
    const result = await runCli(["build", "missing"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing");
  });
});
