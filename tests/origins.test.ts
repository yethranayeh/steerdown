import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../src/judge.ts";
import { sentenceKey } from "../src/split.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dimensions = 64;

type Graph = {
  sections: Array<{ id: string }>;
  edges: Array<unknown>;
  links: Array<Array<[number, string]>>;
  embeddingModel?: string;
  origins?: Array<[number, number, number, string, number]>;
};

type FakeServer = { url: string; stop: () => void };

/** A judge that calls every pair a likely next step, so every link can be shown. */
function startFakeJev(): FakeServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { questions: Record<string, unknown> };
      const answers: Record<string, object> = {};
      for (const key of Object.keys(body.questions)) {
        answers[key] = {
          choice: "next_step",
          probabilities: { next_step: 0.9, unrelated: 0.1 },
          confidence: 0.9,
        };
      }
      return Response.json({ model: "jev-test", answers, usage: { input_tokens: 10 } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1/systemone`, stop: () => server.stop(true) };
}

type FakeEmbeddings = FakeServer & {
  /** The texts of each request, and the model it asked for. */
  requests: Array<{ model: string; input: Array<string>; authorization: string | null }>;
  /** Status to answer with for each next request, before falling back to 200. */
  statuses: Array<number>;
};

/** Counts each word into one of a few buckets, so texts sharing words have similar vectors. */
function wordVector(text: string) {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    vector[Number.parseInt(hash(word).slice(0, 8), 16) % dimensions]! += 1;
  }
  return vector;
}

function startFakeEmbeddings(): FakeEmbeddings {
  const fake: FakeEmbeddings = { url: "", requests: [], statuses: [], stop: () => {} };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; input: Array<string> };
      fake.requests.push({ ...body, authorization: request.headers.get("authorization") });
      const status = fake.statuses.shift() ?? 200;
      if (status !== 200) {
        return new Response("{}", { status });
      }
      const data = body.input.map((text, index) => ({ index, embedding: wordVector(text) }));
      return Response.json({ object: "list", data });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/v1`;
  fake.stop = () => server.stop(true);
  return fake;
}

let workDirectory: string;
let graphPath: string;
let cachePath: string;
let jev: FakeServer;
let embeddings: FakeEmbeddings;

function writeFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function runBuild(env: Record<string, string | undefined> = {}, options: Array<string> = []) {
  const child = Bun.spawn(["bun", cliPath, "build", "docs", ...options], {
    cwd: workDirectory,
    env: {
      ...process.env,
      JEV_URL: jev.url,
      TYPESAFE_API_KEY: undefined,
      STEERDOWN_EMBEDDING_URL: embeddings.url,
      STEERDOWN_EMBEDDING_MODEL: "embed-test",
      STEERDOWN_EMBEDDING_KEY: undefined,
      ...env,
    },
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
const embeddedTexts = () => embeddings.requests.flatMap((request) => request.input);

const setupSentences = ["Install the tool first.", "Then pick the palette colours for the theme."];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "steerdown-origins-"));
  graphPath = join(workDirectory, "steerdown.graph.json");
  cachePath = join(workDirectory, "steerdown.embeddings.json");
  writeFile(
    join(workDirectory, "docs/setup.html"),
    `<h2 id="setup">Setup</h2><p>${setupSentences.join(" ")}</p><pre><code>palette colours theme</code></pre>`,
  );
  writeFile(
    join(workDirectory, "docs/palette.html"),
    '<h2 id="palette">Palette</h2><p>The palette lists the colours of the theme.</p>',
  );
  jev = startFakeJev();
  embeddings = startFakeEmbeddings();
});

