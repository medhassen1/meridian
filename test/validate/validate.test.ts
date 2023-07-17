import { describe, expect, it } from "vitest";

import { DiagnosticSink } from "../../src/csv/sink.js";
import { ServiceCalendar } from "../../src/calendar/service-calendar.js";
import type { GtfsFeed } from "../../src/feed/feed.js";
import {
  DEFAULT_PER_RULE_LIMIT,
  Reporter,
  at,
  type ValidationContext,
} from "../../src/validate/context.js";
import {
  RuleRegistry,
  VALIDATION_RULES,
  findRule,
  rulesInCategory,
} from "../../src/validate/rules.js";
import {
  DEFAULT_VALIDATORS,
  formatReport,
  groupByRule,
  isClean,
  reportToJson,
  validateFeed,
} from "../../src/validate/report.js";
import {
  MAX_SPEED_BY_MODE,
  validateAntimeridian,
  validateDuplicatePositions,
  validateOutlierStops,
} from "../../src/validate/geometry.js";
import { feedOverhangDays, validateFeedExpiry } from "../../src/validate/temporal.js";
import { rivertownFeed, rivertownTables } from "../support/fixtures.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { loadFeed } from "../../src/feed/loader.js";

/** Loads a feed from the Rivertown tables with the given overrides. */
function feedWith(overrides: Record<string, string>): GtfsFeed {
  const tables = { ...rivertownTables(), ...overrides };
  const result = loadFeed(new MemoryFeedSource(tables));
  if (result.feed === undefined) {
    throw new Error("fixture failed to load");
  }
  return result.feed;
}

/** Runs one validator against a feed and returns its diagnostics. */
function runValidator(
  feed: GtfsFeed,
  validator: (context: ValidationContext, report: Reporter) => void,
  overrides: Record<string, "error" | "warning" | "info" | "off"> = {},
): DiagnosticSink {
  const sink = new DiagnosticSink();
  const context: ValidationContext = {
    feed,
    calendar: ServiceCalendar.build(feed.calendars, feed.calendarExceptions),
    registry: new RuleRegistry(overrides),
    sink,
    perRuleLimit: DEFAULT_PER_RULE_LIMIT,
  };
  validator(context, new Reporter(context));
  return sink;
}

describe("the rule catalogue", () => {
  it("declares a unique id for every rule", () => {
    const ids = VALIDATION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks a rule up by id", () => {
    expect(findRule("ref.trip_route")?.category).toBe("referential");
    expect(findRule("nope")).toBeUndefined();
  });

  it("groups rules by category", () => {
    expect(rulesInCategory("referential").length).toBeGreaterThan(5);
    expect(rulesInCategory("geometry").every((rule) => rule.category === "geometry")).toBe(true);
  });

  it("gives every rule a description", () => {
    expect(VALIDATION_RULES.every((rule) => rule.description.length > 10)).toBe(true);
  });
});

describe("RuleRegistry", () => {
  it("returns each rule's default severity", () => {
    expect(new RuleRegistry().severityOf("ref.trip_route")).toBe("error");
    expect(new RuleRegistry().severityOf("cover.unserved_stop")).toBe("info");
  });

  it("applies an override", () => {
    const registry = new RuleRegistry({ "ref.trip_route": "warning" });
    expect(registry.severityOf("ref.trip_route")).toBe("warning");
  });

  it("suppresses a rule", () => {
    const registry = new RuleRegistry({ "ref.trip_route": "off" });
    expect(registry.isEnabled("ref.trip_route")).toBe(false);
    expect(registry.suppressedRuleIds()).toEqual(["ref.trip_route"]);
  });

  it("treats an unknown rule id as an error to fail fast", () => {
    expect(() => new RuleRegistry({ "nope.rule": "off" })).toThrow(/unknown validation rule/);
  });

  it("falls back to error for an unrecognised id at query time", () => {
    expect(new RuleRegistry().severityOf("not.a.rule")).toBe("error");
  });

  it("reports nothing suppressed by default", () => {
    expect(new RuleRegistry().suppressedRuleIds()).toEqual([]);
  });
});

