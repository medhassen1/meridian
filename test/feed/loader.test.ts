import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { MeridianError, MissingTableError } from "../../src/errors.js";
import { DirectoryFeedSource } from "../../src/feed/directory.js";
import {
  FilteredFeedSource,
  MemoryFeedSource,
  REQUIRED_TABLES,
  TABLES,
  hasAnyCalendarTable,
  missingRequiredTables,
} from "../../src/feed/source.js";
import { loadFeed, loadFeedFromTables } from "../../src/feed/loader.js";
import {
  referencedServiceIds,
  servedStopIds,
  summariseFeed,
  tripsForRoute,
  tripsForService,
  unservedStops,
} from "../../src/feed/feed.js";
import { minimalTables, rivertownSource, rivertownTables } from "../support/fixtures.js";
import { table } from "../support/csv.js";

describe("MemoryFeedSource", () => {
  it("stores and reads tables", () => {
    const source = new MemoryFeedSource({ "a.txt": "one" });
    expect(source.has("a.txt")).toBe(true);
    expect(source.read("a.txt")).toBe("one");
    expect(source.read("b.txt")).toBeUndefined();
  });

  it("sets and deletes tables", () => {
    const source = new MemoryFeedSource();
    expect(source.set("a.txt", "one")).toBe(source);
    expect(source.delete("a.txt")).toBe(true);
    expect(source.delete("a.txt")).toBe(false);
  });

  it("lists names in ascending order", () => {
    const source = new MemoryFeedSource({ "z.txt": "", "a.txt": "" });
    expect(source.tableNames()).toEqual(["a.txt", "z.txt"]);
  });

  it("throws for a required table it lacks", () => {
    const source = new MemoryFeedSource();
    expect(() => source.readRequired("stops.txt")).toThrow(MissingTableError);
  });

  it("returns a required table it has", () => {
    expect(new MemoryFeedSource({ "a.txt": "x" }).readRequired("a.txt")).toBe("x");
  });
});

describe("FilteredFeedSource", () => {
  const inner = new MemoryFeedSource({ "a.txt": "one", "b.txt": "two" });
  const filtered = new FilteredFeedSource(inner, ["a.txt"]);

  it("hides tables outside its allowance", () => {
    expect(filtered.has("a.txt")).toBe(true);
    expect(filtered.has("b.txt")).toBe(false);
    expect(filtered.read("b.txt")).toBeUndefined();
  });

  it("passes through allowed tables", () => {
    expect(filtered.read("a.txt")).toBe("one");
  });

  it("lists only allowed tables", () => {
    expect(filtered.tableNames()).toEqual(["a.txt"]);
  });

  it("does not invent tables the inner source lacks", () => {
    expect(new FilteredFeedSource(inner, ["z.txt"]).has("z.txt")).toBe(false);
  });
});

describe("required table checks", () => {
  it("names every missing required table", () => {
    expect(missingRequiredTables(new MemoryFeedSource())).toEqual(REQUIRED_TABLES);
  });

  it("reports nothing missing for a complete feed", () => {
    expect(missingRequiredTables(rivertownSource())).toEqual([]);
  });

  it("accepts either calendar table", () => {
    expect(hasAnyCalendarTable(new MemoryFeedSource({ [TABLES.calendar]: "" }))).toBe(true);
    expect(hasAnyCalendarTable(new MemoryFeedSource({ [TABLES.calendarDates]: "" }))).toBe(true);
    expect(hasAnyCalendarTable(new MemoryFeedSource())).toBe(false);
  });
});

