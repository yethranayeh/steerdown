/**
 * Compiles the script and makes it executable
 */
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = join(root, "dist");

rmSync(outputDirectory, { recursive: true, force: true });

const compile = Bun.spawnSync(["bunx", "--no-install", "tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (compile.exitCode !== 0) {
  process.exit(compile.exitCode);
}

chmodSync(join(outputDirectory, "cli.js"), 0o755);
