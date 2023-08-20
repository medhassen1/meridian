/**
 * The commands the CLI offers.
 *
 * Each command is a pure function from parsed arguments to an exit code and a
 * pair of output strings. Nothing here writes to a stream or reads a clock,
 * which is what lets the whole surface be tested without spawning a process or
 * capturing stdout.
 */

import { ServiceDate } from "../time/date.js";
import { formatDiagnostic } from "../csv/position.js";
import { DirectoryFeedSource } from "../feed/directory.js";
import { summariseFeed, type GtfsFeed } from "../feed/feed.js";
import { loadFeed } from "../feed/loader.js";
import { buildNetwork } from "../model/builder.js";
import type { Network } from "../model/network.js";
import { computeReach } from "../isochrone/reach.js";
import { bandsOf, rasterise, renderGrid, toGeoJson } from "../isochrone/contour.js";
import { planJourney, planProfile } from "../planner.js";
import { renderDepartureBoard, renderFeedSummary, renderNetworkStatistics, renderPlan } from "../report/text.js";
import { planToJson, reachToJson } from "../report/json.js";
import { formatReport, reportToJson, validateFeed } from "../validate/report.js";
import { renderTable } from "../report/table.js";
import { VALIDATION_RULES } from "../validate/rules.js";
import {
  booleanOr,
  numberOr,
  optionalString,
  parseArgs,
  renderFlagHelp,
  requireString,
  type FlagSpec,
} from "./args.js";
import { CliUsageError } from "../errors.js";

/** What a command produced. */
export interface CommandOutput {
  /** Process exit code. */
  readonly code: number;
  /** Text for standard output. */
  readonly stdout: string;
  /** Text for standard error. */
  readonly stderr: string;
}

/** One command. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly FlagSpec[];
  run(argv: readonly string[]): CommandOutput;
}

/** Exit code meanings, part of the CLI's contract. */
export const EXIT = {
  ok: 0,
  /** The command ran but its subject failed: an invalid feed, no journey. */
  failure: 1,
  /** The command line was not understood. */
  usage: 2,
  /** The feed could not be read at all. */
  unreadable: 3,
} as const;

const FEED_FLAG: FlagSpec = {
  name: "feed",
  kind: "string",
  short: "f",
  description: "Directory containing the GTFS .txt files",
  required: true,
};

const JSON_FLAG: FlagSpec = {
  name: "json",
  kind: "boolean",
  description: "Emit JSON instead of text",
};

/** `describe` — read a feed and report what it contains. */
export const describeCommand: Command = {
  name: "describe",
  summary: "Summarise a feed and the network compiled from it",
  usage: "meridian describe --feed <directory> [--json]",
  flags: [FEED_FLAG, JSON_FLAG],
  run(argv) {
    const args = parseArgs(argv, this.flags);
    const loaded = openNetwork(requireString(args, "feed"));
    if ("error" in loaded) {
      return loaded.error;
    }

    const summary = summariseFeed(loaded.feed);
    const statistics = loaded.network.statistics();

    if (booleanOr(args, "json", false)) {
      return {
        code: EXIT.ok,
        stdout: JSON.stringify({ feed: summary, network: statistics }, null, 2),
        stderr: "",
      };
    }

    return {
      code: EXIT.ok,
      stdout: [
        "Feed",
        renderFeedSummary(summary),
        "",
        "Network",
        renderNetworkStatistics(statistics),
      ].join("\n"),
      stderr: "",
    };
  },
};

/** `validate` — check a feed and report every problem found. */
export const validateCommand: Command = {
  name: "validate",
  summary: "Validate a feed and report every problem found",
  usage: "meridian validate --feed <directory> [--reference-date YYYYMMDD] [--json]",
  flags: [
    FEED_FLAG,
    JSON_FLAG,
    {
      name: "reference-date",
      kind: "string",
      description: "Date against which feed expiry is judged, as YYYYMMDD",
    },
    {
      name: "max-lines",
      kind: "number",
      description: "Diagnostics printed before the rest are summarised",
      defaultText: "200",
    },
  ],
  run(argv) {
    const args = parseArgs(argv, this.flags);
    const source = openSource(requireString(args, "feed"));
    if ("error" in source) {
      return source.error;
    }

    const loaded = loadFeed(source.source);
    const loadDiagnostics = loaded.diagnostics
      .sorted()
      .map((entry) => formatDiagnostic(entry))
      .join("\n");

    if (loaded.feed === undefined) {
      return {
        code: EXIT.unreadable,
        stdout: loadDiagnostics,
        stderr: "the feed could not be read",
      };
    }

    const referenceDate = optionalString(args, "reference-date");
    const report = validateFeed(loaded.feed, {
      ...(referenceDate === undefined ? {} : { referenceDate }),
    });

    if (booleanOr(args, "json", false)) {
      return { code: report.errors > 0 ? EXIT.failure : EXIT.ok, stdout: reportToJson(report), stderr: "" };
    }

    const sections = [loadDiagnostics, formatReport(report, numberOr(args, "max-lines", 200))]
      .filter((section) => section.length > 0)
      .join("\n");

    return {
      code: report.errors > 0 || loaded.diagnostics.hasErrors() ? EXIT.failure : EXIT.ok,
      stdout: sections,
      stderr: "",
    };
  },
};