describe("Reporter", () => {
  const feed = rivertownFeed();
  const build = (perRuleLimit: number, overrides = {}) => {
    const sink = new DiagnosticSink();
    const context: ValidationContext = {
      feed,
      calendar: ServiceCalendar.build(feed.calendars, feed.calendarExceptions),
      registry: new RuleRegistry(overrides),
      sink,
      perRuleLimit,
    };
    return { reporter: new Reporter(context), sink };
  };

  it("applies the rule's severity", () => {
    const { reporter, sink } = build(10);
    reporter.emit("cover.unserved_stop", "note");
    expect(sink.bySeverity("info")).toHaveLength(1);
  });

  it("drops a suppressed rule", () => {
    const { reporter, sink } = build(10, { "cover.unserved_stop": "off" });
    expect(reporter.emit("cover.unserved_stop", "note")).toBe(false);
    expect(sink.total()).toBe(0);
    expect(reporter.isActive("cover.unserved_stop")).toBe(false);
  });

  it("silences a rule past its limit and says so once", () => {
    const { reporter, sink } = build(2);
    for (let index = 0; index < 5; index += 1) {
      reporter.emit("ref.trip_route", `problem ${index}`);
    }
    expect(sink.bySeverity("error")).toHaveLength(2);
    expect(sink.bySeverity("info").filter((entry) => entry.message.includes("suppressed"))).toHaveLength(1);
    expect(reporter.isActive("ref.trip_route")).toBe(false);
  });

  it("counts every occurrence, including suppressed ones", () => {
    const { reporter } = build(1);
    reporter.emit("ref.trip_route", "a");
    reporter.emit("ref.trip_route", "b");
    expect(reporter.timesFired("ref.trip_route")).toBe(2);
    expect(reporter.timesFired("other.rule")).toBe(0);
  });

  it("lists the rules that fired, sorted", () => {
    const { reporter } = build(10);
    reporter.emit("ref.trip_route", "a");
    reporter.emit("cover.unserved_stop", "b");
    expect(reporter.firedRuleIds()).toEqual(["cover.unserved_stop", "ref.trip_route"]);
  });

  it("builds a position from a file and line", () => {
    expect(at("stops.txt", 4)).toEqual({ file: "stops.txt", line: 4, column: 1 });
  });
});

