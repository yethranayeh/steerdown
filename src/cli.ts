#!/usr/bin/env node
import type { BuildOptions, BuildReport } from "./build.ts";
import type { EmbeddingClient } from "./embeddings.ts";
import type { EmitReport } from "./emit.ts";
import type { JevClient } from "./jev.ts";

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build, BuildError, defaultMaxPairs } from "./build.ts";
import { conceptInput, proposeConcepts } from "./concepts.ts";
import { emit } from "./emit.ts";
import { emitFolder } from "./urls.ts";
import { ReportedError } from "./errors.ts";
import { officialEndpoint } from "./jev.ts";
import { installSkill } from "./skill.ts";

const defaultOutPath = "steerdown.graph.json";

const helpText = `steerdown: typed reading paths for built HTML judged at build time

Usage: steerdown <command> [options]

Commands:
  build <dir>               Split the HTML pages of the built site at <dir> into
                            sections, judge how sections on different pages relate,
                            and write the graph file. With a steerdown.concepts.json
                            next to the graph file, also score every section against
                            its concepts.
                            With an embedding endpoint, also find the sentence
                            each suggested link grows out of.
  concepts input            Print what an agent needs to propose concepts, as JSON.
  concepts propose <file>   Check the concepts proposed in <file>, a JSON array, and
                            add them to steerdown.proposals.json next to the graph
                            file. Nothing is written when one has a problem.
  emit --html <dir>         Write one file per page into the built site at <dir>,
                            under ${emitFolder}/, holding the suggested links a
                            page's browser script shows. Reads the graph file and
                            makes no requests.
  skill install             Install the steerdown-concepts agent skill into this
                            project with the skills CLI (npx --yes skills add).

Build options:
  --out <file>       Graph file to write. Pairs and scores whose text is unchanged
                     since it was last written are reused.
                     Default: ${defaultOutPath}
  --exclude <path>   Leave out an HTML file or folder, relative to <dir>.
                     Repeat for more.
  --scope <path>     Mark an HTML file or folder, relative to <dir>, as
                     covering its own product. Sections in two different scopes
                     are suggested to each other only as alternatives.
                     Repeat for more.
  --max-pairs <n>    Stop before judging more than <n> new pairs.
                     Default: ${defaultMaxPairs}
  --min-similarity <n>
                     Give a link no origin sentence when its nearest sentence
                     has a cosine similarity below <n>, from -1 to 1. Scales
                     differ between embedding models. Default: no minimum.

Concepts and emit options:
  --graph <file>     Graph file to read. Default: ${defaultOutPath}

Environment:
  TYPESAFE_API_KEY   Jev API key, needed when pairs need judging or sections
                     need scoring.
  JEV_URL            System One endpoint. Default: ${officialEndpoint}
  STEERDOWN_EMBEDDING_URL
                     Base URL of an OpenAI-compatible embeddings endpoint, such
                     as https://api.openai.com/v1. Vectors are cached in
                     steerdown.embeddings.json next to the graph file. Leave
                     the cache out of version control.
  STEERDOWN_EMBEDDING_MODEL
                     Embedding model to ask. Needed with the URL.
  STEERDOWN_EMBEDDING_KEY
                     API key for the embeddings endpoint, if it needs one.

Options:
  -h, --help  Show this help.
`;

/** The command line itself is wrong. Printed with a pointer to the help. */
class UsageError extends ReportedError {}

/** The options each command takes, besides --help. */
const commandOptions: Record<string, Array<string>> = {
  build: ["out", "exclude", "scope", "max-pairs", "min-similarity"],
  concepts: ["graph"],
  emit: ["html", "graph"],
  skill: [],
};

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory();
}

type BuildValues = {
  out?: string;
  exclude?: Array<string>;
  scope?: Array<string>;
  "max-pairs"?: string;
  "min-similarity"?: string;
};

/** Reads `--max-pairs`, a whole number that defaults to the build's own limit. */
function parseMaxPairs(value: string | undefined) {
  const maxPairs = value === undefined ? defaultMaxPairs : Number(value);
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0) {
    throw new UsageError(`--max-pairs must be a whole number, got '${value}'`);
  }
  return maxPairs;
}