/** `plan` — find journeys between two stops. */
export const planCommand: Command = {
  name: "plan",
  summary: "Plan journeys between two stops",
  usage: "meridian plan --feed <dir> --from <stop> --to <stop> --date <YYYYMMDD> --time <HH:MM:SS>",
  flags: [
    FEED_FLAG,
    JSON_FLAG,
    { name: "from", kind: "string", description: "Origin stop id", required: true },
    { name: "to", kind: "string", description: "Destination stop id", required: true },
    { name: "date", kind: "string", description: "Service date as YYYYMMDD", required: true },
    { name: "time", kind: "string", description: "Earliest departure as HH:MM:SS", required: true },
    {
      name: "max-boardings",
      kind: "number",
      description: "Maximum vehicle boardings",
      defaultText: "4",
    },
    {
      name: "transfer-slack",
      kind: "number",
      description: "Seconds needed between alighting and boarding",
      defaultText: "60",
    },
    {
      name: "limit",
      kind: "number",
      description: "Maximum journeys returned",
      defaultText: "5",
    },
    { name: "board", kind: "boolean", description: "Render a compact departure board" },
    {
      name: "window",
      kind: "number",
      description: "Search a departure window of this many seconds",
    },
    { name: "stops", kind: "boolean", description: "List stops passed through" },
  ],
  run(argv) {
    const args = parseArgs(argv, this.flags);
    const loaded = openNetwork(requireString(args, "feed"));
    if ("error" in loaded) {
      return loaded.error;
    }

    const request = {
      from: { kind: "stop" as const, stopId: requireString(args, "from") },
      to: { kind: "stop" as const, stopId: requireString(args, "to") },
      date: ServiceDate.parseFlexible(requireString(args, "date")),
      departAfter: requireString(args, "time"),
      maxBoardings: numberOr(args, "max-boardings", 4),
      minTransferSeconds: numberOr(args, "transfer-slack", 60),
    };
    const limit = numberOr(args, "limit", 5);
    const window = args.flags.get("window");

    const result =
      typeof window === "number"
        ? planProfile(loaded.network, request, { windowSeconds: window }, { limit })
        : planJourney(loaded.network, request, { limit });

    if (booleanOr(args, "json", false)) {
      return {
        code: result.journeys.length === 0 ? EXIT.failure : EXIT.ok,
        stdout: planToJson(result, { includeIntermediateStops: booleanOr(args, "stops", false) }),
        stderr: "",
      };
    }

    const text = booleanOr(args, "board", false)
      ? renderDepartureBoard(result)
      : renderPlan(result, { showIntermediateStops: booleanOr(args, "stops", false) });

    return {
      code: result.journeys.length === 0 ? EXIT.failure : EXIT.ok,
      stdout: text,
      stderr: "",
    };
  },
};

