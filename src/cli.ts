#!/usr/bin/env node
import type { BuildOptions, BuildReport } from "./build.ts";
import type { JevClient } from "./jev.ts";

import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { build, BuildError, defaultMaxPairs } from "./build.ts";
import { officialEndpoint } from "./jev.ts";

const defaultOutPath = "steerdown.graph.json";

const helpText = `steerdown: typed reading paths for Markdown judged at build time

Usage: steerdown <command> [options]

Commands:
  build <dir>  Split the Markdown under <dir> into sections, judge how sections on
               different pages relate, and write the graph file.

Build options:
  --out <file>       Graph file to write. Pairs whose text is unchanged since it
                     was last written are reused. Default: ${defaultOutPath}
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

Environment:
  TYPESAFE_API_KEY   Jev API key, needed when pairs need judging.
  JEV_URL            System One endpoint. Default: ${officialEndpoint}

Options:
  -h, --help  Show this help.
`;

/** The command line itself is wrong. Printed with a pointer to the help. */
class UsageError extends Error {}

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

/** The summary a finished build prints. */
function formatReport(report: BuildReport, outPath: string) {
  const lines = [
    `Pages: ${formatCount(report.pages)}`,
    `Sections: ${formatCount(report.sections)}`,
    `Skipped sections: ${formatCount(report.skipped.length)}`,
    ...report.skipped.map((section) => `  ${section.id}: ${section.reason}`),
    `Pairs: ${formatCount(report.pairs)} (${formatCount(report.reused)} reused, ${formatCount(report.judged)} judged)`,
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
  if (command !== "build") {
    throw new UsageError(`unknown command '${command}'`);
  }
  await runBuild(rest, values);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const isExpected = error instanceof UsageError || error instanceof BuildError;
  if (!isExpected) {
    throw error;
  }
  const helpPointer = error instanceof UsageError ? "\nRun 'steerdown --help' for usage." : "";
  process.stderr.write(`steerdown: ${error.message}${helpPointer}\n`);
  process.exitCode = 1;
}
