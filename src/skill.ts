import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReportedError } from "./errors.ts";

/** The concept skill folder that ships with this package. */
export const skillDirectory = fileURLToPath(
  new URL("../skills/steerdown-concepts", import.meta.url),
);
/** On Windows npx is `npx.cmd`, which Node only starts through a shell. */
const needsShell = process.platform === "win32";

/** Starts npx with one argument per array item, or on Windows as one command line for the shell. */
function startNpx(args: Array<string>) {
  if (needsShell) {
    // Node warns when an argument array is combined with a shell (DEP0190), so the line is built here.
    // Windows paths cannot contain double quotes, so quoting each argument keeps spaces inside it.
    const commandLine = ["npx", ...args.map((arg) => `"${arg}"`)].join(" ");
    return spawn(commandLine, { stdio: "inherit", shell: true });
  }

  return spawn("npx", args, { stdio: "inherit" });
}

/**
 * Installs the concept skill into the current project with the skills CLI, whose output goes
 * straight to the terminal. Throws with the skills CLI's exit code when it fails.
 */
export function installSkill(): Promise<void> {
  const child = startNpx(["--yes", "skills", "add", skillDirectory, "-y"]);

  return new Promise((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ReportedError("npx was not found. skill install needs npx, which comes with npm."),
        );
      } else {
        reject(error);
      }
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else if (code === null) {
        reject(new ReportedError("the skills CLI was stopped."));
      } else {
        reject(new ReportedError(`the skills CLI exited with code ${code}.`, code));
      }
    });
  });
}