/** `reach` — list everywhere reachable inside a time budget. */
export const reachCommand: Command = {
  name: "reach",
  summary: "List every stop reachable from an origin inside a time budget",
  usage: "meridian reach --feed <dir> --from <stop> --date <YYYYMMDD> --time <HH:MM:SS> --budget <seconds>",
  flags: [
    FEED_FLAG,
    JSON_FLAG,
    { name: "from", kind: "string", description: "Origin stop id", required: true },
    { name: "date", kind: "string", description: "Service date as YYYYMMDD", required: true },
    { name: "time", kind: "string", description: "Departure time as HH:MM:SS", required: true },
    { name: "budget", kind: "number", description: "Time budget in seconds", required: true },
    {
      name: "max-boardings",
      kind: "number",
      description: "Maximum vehicle boardings",
      defaultText: "3",
    },
    { name: "geojson", kind: "boolean", description: "Emit GeoJSON points" },
    { name: "grid", kind: "boolean", description: "Render an ASCII coverage grid" },
  ],
  run(argv) {
    const args = parseArgs(argv, this.flags);
    const loaded = openNetwork(requireString(args, "feed"));
    if ("error" in loaded) {
      return loaded.error;
    }

    const budget = numberOr(args, "budget", 1800);
    const result = computeReach(loaded.network, {
      from: { kind: "stop", stopId: requireString(args, "from") },
      date: ServiceDate.parseFlexible(requireString(args, "date")),
      departAfter: requireString(args, "time"),
      budgetSeconds: budget,
      maxBoardings: numberOr(args, "max-boardings", 3),
    });

    if (result.reached.length === 0) {
      return { code: EXIT.failure, stdout: "", stderr: "no stop is reachable inside the budget" };
    }
    if (booleanOr(args, "geojson", false)) {
      return { code: EXIT.ok, stdout: toGeoJson(result), stderr: "" };
    }
    if (booleanOr(args, "json", false)) {
      return { code: EXIT.ok, stdout: reachToJson(result), stderr: "" };
    }
    if (booleanOr(args, "grid", false)) {
      const quarters = [budget / 4, budget / 2, (budget * 3) / 4, budget];
      return {
        code: EXIT.ok,
        stdout: renderGrid(rasterise(result), quarters),
        stderr: "",
      };
    }

    const bands = bandsOf(result, [budget / 3, (budget * 2) / 3, budget]);
    const rows = result.reached.map((stop) => [
      stop.stopId,
      stop.stopName,
      String(Math.round(stop.seconds / 60)),
      String(stop.boardings),
    ]);

    return {
      code: EXIT.ok,
      stdout: [
        renderTable(
          [
            { header: "Stop" },
            { header: "Name", maxWidth: 40 },
            { header: "Minutes", align: "right" },
            { header: "Boardings", align: "right" },
          ],
          rows,
        ),
        "",
        bands
          .map((band) => `within ${Math.round(band.budgetSeconds / 60)} min: ${band.stops.length} stop(s)`)
          .join("\n"),
      ].join("\n"),
      stderr: "",
    };
  },
};

/** `rules` — print the validation rule catalogue. */
export const rulesCommand: Command = {
  name: "rules",
  summary: "Print the validation rule catalogue",
  usage: "meridian rules [--json]",
  flags: [JSON_FLAG],
  run(argv) {
    const args = parseArgs(argv, this.flags);
    if (booleanOr(args, "json", false)) {
      return { code: EXIT.ok, stdout: JSON.stringify(VALIDATION_RULES, null, 2), stderr: "" };
    }
    const rows = VALIDATION_RULES.map((rule) => [
      rule.id,
      rule.category,
      rule.defaultSeverity,
      rule.description,
    ]);
    return {
      code: EXIT.ok,
      stdout: renderTable(
        [
          { header: "Rule" },
          { header: "Category" },
          { header: "Severity" },
          { header: "Description", maxWidth: 72 },
        ],
        rows,
      ),
      stderr: "",
    };
  },
};

/** Every command, in the order help lists them. */
export const COMMANDS: readonly Command[] = [
  describeCommand,
  validateCommand,
  planCommand,
  reachCommand,
  rulesCommand,
];

/** Looks a command up by name. */
export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Renders the top-level help text. */
export function renderHelp(): string {
  const rows = COMMANDS.map((command) => [command.name, command.summary]);
  return [
    "meridian — a deterministic transit routing engine",
    "",
    "Usage: meridian <command> [options]",
    "",
    renderTable([{ header: "Command" }, { header: "Summary" }], rows, { rule: false }),
    "",
    "Run `meridian <command> --help` for a command's options.",
  ].join("\n");
}

/** Renders one command's help text. */
export function renderCommandHelp(command: Command): string {
  return [command.summary, "", `Usage: ${command.usage}`, "", renderFlagHelp(command.flags)].join(
    "\n",
  );
}

/** Opens a feed directory, converting failure into a command output. */
function openSource(
  directory: string,
): { source: DirectoryFeedSource } | { error: CommandOutput } {
  try {
    return { source: DirectoryFeedSource.open(directory) };
  } catch (error) {
    return {
      error: {
        code: EXIT.unreadable,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Loads and compiles a feed, converting failure into a command output. */
function openNetwork(
  directory: string,
): { network: Network; feed: GtfsFeed } | { error: CommandOutput } {
  const source = openSource(directory);
  if ("error" in source) {
    return source;
  }

  const loaded = loadFeed(source.source);
  if (loaded.feed === undefined) {
    return {
      error: {
        code: EXIT.unreadable,
        stdout: loaded.diagnostics
          .sorted()
          .map((entry) => formatDiagnostic(entry))
          .join("\n"),
        stderr: "the feed could not be read",
      },
    };
  }

  const built = buildNetwork(loaded.feed);
  return { network: built.network, feed: loaded.feed };
}

/** Re-exported so `main.ts` can report a usage error consistently. */
export { CliUsageError };