/** Reads `--min-similarity`, a cosine similarity from -1 to 1, or undefined when not given. */
function parseMinSimilarity(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const minSimilarity = Number(value);
  const isCosine = value.trim() !== "" && Math.abs(minSimilarity) <= 1;
  if (!isCosine) {
    throw new UsageError(`--min-similarity must be a number from -1 to 1, got '${value}'`);
  }
  return minSimilarity;
}

/** Checks the build command's arguments and turns them and the environment into build options. */
function buildOptions(positionals: Array<string>, values: BuildValues): BuildOptions {
  const [directory, ...extra] = positionals;
  if (directory === undefined) {
    throw new UsageError("build needs the directory of a built site");
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument '${extra[0]}'`);
  }
  if (!isDirectory(directory)) {
    throw new BuildError(`'${directory}' is not a directory`);
  }
  const maxPairs = parseMaxPairs(values["max-pairs"]);
  const minSimilarity = parseMinSimilarity(values["min-similarity"]);

  return {
    directory,
    outPath: values.out ?? defaultOutPath,
    excluded: values.exclude ?? [],
    scopes: values.scope ?? [],
    maxPairs,
    client: clientFromEnvironment(),
    embedding: embeddingFromEnvironment(),
    minSimilarity,
  };
}

/** The Jev endpoint and key from the environment. An empty variable counts as unset. */
function clientFromEnvironment(): JevClient {
  return {
    endpoint: process.env.JEV_URL || officialEndpoint,
    apiKey: process.env.TYPESAFE_API_KEY || undefined,
  };
}

/** The embeddings endpoint from the environment, or undefined when neither URL nor model is set. */
function embeddingFromEnvironment(): EmbeddingClient | undefined {
  const url = process.env.STEERDOWN_EMBEDDING_URL || undefined;
  const model = process.env.STEERDOWN_EMBEDDING_MODEL || undefined;
  if (url === undefined && model === undefined) {
    return undefined;
  }
  if (url === undefined || model === undefined) {
    const missing = url === undefined ? "STEERDOWN_EMBEDDING_URL" : "STEERDOWN_EMBEDDING_MODEL";
    throw new BuildError(
      `${missing} is not set. Set both the embedding URL and model, or neither.`,
    );
  }
  return { url, model, apiKey: process.env.STEERDOWN_EMBEDDING_KEY || undefined };
}

/** The origin sentence line of a build's summary. */
function formatOrigins(report: BuildReport) {
  const { origins } = report;
  if (origins === undefined) {
    return "Origin sentences: none. Set STEERDOWN_EMBEDDING_URL and STEERDOWN_EMBEDDING_MODEL to find them.";
  }
  const below =
    origins.belowMinimum > 0 ? `, ${formatCount(origins.belowMinimum)} below --min-similarity` : "";
  return `Origin sentences: ${formatCount(origins.links)} links${below} (${formatCount(origins.embedded)} texts embedded in ${formatCount(origins.requests)} requests)`;
}

/** The score lines of a build's summary, empty when it read no concept file. */
function formatScores(report: BuildReport) {
  const { scores } = report;
  if (scores === undefined) {
    return [];
  }
  return [
    `Scores: ${formatCount(scores.total)} (${formatCount(scores.reused)} reused, ${formatCount(scores.scored)} scored)`,
    `Over-broad concepts: ${formatCount(scores.overBroad.length)}`,
    ...scores.overBroad.map(
      (concept) =>
        `  ${concept.id}: covers ${formatCount(concept.sections)} of ${formatCount(report.sections)} sections`,
    ),
  ];
}

/** The summary a finished build prints. */
function formatReport(report: BuildReport, outPath: string) {
  const lines = [
    `Pages: ${formatCount(report.pages)}`,
    `Sections: ${formatCount(report.sections)}`,
    `Skipped sections: ${formatCount(report.skipped.length)}`,
    ...report.skipped.map((section) => `  ${section.id}: ${section.reason}`),
    `Headings without an id, kept in the section before: ${formatCount(report.idlessHeadings.length)}`,
    ...report.idlessHeadings.map(({ page, heading }) => `  ${page}: ${heading}`),
    `Pairs: ${formatCount(report.pairs)} (${formatCount(report.reused)} reused, ${formatCount(report.judged)} judged)`,
    ...formatScores(report),
    formatOrigins(report),
    `Requests: ${formatCount(report.requests)}, input tokens: ${formatCount(report.inputTokens)}`,
    `Wrote ${outPath}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function runBuild(positionals: Array<string>, values: BuildValues) {
  const options = buildOptions(positionals, values);
  const report = await build(options);
  process.stdout.write(formatReport(report, options.outPath));
}

/** The summary a finished emit prints. */
function formatEmitReport(report: EmitReport, htmlDirectory: string) {
  const lines = [
    `Pages written: ${formatCount(report.written)}`,
    `Pages left out: ${formatCount(report.leftOut.length)}`,
    ...report.leftOut.map((page) => `  ${page.page}: ${page.reason}`),
    `Links dropped: ${formatCount(report.linksWithoutPage)} to a page with no built HTML, ${formatCount(report.linksWithoutId)} to a heading with no matching id`,
    `Wrote ${formatCount(report.bytes)} bytes to ${join(htmlDirectory, emitFolder)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function runEmit(positionals: Array<string>, values: { html?: string; graph?: string }) {
  rejectExtraArguments(positionals);
  const htmlDirectory = values.html;

  if (htmlDirectory === undefined) {
    throw new UsageError("emit needs --html, the built site");
  }

  if (!isDirectory(htmlDirectory)) {
    throw new BuildError(`'${htmlDirectory}' is not a directory`);
  }

  const report = emit({ graphPath: values.graph ?? defaultOutPath, htmlDirectory });
  process.stdout.write(formatEmitReport(report, htmlDirectory));
}

function rejectExtraArguments(extra: Array<string>) {
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument '${extra[0]}'`);
  }
}

function runConcepts(positionals: Array<string>, graph: string | undefined) {
  const [action, ...args] = positionals;
  const graphPath = graph ?? defaultOutPath;
  if (action === "input") {
    rejectExtraArguments(args);
    process.stdout.write(`${JSON.stringify(conceptInput(graphPath), null, 2)}\n`);
    return;
  }
  if (action === "propose") {
    const [file, ...extra] = args;
    if (file === undefined) {
      throw new UsageError("concepts propose needs a file of proposed concepts");
    }
    rejectExtraArguments(extra);
    const { added, proposalPath } = proposeConcepts(graphPath, file);
    process.stdout.write(`Added ${formatCount(added)} proposed concepts to ${proposalPath}\n`);
    return;
  }
  throw new UsageError(
    action === undefined
      ? "concepts needs input or propose"
      : `unknown command 'concepts ${action}'`,
  );
}

async function runSkill(positionals: Array<string>) {
  const [action, ...extra] = positionals;
  if (action !== "install") {
    throw new UsageError(
      action === undefined ? "skill needs install" : `unknown command 'skill ${action}'`,
    );
  }
  rejectExtraArguments(extra);
  await installSkill();
}

/** Rejects options the command does not take. */
function checkOptions(command: string, values: Record<string, unknown>) {
  const allowed = commandOptions[command]!;
  for (const name of Object.keys(values)) {
    if (name !== "help" && !allowed.includes(name)) {
      throw new UsageError(`${command} does not take --${name}`);
    }
  }
}

function parse(args: Array<string>) {
  try {
    return parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        out: { type: "string" },
        html: { type: "string" },
        exclude: { type: "string", multiple: true },
        scope: { type: "string", multiple: true },
        "max-pairs": { type: "string" },
        "min-similarity": { type: "string" },
        graph: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function run(args: Array<string>) {
  const { values, positionals } = parse(args);
  const [command, ...rest] = positionals;

  if (values.help || command === undefined) {
    process.stdout.write(helpText);
    return;
  }
  if (commandOptions[command] === undefined) {
    throw new UsageError(`unknown command '${command}'`);
  }
  checkOptions(command, values);
  if (command === "build") {
    await runBuild(rest, values);
  } else if (command === "concepts") {
    runConcepts(rest, values.graph);
  } else if (command === "emit") {
    runEmit(rest, values);
  } else {
    await runSkill(rest);
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ReportedError)) {
    throw error;
  }
  const helpPointer = error instanceof UsageError ? "\nRun 'steerdown --help' for usage." : "";
  process.stderr.write(`steerdown: ${error.message}${helpPointer}\n`);
  process.exitCode = error.exitCode;
}