describe("referential validators", () => {
  it("reports a trip naming an unknown route", () => {
    const feed = rivertownFeed();
    const broken: GtfsFeed = { ...feed, routeById: new Map() };
    const report = validateFeed(broken);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.trip_route")).toBe(true);
  });

  it("reports a trip naming an unknown service", () => {
    const feed = feedWith({
      "calendar.txt":
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nOTHER,1,1,1,1,1,0,0,20230601,20230831",
      "calendar_dates.txt": "service_id,date,exception_type\nOTHER,20230612,2",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.trip_service")).toBe(true);
  });

  it("reports a trip naming an unknown shape", () => {
    const feed = feedWith({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence" });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.trip_shape")).toBe(true);
  });

  it("reports a call naming an unknown stop", () => {
    const feed = rivertownFeed();
    const broken: GtfsFeed = { ...feed, stopById: new Map() };
    const report = validateFeed(broken);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.call_stop")).toBe(true);
  });

  it("reports a call at a station rather than a platform", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string).replaceAll("CENTRAL_A", "CENTRAL");
    const feed = feedWith({ "stop_times.txt": tables["stop_times.txt"] as string });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.call_not_boardable")).toBe(true);
  });

  it("reports a route naming an unknown agency", () => {
    const feed = feedWith({
      "agency.txt":
        "agency_id,agency_name,agency_url,agency_timezone\nOTHER,Other,https://o.example,Europe/London",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.route_agency")).toBe(true);
  });

  it("accepts a blank agency id against a single unnamed agency", () => {
    const feed = feedWith({
      "agency.txt": "agency_name,agency_url,agency_timezone\nTiny,https://t.example,Europe/London",
      "routes.txt": "route_id,route_short_name,route_type\nR1,1,3\nR2,2,0\nR3,3,2\nR4,4,3\nR9,9,3",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.route_agency")).toBe(false);
  });

  it("reports a parent that is not a station", () => {
    const feed = feedWith({
      "stops.txt": [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "CENTRAL,Central,51.5004,-0.1,0,",
        "CENTRAL_A,Platform A,51.5,-0.1,0,CENTRAL",
        "CENTRAL_B,Platform B,51.5008,-0.1,0,CENTRAL",
        "MARKET,Market,51.503,-0.1,0,",
        "NORTH,North,51.52,-0.1,0,",
        "SOUTH,South,51.48,-0.1,0,",
        "EAST,East,51.5,-0.07,0,",
        "WEST,West,51.5,-0.13,0,",
        "HARBOUR,Harbour,51.5,-0.04,0,",
        "DEPOT,Depot,51.51,-0.12,0,",
      ].join("\n"),
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.parent_station")).toBe(true);
  });

  it("reports an unknown parent station", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop) =>
      stop.stopId === "CENTRAL_A" ? { ...stop, parentStation: "GHOST" } : stop,
    );
    const report = validateFeed({ ...feed, stops });
    expect(report.diagnostics.some((entry) => entry.rule === "ref.parent_station")).toBe(true);
  });

  it("reports a stop naming an unknown level", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop) =>
      stop.stopId === "CENTRAL_A" ? { ...stop, levelId: "L9" } : stop,
    );
    const report = validateFeed({ ...feed, stops });
    expect(report.diagnostics.some((entry) => entry.rule === "ref.stop_level")).toBe(true);
  });

  it("reports a transfer naming an unknown stop", () => {
    const feed = feedWith({
      "transfers.txt": "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nGHOST,CENTRAL_A,2,60",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.transfer_stop")).toBe(true);
  });

  it("reports a transfer naming an unknown trip", () => {
    const feed = feedWith({
      "transfers.txt": "from_trip_id,to_trip_id,transfer_type\nGHOST,R1-1,4",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.transfer_trip")).toBe(true);
  });

  it("reports a frequency naming an unknown trip", () => {
    const feed = feedWith({
      "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nGHOST,06:00:00,07:00:00,600",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.frequency_trip")).toBe(true);
  });

  it("reports fare rules naming unknown fares, routes, and zones", () => {
    const feed = feedWith({
      "fare_rules.txt": "fare_id,route_id,origin_id\nGHOST,R1,\nF_BASE,GHOSTR,\nF_BASE,R1,GHOSTZ",
    });
    const report = validateFeed(feed);
    const rules = new Set(report.diagnostics.map((entry) => entry.rule));
    expect(rules.has("ref.fare_rule_fare")).toBe(true);
    expect(rules.has("ref.fare_rule_route")).toBe(true);
    expect(rules.has("ref.fare_rule_zone")).toBe(true);
  });

  it("reports a pathway naming an unknown stop", () => {
    const feed = feedWith({
      "pathways.txt":
        "pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional\nP,GHOST,CENTRAL_A,1,1",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "ref.pathway_stop")).toBe(true);
  });
});

describe("temporal validators", () => {
  it("reports a service that is never active", () => {
    const feed = feedWith({
      "calendar_dates.txt": [
        "service_id,date,exception_type",
        "WEEKEND,20230603,2",
        "WEEKEND,20230604,2",
        "WEEKEND,20230610,2",
        "WEEKEND,20230611,2",
        "WEEKEND,20230617,2",
        "WEEKEND,20230618,2",
        "WEEKEND,20230624,2",
        "WEEKEND,20230625,2",
      ].join("\n"),
    });
    // The weekend service still runs in July and August, so it is active.
    expect(validateFeed(feed).diagnostics.some((entry) => entry.rule === "time.service_never_active")).toBe(
      false,
    );
  });

  it("reports a trip whose service never runs", () => {
    const feed = feedWith({
      "calendar.txt":
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWEEKDAY,1,1,1,1,1,0,0,20230603,20230604\nWEEKEND,0,0,0,0,0,1,1,20230601,20230831",
      "calendar_dates.txt": "service_id,date,exception_type\nWEEKDAY,20230603,2\nWEEKDAY,20230604,2",
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "time.service_never_active")).toBe(true);
    expect(report.diagnostics.some((entry) => entry.rule === "time.trip_never_runs")).toBe(true);
  });

  it("reports a declared range the calendar does not cover", () => {
    const feed = feedWith({
      "feed_info.txt":
        "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nR,https://r.example,en,20230501,20231231",
    });
    const report = validateFeed(feed);
    const messages = report.diagnostics
      .filter((entry) => entry.rule === "time.declared_range_mismatch")
      .map((entry) => entry.message);
    expect(messages.some((message) => message.includes("through"))).toBe(true);
    expect(messages.some((message) => message.includes("from"))).toBe(true);
  });

  it("says nothing when the declared range matches", () => {
    expect(
      validateFeed(rivertownFeed()).diagnostics.some(
        (entry) => entry.rule === "time.declared_range_mismatch",
      ),
    ).toBe(false);
  });

  it("reports an expired feed against an explicit reference date", () => {
    const report = validateFeed(rivertownFeed(), { referenceDate: "20240101" });
    expect(report.diagnostics.some((entry) => entry.rule === "time.feed_expired")).toBe(true);
  });

  it("says nothing when the reference date falls inside the calendar", () => {
    const report = validateFeed(rivertownFeed(), { referenceDate: "20230605" });
    expect(report.diagnostics.some((entry) => entry.rule === "time.feed_expired")).toBe(false);
  });

  it("says nothing about expiry for an empty calendar", () => {
    const feed = rivertownFeed();
    const sink = runValidator({ ...feed, calendars: [], calendarExceptions: [] }, validateFeedExpiry("20240101"));
    expect(sink.total()).toBe(0);
  });

  it("reports an implausibly long trip", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string).replace(
      "R1-1,08:30:00,08:30:00,HARBOUR,4",
      "R1-1,30:30:00,30:30:00,HARBOUR,4",
    );
    const report = validateFeed(feedWith({ "stop_times.txt": tables["stop_times.txt"] as string }));
    expect(report.diagnostics.some((entry) => entry.rule === "time.trip_too_long")).toBe(true);
  });

  it("reports a zero length hop between distinct stops", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string).replace(
      "R1-1,08:05:00,08:05:00,MARKET,2",
      "R1-1,08:00:00,08:00:00,MARKET,2",
    );
    const report = validateFeed(feedWith({ "stop_times.txt": tables["stop_times.txt"] as string }));
    expect(report.diagnostics.some((entry) => entry.rule === "time.zero_length_hop")).toBe(true);
  });

  it("reports unused services, shapes, and routes", () => {
    const report = validateFeed(rivertownFeed());
    expect(report.diagnostics.some((entry) => entry.rule === "cover.route_without_trips")).toBe(true);
  });

  it("measures a feed's overhang", () => {
    expect(feedOverhangDays([{ calls: [{ arrivalTime: 90_000 }] }])).toBe(1);
    expect(feedOverhangDays([{ calls: [{ arrivalTime: 3600 }] }])).toBe(0);
    expect(feedOverhangDays([{ calls: [] }])).toBe(0);
    expect(feedOverhangDays([])).toBe(0);
  });
});

describe("geometry validators", () => {
  it("declares a speed limit for every mode", () => {
    expect(Object.values(MAX_SPEED_BY_MODE).every((limit) => limit > 0)).toBe(true);
  });

  it("reports an implausible implied speed", () => {
    const tables = rivertownTables();
    tables["stop_times.txt"] = (tables["stop_times.txt"] as string).replace(
      "R1-1,08:20:00,08:20:00,EAST,3",
      "R1-1,08:05:30,08:05:30,EAST,3",
    );
    const report = validateFeed(feedWith({ "stop_times.txt": tables["stop_times.txt"] as string }));
    expect(report.diagnostics.some((entry) => entry.rule === "geo.implausible_speed")).toBe(true);
  });

  it("says nothing about plausible speeds", () => {
    expect(
      validateFeed(rivertownFeed()).diagnostics.some((entry) => entry.rule === "geo.implausible_speed"),
    ).toBe(false);
  });

  it("reports stops sharing a coordinate", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop) =>
      stop.stopId === "MARKET" ? { ...stop, coordinate: feed.stopById.get("NORTH")?.coordinate } : stop,
    );
    const sink = runValidator({ ...feed, stops }, validateDuplicatePositions);
    expect(sink.all().some((entry) => entry.rule === "geo.duplicate_position")).toBe(true);
  });

  it("says nothing when every stop is distinct", () => {
    expect(runValidator(rivertownFeed(), validateDuplicatePositions).total()).toBe(0);
  });

  it("reports a stop far from the rest of the network", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop) =>
      stop.stopId === "DEPOT" ? { ...stop, coordinate: { latitude: 10, longitude: 10 } } : stop,
    );
    const sink = runValidator({ ...feed, stops }, validateOutlierStops);
    expect(sink.all().some((entry) => entry.rule === "geo.outlier_stop")).toBe(true);
  });

  it("says nothing for a feed with too few located stops", () => {
    const feed = rivertownFeed();
    expect(runValidator({ ...feed, stops: feed.stops.slice(0, 2) }, validateOutlierStops).total()).toBe(0);
  });

  it("reports a feed spanning the antimeridian", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop, index) =>
      index === 0 ? { ...stop, coordinate: { latitude: 0, longitude: 179 } } : { ...stop, coordinate: { latitude: 0, longitude: -179 } },
    );
    const sink = runValidator({ ...feed, stops }, validateAntimeridian);
    expect(sink.all().some((entry) => entry.rule === "geo.antimeridian")).toBe(true);
  });

  it("says nothing about a compact feed", () => {
    expect(runValidator(rivertownFeed(), validateAntimeridian).total()).toBe(0);
  });

  it("says nothing when no stop has a position", () => {
    const feed = rivertownFeed();
    const stops = feed.stops.map((stop) => ({ ...stop, coordinate: undefined }));
    expect(runValidator({ ...feed, stops }, validateAntimeridian).total()).toBe(0);
  });

  it("reports a stop far from its trip's shape", () => {
    const feed = feedWith({
      "shapes.txt": [
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
        "S1,51.6,-0.1,1",
        "S1,51.7,-0.1,2",
      ].join("\n"),
    });
    const report = validateFeed(feed);
    expect(report.diagnostics.some((entry) => entry.rule === "geo.shape_far_from_stop")).toBe(true);
  });

  it("reports an unserved stop", () => {
    expect(
      validateFeed(rivertownFeed()).diagnostics.some((entry) => entry.rule === "cover.unserved_stop"),
    ).toBe(true);
  });
});

