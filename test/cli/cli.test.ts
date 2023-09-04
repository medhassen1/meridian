import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { CliUsageError } from "../../src/errors.js";
import {
  booleanOr,
  numberOr,
  optionalString,
  parseArgs,
  renderFlagHelp,
  requireString,
  type FlagSpec,
} from "../../src/cli/args.js";
import {
  COMMANDS,
  EXIT,
  findCommand,
  renderCommandHelp,
  renderHelp,
} from "../../src/cli/commands.js";
import { VERSION, run } from "../../src/cli/main.js";
import { rivertownTables } from "../support/fixtures.js";

const SPECS: readonly FlagSpec[] = [
  { name: "feed", kind: "string", short: "f", description: "Feed directory", required: true },
  { name: "limit", kind: "number", description: "Result limit", defaultText: "5" },
  { name: "json", kind: "boolean", description: "Emit JSON" },
];

describe("parseArgs", () => {
  it("reads a separated value", () => {
    const args = parseArgs(["--feed", "/data"], SPECS);
    expect(args.flags.get("feed")).toBe("/data");
  });

  it("reads an inline value", () => {
    expect(parseArgs(["--feed=/data"], SPECS).flags.get("feed")).toBe("/data");
  });

  it("reads a short alias", () => {
    expect(parseArgs(["-f", "/data"], SPECS).flags.get("feed")).toBe("/data");
  });

  it("reads a number", () => {
    expect(parseArgs(["--feed", "/d", "--limit", "3"], SPECS).flags.get("limit")).toBe(3);
  });

  it("reads a bare boolean", () => {
    expect(parseArgs(["--feed", "/d", "--json"], SPECS).flags.get("json")).toBe(true);
  });

  it("reads an explicit boolean value", () => {
    for (const [text, value] of [
      ["true", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
    ] as const) {
      expect(parseArgs(["--feed", "/d", `--json=${text}`], SPECS).flags.get("json")).toBe(value);
    }
  });

  it("collects positional arguments", () => {
    expect(parseArgs(["--feed", "/d", "one", "two"], SPECS).positionals).toEqual(["one", "two"]);
  });

  it("treats a lone dash as positional", () => {
    expect(parseArgs(["--feed", "/d", "-"], SPECS).positionals).toEqual(["-"]);
  });

  it("stops option parsing at a double dash", () => {
    expect(parseArgs(["--feed", "/d", "--", "--json"], SPECS).positionals).toEqual(["--json"]);
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["--nope"], SPECS)).toThrow(/unknown option/);
    expect(() => parseArgs(["-z"], SPECS)).toThrow(CliUsageError);
  });

  it("rejects a missing value", () => {
    expect(() => parseArgs(["--feed"], SPECS)).toThrow(/needs a value/);
    expect(() => parseArgs(["--feed", "--json"], SPECS)).toThrow(/needs a value/);
  });

  it("rejects a non-numeric number", () => {
    expect(() => parseArgs(["--feed", "/d", "--limit", "many"], SPECS)).toThrow(/expects a number/);
  });

  it("rejects an unrecognised boolean", () => {
    expect(() => parseArgs(["--feed", "/d", "--json=maybe"], SPECS)).toThrow(/expects true or false/);
  });

  it("rejects a missing required option", () => {
    expect(() => parseArgs([], SPECS)).toThrow(/is required/);
  });
});

describe("argument accessors", () => {
  const args = parseArgs(["--feed", "/data", "--limit", "3", "--json"], SPECS);

  it("reads a required string", () => {
    expect(requireString(args, "feed")).toBe("/data");
    expect(() => requireString(args, "limit")).toThrow(CliUsageError);
  });

  it("reads an optional string", () => {
    expect(optionalString(args, "feed")).toBe("/data");
    expect(optionalString(args, "missing")).toBeUndefined();
  });

  it("reads a number with a fallback", () => {
    expect(numberOr(args, "limit", 5)).toBe(3);
    expect(numberOr(args, "missing", 5)).toBe(5);
  });

  it("reads a boolean with a fallback", () => {
    expect(booleanOr(args, "json", false)).toBe(true);
    expect(booleanOr(args, "missing", true)).toBe(true);
  });
});

