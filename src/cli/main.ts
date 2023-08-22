#!/usr/bin/env node
/**
 * The command line entry point.
 *
 * The only part of the CLI that touches the process: everything above it is a
 * pure function from arguments to text and an exit code, which is what makes
 * the whole surface testable without spawning anything.
 */

import { isMeridianError } from "../errors.js";
import {
  COMMANDS,
  EXIT,
  findCommand,
  renderCommandHelp,
  renderHelp,
  type CommandOutput,
} from "./commands.js";

/**
 * Runs the CLI against an argument list.
 *
 * Never throws: every failure becomes an exit code and a message, because a
 * command line tool that prints a stack trace has failed twice.
 */
export function run(argv: readonly string[]): CommandOutput {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    return { code: EXIT.ok, stdout: renderHelp(), stderr: "" };
  }
  if (name === "--version" || name === "-v") {
    return { code: EXIT.ok, stdout: VERSION, stderr: "" };
  }

  const command = findCommand(name);
  if (command === undefined) {
    return {
      code: EXIT.usage,
      stdout: "",
      stderr: `unknown command "${name}". Known commands: ${COMMANDS.map((entry) => entry.name).join(", ")}`,
    };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { code: EXIT.ok, stdout: renderCommandHelp(command), stderr: "" };
  }

  try {
    return command.run(rest);
  } catch (error) {
    if (isMeridianError(error)) {
      return {
        code: error.code === "CLI_USAGE" ? EXIT.usage : EXIT.failure,
        stdout: "",
        stderr: `${error.code}: ${error.message}`,
      };
    }
    return {
      code: EXIT.failure,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The version reported by `--version`.
 *
 * A literal rather than a read of `package.json`: the compiled entry point
 * sits in `dist/cli`, so resolving the manifest at runtime depends on the
 * layout of the published package, and getting that wrong turns a version
 * query into a crash.
 */
export const VERSION = "0.6.0";

/* c8 ignore start -- process wiring, exercised by running the binary itself */
const isDirectInvocation =
  process.argv[1] !== undefined && process.argv[1].includes("main");

if (isDirectInvocation) {
  const output = run(process.argv.slice(2));
  if (output.stdout.length > 0) {
    process.stdout.write(`${output.stdout}\n`);
  }
  if (output.stderr.length > 0) {
    process.stderr.write(`${output.stderr}\n`);
  }
  process.exitCode = output.code;
}
/* c8 ignore stop */
