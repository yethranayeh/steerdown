#!/usr/bin/env node
import { parseArgs } from "node:util";

const helpText = `steerdown: typed reading paths for Markdown judged at build time

Usage: steerdown [options]

Options:
  -h, --help  Show this help.
`;

function usageError(message: string): number {
  process.stderr.write(`steerdown: ${message}\nRun 'steerdown --help' for usage.\n`);
  return 1;
}

function run(args: string[]): number {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({
      args,
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    }));
  } catch (error) {
    return usageError((error as Error).message);
  }

  const [command] = positionals;
  if (command !== undefined) {
    return usageError(`unknown command '${command}'`);
  }

  process.stdout.write(helpText);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
