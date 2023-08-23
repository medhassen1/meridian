/**
 * The command line interface, as a library.
 *
 * Exposed so that a host application can embed the same commands without
 * shelling out, and so that tests can drive them directly.
 */

export {
  type FlagKind,
  type FlagSpec,
  type ParsedArgs,
  parseArgs,
  requireString,
  optionalString,
  numberOr,
  booleanOr,
  renderFlagHelp,
} from "./args.js";

export {
  type CommandOutput,
  type Command,
  EXIT,
  COMMANDS,
  describeCommand,
  validateCommand,
  planCommand,
  reachCommand,
  rulesCommand,
  findCommand,
  renderHelp,
  renderCommandHelp,
} from "./commands.js";

export { run, VERSION } from "./main.js";