describe("loadFeed", () => {
  it("loads the Rivertown fixture cleanly", () => {
    const result = loadFeed(rivertownSource());
    expect(result.feed).toBeDefined();
    expect(result.diagnostics.hasErrors()).toBe(false);
  });

  it("refuses a feed missing a required table", () => {
    const result = loadFeed(rivertownSource({ "stops.txt": null }));
    expect(result.feed).toBeUndefined();
    expect(result.diagnostics.bySeverity("error")[0]?.rule).toBe("loader.missing_table");
  });

  it("reports a feed with neither calendar table", () => {
    const result = loadFeed(
      rivertownSource({ "calendar.txt": null, "calendar_dates.txt": null }),
    );
    expect(result.diagnostics.bySeverity("error").some((entry) => entry.rule === "loader.no_calendar")).toBe(
      true,
    );
  });

  it("refuses a feed whose required table cannot be tokenised", () => {
    const result = loadFeed(rivertownSource({ "stops.txt": 'stop_id\n"unterminated' }));
    expect(result.feed).toBeUndefined();
  });

  it("loads a feed with no optional tables at all", () => {
    const result = loadFeed(new MemoryFeedSource(minimalTables()));
    expect(result.feed).toBeDefined();
    expect(result.feed?.shapes.size).toBe(0);
    expect(result.feed?.transfers).toEqual([]);
    expect(result.feed?.feedInfo).toBeUndefined();
  });

  it("reports a trip with no stop times and drops it", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string)
      .split("\n")
      .filter((line) => !line.startsWith("R1-3,"))
      .join("\n");

    const result = loadFeed(new MemoryFeedSource(tables));
    expect(result.feed?.tripById.has("R1-3")).toBe(false);
    expect(
      result.diagnostics.bySeverity("error").some((entry) => entry.rule === "loader.trip_without_calls"),
    ).toBe(true);
  });

  it("reports stop times naming a trip that does not exist", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = `${tables["stop_times.txt"] as string}\nGHOST,08:00:00,08:00:00,MARKET,1,0,0\nGHOST,08:10:00,08:10:00,EAST,2,0,0`;

    const result = loadFeed(new MemoryFeedSource(tables));
    expect(
      result.diagnostics.bySeverity("error").some((entry) => entry.rule === "loader.calls_without_trip"),
    ).toBe(true);
  });

  it("refuses the whole feed when broken trips are not tolerated", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string)
      .split("\n")
      .filter((line) => !line.startsWith("R1-3,"))
      .join("\n");

    const result = loadFeed(new MemoryFeedSource(tables), { tolerateBrokenTrips: false });
    expect(result.feed).toBeUndefined();
    expect(
      result.diagnostics.bySeverity("error").some((entry) => entry.rule === "loader.broken_trips"),
    ).toBe(true);
  });

  it("sorts trips by id so indexes are reproducible", () => {
    const feed = loadFeed(rivertownSource()).feed;
    const ids = feed?.trips.map((trip) => trip.tripId) ?? [];
    expect(ids).toEqual(ids.slice().sort());
  });

  it("honours a diagnostic limit", () => {
    const result = loadFeed(rivertownSource(), { diagnosticLimit: 1 });
    expect(result.diagnostics.all().length).toBeLessThanOrEqual(1);
  });

  it("passes ragged row and trim options through to the parser", () => {
    const tables = rivertownTables();
    // The row omits its trailing optional column, so padding recovers it while
    // the strict policy rejects the whole table.
    tables["agency.txt"] =
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang\nRT,Rivertown,https://r.example,Europe/London";

    // Under the strict policy agency.txt does not tokenise at all, so the
    // whole feed is refused rather than loaded without its agencies.
    const strict = loadFeed(new MemoryFeedSource(tables));
    expect(strict.diagnostics.hasErrors()).toBe(true);
    expect(strict.feed).toBeUndefined();

    const lenient = loadFeed(new MemoryFeedSource(tables), { raggedRows: "pad" });
    expect(lenient.feed?.agencies).toHaveLength(1);
    expect(lenient.feed?.agencies[0]?.agencyLang).toBeUndefined();
  });
});

describe("loadFeedFromTables", () => {
  it("loads from a plain object", () => {
    const result = loadFeedFromTables(minimalTables());
    expect(result.feed?.trips).toHaveLength(1);
  });

  it("reports a missing table", () => {
    const tables = minimalTables();
    delete tables["routes.txt"];
    expect(loadFeedFromTables(tables).feed).toBeUndefined();
  });
});

