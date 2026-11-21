#!/usr/bin/env node
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
  --max-pairs <n>    Stop before judging more than <n> new pairs.
                     Default: ${defaultMaxPairs}

Environment:
  TYPESAFE_API_KEY   Jev API key, needed when pairs need judging.
  JEV_URL            System One endpoint. Default: ${officialEndpoint}

Options:
  -h, --help  Show this help.
`;

function usageError(message: string): number {
  process.stderr.write(`steerdown: ${message}\nRun 'steerdown --help' for usage.\n`);
  return 1;
}

function failure(message: string): number {
  process.stderr.write(`steerdown: ${message}\n`);
  return 1;
}

const formatCount = (value: number) => value.toLocaleString("en-US");

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory();

type BuildValues = { out?: string; html?: string; exclude?: string[]; "max-pairs"?: string };

async function runBuild(positionals: string[], values: BuildValues): Promise<number> {
  const [directory, ...extra] = positionals;
  if (directory === undefined) {
    return usageError("build needs a directory of Markdown files");
  }

  if (extra.length > 0) {
    return usageError(`unexpected argument '${extra[0]}'`);
  }

  if (!isDirectory(directory)) {
    return failure(`'${directory}' is not a directory`);
  }

  if (values.html !== undefined && !isDirectory(values.html)) {
    return failure(`'${values.html}' is not a directory`);
  }

  const maxPairs =
    values["max-pairs"] === undefined ? defaultMaxPairs : Number(values["max-pairs"]);
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0) {
    return usageError(`--max-pairs must be a whole number, got '${values["max-pairs"]}'`);
  }

  const outPath = values.out ?? defaultOutPath;

  try {
    const report = await build({
      directory,
      outPath,
      htmlDirectory: values.html,
      excluded: values.exclude ?? [],
      maxPairs,
      client: {
        endpoint: process.env.JEV_URL || officialEndpoint,
        apiKey: process.env.TYPESAFE_API_KEY || undefined,
      },
    });
    const lines = [
      `Pages: ${formatCount(report.pages)}`,
      `Sections: ${formatCount(report.sections)}`,
      `Skipped sections: ${formatCount(report.skipped.length)}`,
      ...report.skipped.map((section) => `  ${section.id}: ${section.reason}`),
      `Pairs: ${formatCount(report.pairs)} (${formatCount(report.reused)} reused, ${formatCount(report.judged)} judged)`,
      `Requests: ${formatCount(report.requests)}, input tokens: ${formatCount(report.inputTokens)}`,
      `Wrote ${outPath}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    if (error instanceof BuildError) {
      return failure(error.message);
    }
    throw error;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      out: { type: "string" },
      html: { type: "string" },
      exclude: { type: "string", multiple: true },
      "max-pairs": { type: "string" },
    },
    allowPositionals: true,
  });
}

async function run(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    return usageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || command === undefined) {
    process.stdout.write(helpText);
    return 0;
  }
  if (command === "build") {
    return runBuild(rest, values);
  }
  return usageError(`unknown command '${command}'`);
}

process.exitCode = await run(process.argv.slice(2));
