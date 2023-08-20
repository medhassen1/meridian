/**
 * Command line parsing.
 *
 * Hand written rather than delegated to a dependency, for the same reason the
 * CSV reader is: the useful behaviour here is in the error messages, and a
 * general purpose parser produces generic ones. A mistyped flag should say
 * which flag, what was expected, and what was given.
 *
 * The grammar is small and conventional. `--flag value`, `--flag=value`, and
 * `-f value` all work; `--` ends option parsing; everything else is a
 * positional argument.
 */

import { CliUsageError } from "../errors.js";

/** What a flag carries. */
export type FlagKind = "string" | "number" | "boolean";

/** One declared flag. */
export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  /** Single character alias, without the leading dash. */
  readonly short?: string;
  readonly description: string;
  /** Shown in help output when the flag is omitted. */
  readonly defaultText?: string;
  /** When true, the command fails if the flag is absent. */
  readonly required?: boolean;
}

/** The result of parsing one command line. */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | number | boolean>;
}

/**
 * Parses arguments against a set of declared flags.
 *
 * @throws {CliUsageError} on an unknown flag, a missing value, a value of the
 * wrong type, or a missing required flag.
 */
export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byShort = new Map(
    specs.filter((spec) => spec.short !== undefined).map((spec) => [spec.short as string, spec]),
  );

  const positionals: string[] = [];
  const flags = new Map<string, string | number | boolean>();
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (optionsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    const spec = name.startsWith("--")
      ? byName.get(name.slice(2))
      : byShort.get(name.slice(1));
    if (spec === undefined) {
      throw new CliUsageError(`unknown option "${name}"`, { option: name });
    }

    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) {
        flags.set(spec.name, parseBoolean(spec.name, inlineValue));
        continue;
      }
      flags.set(spec.name, true);
      continue;
    }

    const raw = inlineValue ?? argv[index + 1];
    if (raw === undefined || (inlineValue === undefined && raw.startsWith("--"))) {
      throw new CliUsageError(`option "--${spec.name}" needs a value`, { option: spec.name });
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    flags.set(spec.name, spec.kind === "number" ? parseNumber(spec.name, raw) : raw);
  }

  for (const spec of specs) {
    if (spec.required === true && !flags.has(spec.name)) {
      throw new CliUsageError(`option "--${spec.name}" is required`, { option: spec.name });
    }
  }

  return { positionals, flags };
}

/** A required string flag. */
export function requireString(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string") {
    throw new CliUsageError(`option "--${name}" is required`, { option: name });
  }
  return value;
}

/** An optional string flag. */
export function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** A numeric flag with a fallback. */
export function numberOr(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  return typeof value === "number" ? value : fallback;
}

/** A boolean flag with a fallback. */
export function booleanOr(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags.get(name);
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Renders a flag list for help output.
 *
 * Columns are aligned to the longest flag so the descriptions line up, which
 * is what makes a long option list scannable.
 */
export function renderFlagHelp(specs: readonly FlagSpec[]): string {
  if (specs.length === 0) {
    return "";
  }
  const labels = specs.map((spec) => {
    const short = spec.short === undefined ? "    " : `-${spec.short}, `;
    const value = spec.kind === "boolean" ? "" : ` <${spec.kind}>`;
    return `  ${short}--${spec.name}${value}`;
  });
  const widest = labels.reduce((longest, label) => Math.max(longest, label.length), 0);

  return specs
    .map((spec, index) => {
      const label = (labels[index] as string).padEnd(widest);
      const suffix = spec.defaultText === undefined ? "" : ` (default: ${spec.defaultText})`;
      return `${label}  ${spec.description}${suffix}`;
    })
    .join("\n");
}

function parseNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliUsageError(`option "--${name}" expects a number, got "${raw}"`, {
      option: name,
      value: raw,
    });
  }
  return value;
}

function parseBoolean(name: string, raw: string): boolean {
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }
  throw new CliUsageError(`option "--${name}" expects true or false, got "${raw}"`, {
    option: name,
    value: raw,
  });
}
