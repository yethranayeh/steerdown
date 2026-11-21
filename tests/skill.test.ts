import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const skillDirectory = fileURLToPath(new URL("../skills/steerdown-concepts", import.meta.url));

let workDirectory: string;
let binDirectory: string;
let argsPath: string;

/** A fake npx that records its arguments, prints a line and exits with FAKE_NPX_EXIT. */
function writeFakeNpx() {
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argsPath}"
echo "fake skills output"
exit "\${FAKE_NPX_EXIT:-0}"
`;
  const path = join(binDirectory, "npx");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

async function runCli(args: Array<string>, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: workDirectory,
    env: { ...process.env, PATH: binDirectory, ...env },
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

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "steerdown-skill-"));
  binDirectory = join(workDirectory, "bin");
  mkdirSync(binDirectory);
  argsPath = join(workDirectory, "npx-args.txt");
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("steerdown skill install", () => {
  test("runs the skills CLI on the bundled skill folder in project scope", async () => {
    writeFakeNpx();
    const result = await runCli(["skill", "install"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake skills output");
    const args = readFileSync(argsPath, "utf8").trimEnd().split("\n");
    expect(args).toEqual(["--yes", "skills", "add", skillDirectory, "-y"]);
    expect(existsSync(join(skillDirectory, "SKILL.md"))).toBe(true);
  });

  test("passes the skills CLI's exit code through", async () => {
    writeFakeNpx();
    const result = await runCli(["skill", "install"], { FAKE_NPX_EXIT: "3" });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("fake skills output");
  });

  test("reports a missing npx", async () => {
    const result = await runCli(["skill", "install"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npx");
  });

  test.each([[["skill"]], [["skill", "remove"]], [["skill", "install", "extra"]]])(
    "rejects %p as a usage error",
    async (args) => {
      writeFakeNpx();
      const result = await runCli(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("steerdown --help");
      expect(existsSync(argsPath)).toBe(false);
    },
  );
});