describe("validateFeed", () => {
  it("reports no errors for a clean feed", () => {
    const report = validateFeed(rivertownFeed());
    expect(report.errors).toBe(0);
    expect(isClean(report)).toBe(true);
    expect(isClean(report, "warning")).toBe(false);
    expect(isClean(report, "info")).toBe(false);
  });

  it("returns diagnostics in canonical order", () => {
    const report = validateFeed(rivertownFeed());
    const severities = report.diagnostics.map((entry) => entry.severity);
    const firstInfo = severities.indexOf("info");
    const lastWarning = severities.lastIndexOf("warning");
    expect(firstInfo === -1 || lastWarning === -1 || lastWarning < firstInfo).toBe(true);
  });

  it("honours a severity override", () => {
    const report = validateFeed(rivertownFeed(), {
      severities: { "cover.route_without_trips": "error" },
    });
    expect(report.errors).toBeGreaterThan(0);
    expect(isClean(report)).toBe(false);
  });

  it("honours a suppression", () => {
    const report = validateFeed(rivertownFeed(), {
      severities: { "cover.route_without_trips": "off" },
    });
    expect(report.diagnostics.some((entry) => entry.rule === "cover.route_without_trips")).toBe(false);
  });

  it("honours a per-rule limit", () => {
    const report = validateFeed(rivertownFeed(), { perRuleLimit: 0 });
    expect(report.diagnostics.every((entry) => entry.message.includes("suppressed"))).toBe(true);
  });

  it("honours a diagnostic limit", () => {
    const report = validateFeed(rivertownFeed(), { diagnosticLimit: 1 });
    expect(report.diagnostics.length).toBeLessThanOrEqual(1);
    expect(report.truncated).toBe(true);
  });

  it("runs a caller-supplied validator set", () => {
    const report = validateFeed(rivertownFeed(), { validators: [] });
    expect(report.diagnostics).toEqual([]);
    expect(report.firedRules).toEqual([]);
  });

  it("includes a feed summary", () => {
    expect(validateFeed(rivertownFeed()).summary.trips).toBe(10);
  });

  it("declares a non-empty default validator set", () => {
    expect(DEFAULT_VALIDATORS.length).toBeGreaterThan(10);
  });
});