describe("renderFlagHelp", () => {
  it("aligns descriptions", () => {
    const text = renderFlagHelp(SPECS);
    expect(text).toContain("-f, --feed <string>");
    expect(text).toContain("(default: 5)");
  });

  it("returns empty text for no flags", () => {
    expect(renderFlagHelp([])).toBe("");
  });
});

describe("command discovery", () => {
  it("finds a command by name", () => {
    expect(findCommand("plan")?.name).toBe("plan");
    expect(findCommand("nope")).toBeUndefined();
  });

  it("renders top-level help listing every command", () => {
    const text = renderHelp();
    for (const command of COMMANDS) {
      expect(text).toContain(command.name);
    }
  });

  it("renders per-command help", () => {
    const text = renderCommandHelp(findCommand("plan") as never);
    expect(text).toContain("Usage:");
    expect(text).toContain("--from");
  });
});

describe("the CLI against a real feed", () => {
  const directory = mkdtempSync(join(tmpdir(), "meridian-cli-"));
  for (const [name, contents] of Object.entries(rivertownTables())) {
    writeFileSync(join(directory, name), contents, "utf8");
  }

  const broken = mkdtempSync(join(tmpdir(), "meridian-broken-"));
  writeFileSync(join(broken, "agency.txt"), "agency_name\nBroken", "utf8");

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  });

  it("prints help with no arguments", () => {
    const output = run([]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("meridian");
  });

  it("prints help on request", () => {
    expect(run(["--help"]).stdout).toContain("Usage:");
    expect(run(["-h"]).stdout).toContain("Usage:");
    expect(run(["help"]).stdout).toContain("Usage:");
  });

  it("prints the version", () => {
    expect(run(["--version"]).stdout).toBe(VERSION);
    expect(run(["-v"]).stdout).toBe(VERSION);
  });

  it("rejects an unknown command", () => {
    const output = run(["nope"]);
    expect(output.code).toBe(EXIT.usage);
    expect(output.stderr).toContain("unknown command");
  });

  it("prints command help on request", () => {
    expect(run(["plan", "--help"]).stdout).toContain("--from");
    expect(run(["plan", "-h"]).code).toBe(EXIT.ok);
  });

  it("reports a usage error as an exit code, not an exception", () => {
    const output = run(["plan"]);
    expect(output.code).toBe(EXIT.usage);
    expect(output.stderr).toContain("CLI_USAGE");
  });

  it("describes a feed", () => {
    const output = run(["describe", "--feed", directory]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("Feed");
    expect(output.stdout).toContain("Network");
  });

  it("describes a feed as JSON", () => {
    const output = run(["describe", "--feed", directory, "--json"]);
    const parsed = JSON.parse(output.stdout) as { feed: { trips: number } };
    expect(parsed.feed.trips).toBe(10);
  });

  it("reports an unreadable feed directory", () => {
    const output = run(["describe", "--feed", join(directory, "missing")]);
    expect(output.code).toBe(EXIT.unreadable);
    expect(output.stderr.length).toBeGreaterThan(0);
  });

  it("reports a feed missing required tables", () => {
    const output = run(["describe", "--feed", broken]);
    expect(output.code).toBe(EXIT.unreadable);
  });

  it("validates a feed", () => {
    const output = run(["validate", "--feed", directory]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("error(s)");
  });

  it("validates a feed as JSON", () => {
    const output = run(["validate", "--feed", directory, "--json"]);
    const parsed = JSON.parse(output.stdout) as { counts: { errors: number } };
    expect(parsed.counts.errors).toBe(0);
  });

  it("fails validation against a late reference date", () => {
    const output = run(["validate", "--feed", directory, "--reference-date", "20240101"]);
    expect(output.stdout).toContain("time.feed_expired");
  });

  it("honours a validation line limit", () => {
    const output = run(["validate", "--feed", directory, "--max-lines", "1"]);
    expect(output.stdout).toContain("not shown");
  });

  it("reports an unreadable feed to validate", () => {
    expect(run(["validate", "--feed", broken]).code).toBe(EXIT.unreadable);
  });

  it("plans a journey", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
    ]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("Option 1");
  });

  it("accepts a hyphenated date", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "2023-06-05",
      "--time",
      "07:45:00",
    ]);
    expect(output.code).toBe(EXIT.ok);
  });

  it("renders a departure board", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
      "--board",
    ]);
    expect(output.stdout).toContain("Depart");
  });

  it("lists intermediate stops on request", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
      "--stops",
    ]);
    expect(output.stdout).toContain("Market Square");
  });

  it("plans across a departure window", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:30:00",
      "--window",
      "7200",
      "--board",
    ]);
    expect(output.stdout.split("\n").length).toBeGreaterThan(4);
  });

  it("emits a plan as JSON", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
      "--json",
    ]);
    const parsed = JSON.parse(output.stdout) as { journeys: unknown[] };
    expect(parsed.journeys.length).toBeGreaterThan(0);
  });

  it("fails when no journey is found", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20231001",
      "--time",
      "07:45:00",
    ]);
    expect(output.code).toBe(EXIT.failure);
    expect(output.stdout).toBe("No journey found.");
  });

  it("reports an unknown stop as a failure", () => {
    const output = run([
      "plan",
      "--feed",
      directory,
      "--from",
      "NOPE",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
    ]);
    expect(output.code).toBe(EXIT.failure);
    expect(output.stderr).toContain("UNKNOWN_STOP");
  });

  it("reports an unreadable feed to plan against", () => {
    const output = run([
      "plan",
      "--feed",
      broken,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
    ]);
    expect(output.code).toBe(EXIT.unreadable);
  });

  it("computes reachability", () => {
    const output = run([
      "reach",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--date",
      "20230605",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
    ]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("Minutes");
    expect(output.stdout).toContain("within");
  });

  it("summarises reachability with cumulative counts", () => {
    const output = run([
      "reach",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--date",
      "20230605",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
    ]);
    const counts = output.stdout
      .split("\n")
      .filter((line) => line.startsWith("within "))
      .map((line) => Number(/: (\d+) stop/.exec(line)?.[1] ?? "0"));

    expect(counts).toHaveLength(3);
    // Cumulative, so each band includes everything the tighter ones did.
    expect(counts[1]).toBeGreaterThanOrEqual(counts[0] as number);
    expect(counts[2]).toBeGreaterThanOrEqual(counts[1] as number);
  });

  it("emits reachability as JSON and GeoJSON", () => {
    const base = [
      "reach",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--date",
      "20230605",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
    ];
    expect(JSON.parse(run([...base, "--json"]).stdout)).toHaveProperty("reached");
    expect(JSON.parse(run([...base, "--geojson"]).stdout)).toHaveProperty("features");
  });

  it("renders a reachability grid", () => {
    const output = run([
      "reach",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--date",
      "20230605",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
      "--grid",
    ]);
    expect(output.stdout.split("\n").length).toBeGreaterThan(4);
  });

  it("fails when nothing is reachable", () => {
    const output = run([
      "reach",
      "--feed",
      directory,
      "--from",
      "CENTRAL_A",
      "--date",
      "20231001",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
    ]);
    expect(output.code).toBe(EXIT.failure);
    expect(output.stderr).toContain("no stop is reachable");
  });

  it("reports an unreadable feed to reach from", () => {
    const output = run([
      "reach",
      "--feed",
      broken,
      "--from",
      "CENTRAL_A",
      "--date",
      "20230605",
      "--time",
      "07:55:00",
      "--budget",
      "3600",
    ]);
    expect(output.code).toBe(EXIT.unreadable);
  });

  it("prints the rule catalogue", () => {
    const output = run(["rules"]);
    expect(output.code).toBe(EXIT.ok);
    expect(output.stdout).toContain("ref.trip_route");
  });

  it("prints the rule catalogue as JSON", () => {
    const parsed = JSON.parse(run(["rules", "--json"]).stdout) as Array<{ id: string }>;
    expect(parsed.length).toBeGreaterThan(10);
  });

  it("produces identical output on repeated runs", () => {
    const argv = [
      "plan",
      "--feed",
      directory,
      "--from",
      "NORTH",
      "--to",
      "HARBOUR",
      "--date",
      "20230605",
      "--time",
      "07:45:00",
    ];
    expect(run(argv).stdout).toBe(run(argv).stdout);
  });
});
