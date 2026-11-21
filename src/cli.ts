#!/usr/bin/env node
import type { BuildOptions, BuildReport } from "./build.ts";
import type { JevClient } from "./jev.ts";

import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { build, BuildError, defaultMaxPairs } from "./build.ts";
import { conceptInput, proposeConcepts } from "./concepts.ts";
import { ReportedError } from "./errors.ts";
import { officialEndpoint } from "./jev.ts";
import { installSkill } from "./skill.ts";

const defaultOutPath = "steerdown.graph.json";

const helpText = `steerdown: typed reading paths for Markdown judged at build time

Usage: steerdown <command> [options]

Commands:
  build <dir>               Split the Markdown under <dir> into sections, judge how
                            sections on different pages relate, and write the graph
                            file. With a steerdown.concepts.json next to the graph
                            file, also score every section against its concepts.
  concepts input            Print what an agent needs to propose concepts, as JSON.
  concepts propose <file>   Check the concepts proposed in <file>, a JSON array, and
                            add them to steerdown.proposals.json next to the graph
                            file. Nothing is written when one has a problem.
  skill install             Install the steerdown-concepts agent skill into this
                            project with the skills CLI (npx --yes skills add).

Build options:
  --out <file>       Graph file to write. Pairs and scores whose text is unchanged
                     since it was last written are reused.
                     Default: ${defaultOutPath}
  --html <dir>       The built site. Sections whose heading has no matching id
                     in its HTML are skipped.
  --exclude <path>   Leave out a Markdown file or folder, relative to <dir>.
                     Repeat for more.
  --scope <path>     Mark a Markdown file or folder, relative to <dir>, as
                     covering its own product. Sections in two different scopes
                     are suggested to each other only as alternatives.
                     Repeat for more.
  --max-pairs <n>    Stop before judging more than <n> new pairs.
                     Default: ${defaultMaxPairs}

Concepts options:
  --graph <file>     Graph file to read. Default: ${defaultOutPath}

Environment:
  TYPESAFE_API_KEY   Jev API key, needed when pairs need judging or sections
                     need scoring.
  JEV_URL            System One endpoint. Default: ${officialEndpoint}

Options:
  -h, --help  Show this help.
`;

/** The command line itself is wrong. Printed with a pointer to the help. */
class UsageError extends ReportedError {}

/** The options each command takes, besides --help. */
const commandOptions: Record<string, Array<string>> = {
  build: ["out", "html", "exclude", "scope", "max-pairs"],
  concepts: ["graph"],
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
  html?: string;
  exclude?: Array<string>;
  scope?: Array<string>;
  "max-pairs"?: string;
};

/** Reads `--max-pairs`, a whole number that defaults to the build's own limit. */
function parseMaxPairs(value: string | undefined) {
  const maxPairs = value === undefined ? defaultMaxPairs : Number(value);
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0) {
    throw new UsageError(`--max-pairs must be a whole number, got '${value}'`);
  }
  return maxPairs;
}

/** Checks the build command's arguments and turns them and the environment into build options. */
function buildOptions(positionals: Array<string>, values: BuildValues): BuildOptions {
  const [directory, ...extra] = positionals;
  if (directory === undefined) {
    throw new UsageError("build needs a directory of Markdown files");
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument '${extra[0]}'`);
  }
  if (!isDirectory(directory)) {
    throw new BuildError(`'${directory}' is not a directory`);
  }
  if (values.html !== undefined && !isDirectory(values.html)) {
    throw new BuildError(`'${values.html}' is not a directory`);
  }
  const maxPairs = parseMaxPairs(values["max-pairs"]);

  return {
    directory,
    outPath: values.out ?? defaultOutPath,
    htmlDirectory: values.html,
    excluded: values.exclude ?? [],
    scopes: values.scope ?? [],
    maxPairs,
    client: clientFromEnvironment(),
  };
}

/** The Jev endpoint and key from the environment. An empty variable counts as unset. */
function clientFromEnvironment(): JevClient {
  return {
    endpoint: process.env.JEV_URL || officialEndpoint,
    apiKey: process.env.TYPESAFE_API_KEY || undefined,
  };
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
    `Pairs: ${formatCount(report.pairs)} (${formatCount(report.reused)} reused, ${formatCount(report.judged)} judged)`,
    ...formatScores(report),
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
