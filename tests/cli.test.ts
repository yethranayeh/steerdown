import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(...args: string[]) {
	const result = Bun.spawnSync(["bun", cliPath, ...args]);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("steerdown", () => {
	test.each([[[]], [["--help"]], [["-h"]]])("prints help for %p", (args) => {
		const result = runCli(...args);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("steerdown");
		expect(result.stdout).toContain("--help");
		expect(result.stderr).toBe("");
	});

	test.each([[["--bogus"]], [["bogus"]]])("rejects %p on stderr", (args) => {
		const result = runCli(...args);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(args[0]!);
		expect(result.stderr).toContain("steerdown --help");
	});
});