describe("feed accessors", () => {
  const feed = loadFeed(rivertownSource()).feed as NonNullable<
    ReturnType<typeof loadFeed>["feed"]
  >;

  it("summarises counts", () => {
    const summary = summariseFeed(feed);
    expect(summary.trips).toBe(10);
    expect(summary.calls).toBeGreaterThan(20);
    expect(summary.services).toBe(2);
  });

  it("filters trips by service", () => {
    expect(tripsForService(feed, "WEEKEND").map((trip) => trip.tripId)).toEqual(["R1-W1"]);
    expect(tripsForService(feed, "NOPE")).toEqual([]);
  });

  it("filters trips by route", () => {
    expect(tripsForRoute(feed, "R2").map((trip) => trip.tripId)).toEqual(["R2-1", "R2-2", "R2-N"]);
  });

  it("lists served stops in sorted order", () => {
    const served = servedStopIds(feed);
    expect(served).toEqual(served.slice().sort());
    expect(served).toContain("HARBOUR");
    expect(served).not.toContain("DEPOT");
  });

  it("lists boardable stops no trip calls at", () => {
    expect(unservedStops(feed).map((stop) => stop.stopId)).toEqual(["DEPOT"]);
  });

  it("lists referenced services in sorted order", () => {
    expect(referencedServiceIds(feed)).toEqual(["WEEKDAY", "WEEKEND"]);
  });
});

describe("DirectoryFeedSource", () => {
  const directory = mkdtempSync(join(tmpdir(), "meridian-feed-"));
  for (const [name, contents] of Object.entries(rivertownTables())) {
    // Deliberately capitalised: real feeds exported on Windows often are.
    writeFileSync(join(directory, name === "stops.txt" ? "Stops.txt" : name), contents, "utf8");
  }
  writeFileSync(join(directory, "notes.md"), "ignored", "utf8");

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("matches table names case-insensitively", () => {
    const source = DirectoryFeedSource.open(directory);
    expect(source.has("stops.txt")).toBe(true);
    expect(source.read("stops.txt")).toContain("CENTRAL_A");
  });

  it("ignores files that are not .txt", () => {
    expect(DirectoryFeedSource.open(directory).tableNames()).not.toContain("notes.md");
  });

  it("reports its own path", () => {
    expect(DirectoryFeedSource.open(directory).path).toBe(directory);
  });

  it("returns undefined for an absent table", () => {
    expect(DirectoryFeedSource.open(directory).read("nope.txt")).toBeUndefined();
  });

  it("caches contents and can be invalidated", () => {
    const source = DirectoryFeedSource.open(directory);
    const first = source.read("agency.txt");
    writeFileSync(join(directory, "agency.txt"), "changed", "utf8");
    expect(source.read("agency.txt")).toBe(first);
    source.invalidate();
    expect(source.read("agency.txt")).toBe("changed");
    writeFileSync(join(directory, "agency.txt"), first as string, "utf8");
  });

  it("loads a feed end to end from disk", () => {
    const result = loadFeed(DirectoryFeedSource.open(directory));
    expect(result.feed?.stops).toHaveLength(10);
  });

  it("rejects a path that does not exist", () => {
    expect(() => DirectoryFeedSource.open(join(directory, "missing"))).toThrow(MeridianError);
  });

  it("rejects a path that is not a directory", () => {
    expect(() => DirectoryFeedSource.open(join(directory, "agency.txt"))).toThrow(/not a directory/);
  });

  it("keeps only one entry when a name differs by case alone", () => {
    const nested = mkdtempSync(join(tmpdir(), "meridian-case-"));
    writeFileSync(join(nested, "agency.txt"), table(["a"], [["1"]]), "utf8");
    const source = DirectoryFeedSource.open(nested);
    expect(source.tableNames().filter((name) => name === "agency.txt")).toHaveLength(1);
    rmSync(nested, { recursive: true, force: true });
  });
});
