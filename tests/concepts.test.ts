import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type Graph = {
  questions: string;
  sections: Array<{ id: string; heading: string }>;
  edges: Array<unknown>;
  concepts?: Array<{ id: string; label: string; hash: string }>;
  scores?: Array<[number, number, number, number]>;
};

type ConceptInput = {
  sections: Array<{ id: string; heading: string; scores: Record<string, number> }>;
  concepts: Array<{ id: string; coveredSections: number | null }>;
  proposed: Array<{ id: string }>;
  uncovered: Array<string>;
  overBroad: Array<{ id: string; sections: number }>;
};

type FakeJev = {
  url: string;
  /** Candidates per pair request. */
  pairRequests: Array<number>;
  scoreRequests: Array<{ heading: string; concepts: Array<string>; levels: number }>;
  /** The score each concept gets per section heading. Unlisted pairs score 0. */
  scores: Record<string, Record<string, number>>;
  /** Score requests to answer before failing the rest with a server error. */
  scoreRequestsBeforeFailure: number;
  stop: () => void;
};

type Question = { type: string; criteria: unknown };

function startFakeJev(): FakeJev {
  const fake: FakeJev = {
    url: "",
    pairRequests: [],
    scoreRequests: [],
    scores: {},
    scoreRequestsBeforeFailure: Infinity,
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        state: { heading?: string; reading?: unknown; candidates?: Array<unknown> };
        questions: Record<string, Question>;
      };
      const answers: Record<string, object> = {};
      const questionIds = Object.keys(body.questions);
      if (body.state.candidates === undefined) {
        const heading = body.state.heading!;
        if (fake.scoreRequests.length >= fake.scoreRequestsBeforeFailure) {
          return new Response("{}", { status: 500 });
        }
        fake.scoreRequests.push({
          heading,
          concepts: questionIds,
          levels: (body.questions[questionIds[0]!]!.criteria as Array<string>).length,
        });
        for (const id of questionIds) {
          answers[id] = { type: "score", score: fake.scores[id]?.[heading] ?? 0, confidence: 0.9 };
        }
      } else {
        fake.pairRequests.push(body.state.candidates.length);
        for (const id of questionIds) {
          answers[id] = {
            type: "choice",
            choice: "next_step",
            probabilities: { next_step: 0.7, unrelated: 0.3 },
            confidence: 0.8,
          };
        }
      }
      return Response.json({ model: "jev-test", answers, usage: { input_tokens: 100 } });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/v1/systemone`;
  fake.stop = () => server.stop(true);
  return fake;
}

let workDirectory: string;
let jev: FakeJev;
let graphPath: string;
let conceptPath: string;
let proposalPath: string;

function writeFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path: string, value: unknown) {
  writeFile(path, JSON.stringify(value, null, 2));
}

async function runCli(args: Array<string>) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: workDirectory,
    env: {
      ...process.env,
      JEV_URL: jev.url,
      TYPESAFE_API_KEY: undefined,
      STEERDOWN_EMBEDDING_URL: undefined,
      STEERDOWN_EMBEDDING_MODEL: undefined,
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

const concepts = [
  { id: "broad", label: "Everything", definition: "Anything a section can be about." },
  { id: "narrow", label: "Alpha work", definition: "Doing the alpha task." },
  { id: "quiet", label: "Nothing here", definition: "A topic no section covers." },
];
const headings = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"];
const scoreCount = headings.length * concepts.length;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "steerdown-concepts-"));
  graphPath = join(workDirectory, "steerdown.graph.json");
  conceptPath = join(workDirectory, "steerdown.concepts.json");
  proposalPath = join(workDirectory, "steerdown.proposals.json");
  const docs = join(workDirectory, "docs");
  writeFile(join(docs, "a.md"), "## Alpha\n\nAlpha text.\n\n## Beta\n\nBeta text.\n");
  writeFile(join(docs, "b.md"), "## Gamma\n\nGamma text.\n\n## Delta\n\nDelta text.\n");
  writeFile(
    join(docs, "c.md"),
    "## Epsilon\n\nEpsilon text.\n\n## Zeta\n\nZeta text.\n\n## Eta\n\nEta text.\n",
  );
  writeJson(conceptPath, concepts);
  jev = startFakeJev();
  jev.scores = {
    broad: { Alpha: 3, Beta: 3, Gamma: 2, Delta: 2, Epsilon: 3, Zeta: 2, Eta: 1 },
    narrow: { Alpha: 3, Beta: 2 },
  };
});

afterEach(() => {
  jev.stop();
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("steerdown build with a concept file", () => {
  test("scores every section against every concept and reports over-broad concepts", async () => {
    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);

    const graph = readGraph();
    expect(graph.concepts?.map((concept) => concept.id)).toEqual(["broad", "narrow", "quiet"]);
    expect(graph.scores).toHaveLength(scoreCount);
    const alpha = graph.sections.findIndex((section) => section.heading === "Alpha");
    expect(graph.scores).toContainEqual([alpha, 1, 3, 0.9]);
    expect(jev.scoreRequests).toHaveLength(headings.length);
    expect(jev.scoreRequests.every((request) => request.levels === 4)).toBe(true);

    expect(result.stdout).toContain("broad");
    expect(result.stdout).not.toContain("narrow");
  });

  test("asks nothing again when nothing changed", async () => {
    await runCli(["build", "docs"]);
    const first = readFileSync(graphPath, "utf8");
    jev.scoreRequests.length = 0;
    jev.pairRequests.length = 0;

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(jev.scoreRequests).toHaveLength(0);
    expect(jev.pairRequests).toHaveLength(0);
    expect(readFileSync(graphPath, "utf8")).toBe(first);
  });

  test("scores again only a concept whose definition changed", async () => {
    await runCli(["build", "docs"]);
    jev.scoreRequests.length = 0;
    writeJson(conceptPath, [
      concepts[0],
      { ...concepts[1], definition: "Running alpha." },
      concepts[2],
    ]);

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(jev.scoreRequests).toHaveLength(headings.length);
    expect(jev.scoreRequests.every((request) => request.concepts.join() === "narrow")).toBe(true);
    expect(readGraph().scores).toHaveLength(scoreCount);
  });

  test("scores again only a section whose text changed", async () => {
    await runCli(["build", "docs"]);
    jev.scoreRequests.length = 0;
    writeFile(
      join(workDirectory, "docs/c.md"),
      "## Epsilon\n\nEpsilon text.\n\n## Zeta\n\nZeta text.\n\n## Eta\n\nEta text, longer now.\n",
    );

    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(jev.scoreRequests).toEqual([
      { heading: "Eta", concepts: ["broad", "narrow", "quiet"], levels: 4 },
    ]);
  });

  test("reuses the pairs of a graph file written without concepts", async () => {
    rmSync(conceptPath);
    await runCli(["build", "docs"]);
    const withoutConcepts = readGraph();
    expect(withoutConcepts.concepts).toBeUndefined();
    expect(withoutConcepts.scores).toBeUndefined();
    jev.pairRequests.length = 0;

    writeJson(conceptPath, concepts);
    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(0);
    expect(jev.pairRequests).toHaveLength(0);
    expect(jev.scoreRequests).toHaveLength(headings.length);
    expect(readGraph().edges).toEqual(withoutConcepts.edges);
  });

  test("keeps the scores made before a failed request and continues from them", async () => {
    jev.scoreRequestsBeforeFailure = 2;
    const failed = await runCli(["build", "docs"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("500");
    const partial = readGraph().scores!.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(scoreCount);

    jev.scoreRequestsBeforeFailure = Infinity;
    jev.scoreRequests.length = 0;
    jev.pairRequests.length = 0;
    const resumed = await runCli(["build", "docs"]);
    expect(resumed.exitCode).toBe(0);
    expect(jev.pairRequests).toHaveLength(0);
    const rescored = jev.scoreRequests.reduce(
      (count, request) => count + request.concepts.length,
      0,
    );
    expect(rescored).toBe(scoreCount - partial);
    expect(readGraph().scores).toHaveLength(scoreCount);
  });

  test("keeps the relation question's hash, so earlier graph files stay reusable", async () => {
    await runCli(["build", "docs"]);
    expect(readGraph().questions).toBe("56c369f12fab9a37");
  });

  test.each([
    ["is not JSON", "{", "steerdown.concepts.json"],
    ["is not an array", JSON.stringify({ broad: concepts[0] }), "steerdown.concepts.json"],
    ["repeats an id", JSON.stringify([concepts[0], concepts[0]]), "broad"],
    ["misses a field", JSON.stringify([{ id: "broad", label: "Everything" }]), "definition"],
  ])("fails before asking Jev when the concept file %s", async (_, text, named) => {
    writeFile(conceptPath, text);
    const result = await runCli(["build", "docs"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(named);
    expect(jev.pairRequests).toHaveLength(0);
    expect(jev.scoreRequests).toHaveLength(0);
    expect(existsSync(graphPath)).toBe(false);
  });
});

describe("steerdown concepts input", () => {
  test("prints sections, scores, concepts, uncovered sections and over-broad concepts", async () => {
    await runCli(["build", "docs"]);
    writeJson(proposalPath, [{ id: "eta-work", label: "Eta", definition: "Doing eta." }]);

    const result = await runCli(["concepts", "input"]);
    expect(result.exitCode).toBe(0);
    const input = JSON.parse(result.stdout) as ConceptInput;
    expect(input.sections.map((section) => section.heading).sort()).toEqual([...headings].sort());
    const scoresOf = (heading: string) =>
      input.sections.find((section) => section.heading === heading)?.scores;
    expect(scoresOf("Alpha")).toEqual({ broad: 3, narrow: 3 });
    expect(scoresOf("Eta")).toEqual({ broad: 1 });
    expect(input.concepts).toEqual([
      { ...concepts[0]!, coveredSections: 6 },
      { ...concepts[1]!, coveredSections: 2 },
      { ...concepts[2]!, coveredSections: 0 },
    ]);
    expect(input.proposed.map((concept) => concept.id)).toEqual(["eta-work"]);
    expect(input.uncovered).toEqual(["c.md#eta"]);
    expect(input.overBroad).toEqual([{ id: "broad", sections: 6 }]);
  });

  test("marks a concept changed since the build as not scored", async () => {
    await runCli(["build", "docs"]);
    writeJson(conceptPath, [{ ...concepts[0]!, definition: "Anything at all." }]);

    const result = await runCli(["concepts", "input"]);
    const input = JSON.parse(result.stdout) as ConceptInput;
    expect(input.concepts[0]?.coveredSections).toBeNull();
  });

  test("reads the graph file given with --graph", async () => {
    const site = join(workDirectory, "site");
    mkdirSync(site);
    writeJson(join(site, "steerdown.concepts.json"), concepts);
    await runCli(["build", "docs", "--out", "site/graph.json"]);

    const result = await runCli(["concepts", "input", "--graph", "site/graph.json"]);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as ConceptInput).overBroad).toHaveLength(1);
  });

  test("fails without a graph file", async () => {
    const result = await runCli(["concepts", "input"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("steerdown.graph.json");
  });
});

describe("steerdown concepts propose", () => {
  const hooks = { id: "hooks", label: "Hooks", definition: "Commands that run on changes." };
  const themes = { id: "themes", label: "Themes", definition: "Colours and fonts for the site." };

  async function propose(value: unknown) {
    const file = join(workDirectory, "proposed.json");
    writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return runCli(["concepts", "propose", "proposed.json"]);
  }

  const readProposals = () => JSON.parse(readFileSync(proposalPath, "utf8")) as Array<unknown>;

  test("adds checked proposals to the proposal file, after those already there", async () => {
    const first = await propose([hooks]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("steerdown.proposals.json");
    expect(readProposals()).toEqual([hooks]);

    const second = await propose([themes]);
    expect(second.exitCode).toBe(0);
    expect(readProposals()).toEqual([hooks, themes]);
    expect(JSON.parse(readFileSync(conceptPath, "utf8"))).toEqual(concepts);
  });

  test.each([
    ["an id that is not lowercase words", [{ ...hooks, id: "Hook_Config" }], "Hook_Config"],
    ["an id proposed twice", [hooks, { ...themes, id: "hooks" }], "hooks"],
    ["an id in the concept file", [{ ...hooks, id: "broad" }], "steerdown.concepts.json"],
    ["an id already proposed", [{ ...themes, id: "waiting" }], "steerdown.proposals.json"],
    ["a definition of two sentences", [{ ...hooks, definition: "One. Two." }], "definition"],
    ["a missing label", [{ id: "hooks", definition: "Commands." }], "label"],
    ["an empty definition", [{ ...hooks, definition: " " }], "definition"],
    ["an unknown field", [{ ...hooks, reason: "Gap." }], "reason"],
    ["no array", hooks, "array"],
    ["no JSON", "[{", "proposed.json"],
  ])("rejects %s and writes nothing", async (_, proposals, named) => {
    const waiting = { id: "waiting", label: "Waiting", definition: "Already proposed." };
    writeJson(proposalPath, [waiting]);
    const before = readFileSync(proposalPath, "utf8");

    const result = await propose(proposals);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(named);
    expect(readFileSync(proposalPath, "utf8")).toBe(before);
  });

  test("does not create the proposal file when a proposal is rejected", async () => {
    const result = await propose([{ ...hooks, id: "Bad Id" }]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(proposalPath)).toBe(false);
  });

  test("accepts a definition with an abbreviation inside one sentence", async () => {
    const result = await propose([
      { ...hooks, definition: "Commands, e.g. scripts, run on changes." },
    ]);
    expect(result.exitCode).toBe(0);
  });
});