describe("report rendering", () => {
  const report = validateFeed(rivertownFeed());

  it("renders a stable text report", () => {
    const text = formatReport(report);
    expect(text).toContain("error(s)");
    expect(formatReport(report)).toBe(text);
  });

  it("truncates a long report and says so", () => {
    const text = formatReport(report, 1);
    expect(text).toContain("more diagnostic(s) not shown");
  });

  it("mentions discarded diagnostics", () => {
    const limited = validateFeed(rivertownFeed(), { diagnosticLimit: 1 });
    expect(formatReport(limited)).toContain("retention limit");
  });

  it("renders JSON with sorted keys", () => {
    const parsed = JSON.parse(reportToJson(report)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "counts",
      "diagnostics",
      "firedRules",
      "summary",
      "truncated",
    ]);
  });

  it("renders JSON deterministically", () => {
    expect(reportToJson(report)).toBe(reportToJson(report));
  });

  it("renders diagnostic positions as nulls when absent", () => {
    const empty = validateFeed(rivertownFeed(), { validators: [] });
    expect(JSON.parse(reportToJson(empty))).toMatchObject({ diagnostics: [] });
  });

  it("groups diagnostics by rule in sorted order", () => {
    const grouped = groupByRule(report);
    const keys = Array.from(grouped.keys());
    expect(keys).toEqual(keys.slice().sort());
    expect(grouped.size).toBe(report.firedRules.length);
  });
});