afterEach(() => {
  jev.stop();
  embeddings.stop();
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("origin sentences", () => {
  test("picks the source sentence nearest to each link's target", async () => {
    const result = await runBuild();
    expect(result.exitCode).toBe(0);

    const graph = readGraph();
    const ids = graph.sections.map((section) => section.id);
    const setup = ids.indexOf("setup.html#setup");
    const palette = ids.indexOf("palette.html#palette");
    expect(graph.embeddingModel).toBe("embed-test");
    expect(graph.origins).toHaveLength(2);

    const fromSetup = graph.origins!.find(([from, to]) => from === setup && to === palette)!;
    const [, , sentence, sentenceHash, similarity] = fromSetup;
    expect(sentence).toBe(1);
    expect(sentenceHash).toBe(hash(sentenceKey(setupSentences[1]!)));
    expect(similarity).toBeGreaterThan(0);
    expect(embeddedTexts()).not.toContain("palette colours theme");
    expect(embeddings.requests.every((request) => request.authorization === null)).toBe(true);
  });

  test("embeds only text the cache lacks, and everything again for another model", async () => {
    expect((await runBuild()).exitCode).toBe(0);
    const firstRun = embeddedTexts().length;
    expect(existsSync(cachePath)).toBe(true);

    embeddings.requests = [];
    expect((await runBuild()).exitCode).toBe(0);
    expect(embeddings.requests).toEqual([]);

    writeFile(
      join(workDirectory, "docs/palette.html"),
      '<h2 id="palette">Palette</h2><p>The palette lists the colours of the theme. It is new.</p>',
    );
    expect((await runBuild()).exitCode).toBe(0);
    expect(embeddings.requests.length).toBeGreaterThan(0);
    expect(embeddedTexts()).not.toContain(setupSentences[0]);

    embeddings.requests = [];
    const otherModel = await runBuild({ STEERDOWN_EMBEDDING_MODEL: "embed-other" });
    expect(otherModel.exitCode).toBe(0);
    expect(embeddings.requests.every((request) => request.model === "embed-other")).toBe(true);
    expect(embeddedTexts().length).toBeGreaterThanOrEqual(firstRun);
    expect(readGraph().embeddingModel).toBe("embed-other");
  });

  test("sends the key when one is set", async () => {
    const result = await runBuild({ STEERDOWN_EMBEDDING_KEY: "secret" });
    expect(result.exitCode).toBe(0);
    expect(embeddings.requests[0]?.authorization).toBe("Bearer secret");
  });

  test("writes no origins without an embedding endpoint", async () => {
    const result = await runBuild({
      STEERDOWN_EMBEDDING_URL: undefined,
      STEERDOWN_EMBEDDING_MODEL: undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STEERDOWN_EMBEDDING_URL");
    expect(readGraph().origins).toBeUndefined();
    expect(existsSync(cachePath)).toBe(false);
  });

  test("refuses a URL without a model before judging", async () => {
    const result = await runBuild({ STEERDOWN_EMBEDDING_MODEL: undefined });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("STEERDOWN_EMBEDDING_MODEL");
    expect(existsSync(graphPath)).toBe(false);
  });

  test("keeps the judged pairs when embedding fails, and finishes on the next run", async () => {
    embeddings.statuses = [500];
    const failed = await runBuild();
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("500");
    const graph = readGraph();
    expect(graph.edges).toHaveLength(2);
    expect(graph.origins).toBeUndefined();

    const rerun = await runBuild();
    expect(rerun.exitCode).toBe(0);
    expect(readGraph().origins).toHaveLength(2);
  });

  test("leaves links whose nearest sentence is below --min-similarity without one", async () => {
    expect((await runBuild()).exitCode).toBe(0);
    const similarities = readGraph().origins!.map(([, , , , similarity]) => similarity);
    const between = (Math.min(...similarities) + Math.max(...similarities)) / 2;

    const result = await runBuild({}, ["--min-similarity", String(between)]);
    expect(result.exitCode).toBe(0);
    const kept = readGraph().origins!;
    expect(kept).toHaveLength(similarities.filter((similarity) => similarity >= between).length);
    expect(kept.length).toBeLessThan(similarities.length);
    expect(result.stdout).toContain("--min-similarity");
  });

  test("refuses a --min-similarity outside -1 to 1", async () => {
    for (const value of ["1.5", "high", ""]) {
      const result = await runBuild({}, ["--min-similarity", value]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--min-similarity");
    }
    expect(existsSync(graphPath)).toBe(false);
  });
});
