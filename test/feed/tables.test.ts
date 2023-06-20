import { describe, expect, it } from "vitest";

import { DiagnosticSink } from "../../src/csv/sink.js";
import { commonTimezone, readAgencies } from "../../src/feed/agency.js";
import {
  DEFAULT_ROUTE_COLOR,
  DEFAULT_ROUTE_TEXT_COLOR,
  RouteType,
  compareRoutesForDisplay,
  foldExtendedRouteType,
  readRoutes,
  routeLabel,
  routeTypeName,
  type Route,
} from "../../src/feed/routes.js";
import {
  LocationType,
  WheelchairBoarding,
  groupingIdOf,
  isBoardable,
  readStops,
  stopLabel,
} from "../../src/feed/stops.js";
import { readTrips, tripLabel, tripsByBlock } from "../../src/feed/trips.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { groupByKey, indexByKey, readTable, requireColumns, warnIfEmpty } from "../../src/feed/table.js";
import { table } from "../support/csv.js";

/** Loads one table from inline text, returning its rows and a fresh sink. */
function load(file: string, text: string) {
  const sink = new DiagnosticSink();
  const loaded = readTable(new MemoryFeedSource({ [file]: text }), file, sink);
  if (loaded === undefined) {
    throw new Error("the fixture table failed to tokenise");
  }
  return { loaded, sink };
}

describe("readTable", () => {
  it("returns undefined for an absent table", () => {
    const sink = new DiagnosticSink();
    expect(readTable(new MemoryFeedSource({}), "stops.txt", sink)).toBeUndefined();
    expect(sink.total()).toBe(0);
  });

  it("records a diagnostic rather than throwing for malformed CSV", () => {
    const sink = new DiagnosticSink();
    const result = readTable(new MemoryFeedSource({ "a.txt": 'a,b\n"unterminated' }), "a.txt", sink);
    expect(result).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe("table.unreadable");
  });

  it("records the position of a ragged row", () => {
    const sink = new DiagnosticSink();
    readTable(new MemoryFeedSource({ "a.txt": "a,b\n1" }), "a.txt", sink);
    expect(sink.bySeverity("error")[0]?.position?.line).toBe(2);
  });

  it("honours a ragged row policy", () => {
    const sink = new DiagnosticSink();
    const result = readTable(new MemoryFeedSource({ "a.txt": "a,b\n1" }), "a.txt", sink, {
      raggedRows: "pad",
    });
    expect(result?.rows).toHaveLength(1);
    expect(sink.total()).toBe(0);
  });

  it("honours a cell trimming policy", () => {
    const result = readTable(new MemoryFeedSource({ "a.txt": "a\n  x  " }), "a.txt", new DiagnosticSink(), {
      trimCells: false,
    });
    expect(result?.rows[0]?.get("a")).toBe("  x  ");
  });

  it("recovers the columns of a table with no data rows", () => {
    const { loaded } = load("a.txt", "one,two\n");
    expect(loaded.columns).toEqual(["one", "two"]);
    expect(loaded.rows).toEqual([]);
  });

  it("reports no columns for an entirely empty file", () => {
    const sink = new DiagnosticSink();
    expect(readTable(new MemoryFeedSource({ "a.txt": "" }), "a.txt", sink)).toBeUndefined();
  });
});

describe("table helpers", () => {
  it("reports each missing required column", () => {
    const { loaded } = load("a.txt", "one\n1");
    const sink = new DiagnosticSink();
    expect(requireColumns(loaded, ["one", "two", "three"], sink)).toBe(false);
    expect(sink.count("error")).toBe(2);
  });

  it("accepts a table with every required column", () => {
    const { loaded } = load("a.txt", "one,two\n1,2");
    const sink = new DiagnosticSink();
    expect(requireColumns(loaded, ["one"], sink)).toBe(true);
    expect(sink.total()).toBe(0);
  });

  it("warns about an empty table", () => {
    const { loaded } = load("a.txt", "one\n");
    const sink = new DiagnosticSink();
    warnIfEmpty(loaded, sink);
    expect(sink.bySeverity("warning")[0]?.rule).toBe("table.empty");
  });

  it("does not warn about a populated table", () => {
    const { loaded } = load("a.txt", "one\n1");
    const sink = new DiagnosticSink();
    warnIfEmpty(loaded, sink);
    expect(sink.total()).toBe(0);
  });

  it("keeps the first of two entries sharing a key", () => {
    const sink = new DiagnosticSink();
    const index = indexByKey(
      [
        { id: "a", value: 1 },
        { id: "a", value: 2 },
        { id: "b", value: 3 },
      ],
      (entry) => entry.id,
      "t.txt",
      "thing",
      sink,
    );
    expect(index.get("a")?.value).toBe(1);
    expect(index.size).toBe(2);
    expect(sink.bySeverity("error")[0]?.rule).toBe("table.duplicate_key");
  });

  it("uses a line accessor when indexing", () => {
    const sink = new DiagnosticSink();
    indexByKey(
      [
        { id: "a", line: 5 },
        { id: "a", line: 9 },
      ],
      (entry) => entry.id,
      "t.txt",
      "thing",
      sink,
      (entry) => entry.line,
    );
    expect(sink.bySeverity("error")[0]?.position?.line).toBe(9);
  });

  it("groups entries preserving input order", () => {
    const groups = groupByKey(
      [
        { key: "a", n: 1 },
        { key: "b", n: 2 },
        { key: "a", n: 3 },
      ],
      (entry) => entry.key,
    );
    expect(groups.get("a")?.map((entry) => entry.n)).toEqual([1, 3]);
    expect(groups.get("b")).toHaveLength(1);
  });
});

describe("readAgencies", () => {
  it("reads a single agency without an id column", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(
        ["agency_name", "agency_url", "agency_timezone"],
        [["Tiny", "https://tiny.example", "UTC"]],
      ),
    );
    const agencies = readAgencies(loaded, sink);
    expect(agencies).toHaveLength(1);
    expect(agencies[0]?.agencyId).toBe("");
    expect(agencies[0]?.agencyTimezone).toBe("UTC");
    expect(sink.hasErrors()).toBe(false);
  });

  it("drops a row without a name", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(["agency_name", "agency_url", "agency_timezone"], [["", "https://a.example", "UTC"]]),
    );
    expect(readAgencies(loaded, sink)).toEqual([]);
    expect(sink.hasErrors()).toBe(true);
  });

  it("drops a row with a malformed time zone", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(["agency_name", "agency_url", "agency_timezone"], [["A", "https://a.example", "Not A Zone"]]),
    );
    expect(readAgencies(loaded, sink)).toEqual([]);
  });

  it("requires an id when several agencies are declared", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(
        ["agency_id", "agency_name", "agency_url", "agency_timezone"],
        [
          ["A", "First", "https://a.example", "UTC"],
          ["", "Second", "https://b.example", "UTC"],
        ],
      ),
    );
    const agencies = readAgencies(loaded, sink);
    expect(agencies).toHaveLength(1);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "agency.id_required")).toBe(true);
  });

  it("warns when agencies declare different time zones", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(
        ["agency_id", "agency_name", "agency_url", "agency_timezone"],
        [
          ["A", "First", "https://a.example", "Europe/London"],
          ["B", "Second", "https://b.example", "Europe/Paris"],
        ],
      ),
    );
    const agencies = readAgencies(loaded, sink);
    expect(commonTimezone(agencies)).toBeUndefined();
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "agency.timezone_mismatch")).toBe(true);
  });

  it("reports a shared time zone", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(
        ["agency_id", "agency_name", "agency_url", "agency_timezone"],
        [
          ["A", "First", "https://a.example", "UTC"],
          ["B", "Second", "https://b.example", "UTC"],
        ],
      ),
    );
    expect(commonTimezone(readAgencies(loaded, sink))).toBe("UTC");
  });

  it("reports no time zone for an empty list", () => {
    expect(commonTimezone([])).toBeUndefined();
  });

  it("warns about a malformed URL without dropping the agency", () => {
    const { loaded, sink } = load(
      "agency.txt",
      table(["agency_name", "agency_url", "agency_timezone"], [["A", "a.example", "UTC"]]),
    );
    const agencies = readAgencies(loaded, sink);
    expect(agencies).toHaveLength(1);
    expect(agencies[0]?.agencyUrl).toBeUndefined();
    expect(sink.count("warning")).toBeGreaterThan(0);
  });
});

describe("readStops", () => {
  const header = [
    "stop_id",
    "stop_name",
    "stop_lat",
    "stop_lon",
    "location_type",
    "parent_station",
    "wheelchair_boarding",
  ];

  it("reads a boardable stop", () => {
    const { loaded, sink } = load(
      "stops.txt",
      table(header, [["A", "Alpha", "51.5", "-0.1", "0", "", "1"]]),
    );
    const stops = readStops(loaded, sink);
    expect(stops[0]?.locationType).toBe(LocationType.Stop);
    expect(stops[0]?.wheelchairBoarding).toBe(WheelchairBoarding.Possible);
    expect(isBoardable(stops[0] as never)).toBe(true);
    expect(sink.hasErrors()).toBe(false);
  });

  it("defaults an absent location type to a boardable stop", () => {
    const { loaded, sink } = load(
      "stops.txt",
      table(["stop_id", "stop_name", "stop_lat", "stop_lon"], [["A", "Alpha", "51.5", "-0.1"]]),
    );
    expect(readStops(loaded, sink)[0]?.locationType).toBe(LocationType.Stop);
  });

  it("drops a row without an id", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["", "Alpha", "51.5", "-0.1", "0", "", ""]]));
    expect(readStops(loaded, sink)).toEqual([]);
    expect(sink.hasErrors()).toBe(true);
  });

  it("requires a position for a located type", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["A", "Alpha", "", "", "0", "", ""]]));
    const stops = readStops(loaded, sink);
    expect(stops[0]?.coordinate).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop.position_required")).toBe(true);
  });

  it("does not require a position for a generic node", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["A", "", "", "", "3", "P", ""]]));
    readStops(loaded, sink);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop.position_required")).toBe(false);
  });

  it("requires a name for a located type", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["A", "", "51.5", "-0.1", "0", "", ""]]));
    readStops(loaded, sink);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop.name_required")).toBe(true);
  });

  it("forbids a parent on a station", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["S", "Station", "51.5", "-0.1", "1", "P", ""]]));
    readStops(loaded, sink);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop.parent_forbidden")).toBe(true);
  });

  it("requires a parent on an entrance", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["E", "Entrance", "51.5", "-0.1", "2", "", ""]]));
    readStops(loaded, sink);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop.parent_required")).toBe(true);
  });

  it("warns about a stop at 0,0", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["A", "Alpha", "0", "0", "0", "", ""]]));
    readStops(loaded, sink);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "stop.null_island")).toBe(true);
  });

  it("groups a platform under its parent station", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["P", "Platform", "51.5", "-0.1", "0", "S", ""]]));
    const stop = readStops(loaded, sink)[0];
    expect(groupingIdOf(stop as never)).toBe("S");
  });

  it("groups a parentless stop under itself", () => {
    const { loaded, sink } = load("stops.txt", table(header, [["A", "Alpha", "51.5", "-0.1", "0", "", ""]]));
    expect(groupingIdOf(readStops(loaded, sink)[0] as never)).toBe("A");
  });

  it("labels a stop by name, then code, then id", () => {
    const { loaded, sink } = load(
      "stops.txt",
      table(
        ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type"],
        [
          ["A", "1", "Alpha", "51.5", "-0.1", "0"],
          ["B", "2", "", "51.5", "-0.1", "3"],
          ["C", "", "", "51.5", "-0.1", "3"],
        ],
      ),
    );
    const stops = readStops(loaded, sink);
    expect(stopLabel(stops[0] as never)).toBe("Alpha");
    expect(stopLabel(stops[1] as never)).toBe("2");
    expect(stopLabel(stops[2] as never)).toBe("C");
  });
});

describe("readRoutes", () => {
  const header = ["route_id", "route_short_name", "route_long_name", "route_type"];

  it("reads a route and applies colour defaults", () => {
    const { loaded, sink } = load("routes.txt", table(header, [["R", "1", "Main", "3"]]));
    const route = readRoutes(loaded, sink)[0] as Route;
    expect(route.routeType).toBe(RouteType.Bus);
    expect(route.routeColor).toBe(DEFAULT_ROUTE_COLOR);
    expect(route.routeTextColor).toBe(DEFAULT_ROUTE_TEXT_COLOR);
    expect(route.agencyId).toBe("");
  });

  it("drops a route without an id or type", () => {
    const { loaded, sink } = load(
      "routes.txt",
      table(header, [
        ["", "1", "Main", "3"],
        ["R", "1", "Main", ""],
      ]),
    );
    expect(readRoutes(loaded, sink)).toEqual([]);
  });

  it("requires at least one name", () => {
    const { loaded, sink } = load("routes.txt", table(header, [["R", "", "", "3"]]));
    readRoutes(loaded, sink);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "route.name_required")).toBe(true);
  });

  it("warns when both names repeat the same text", () => {
    const { loaded, sink } = load("routes.txt", table(header, [["R", "Main", "Main", "3"]]));
    readRoutes(loaded, sink);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "route.redundant_name")).toBe(true);
  });

  it("folds an extended route type onto its basic equivalent", () => {
    const { loaded, sink } = load("routes.txt", table(header, [["R", "1", "Main", "109"]]));
    const route = readRoutes(loaded, sink)[0] as Route;
    expect(route.routeType).toBe(RouteType.Rail);
    expect(sink.count("info")).toBeGreaterThan(0);
  });

  it("drops a route with an unrecognised type", () => {
    const { loaded, sink } = load("routes.txt", table(header, [["R", "1", "Main", "600"]]));
    expect(readRoutes(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "route.extended_type")).toBe(true);
  });

  it("maps every extended block it recognises", () => {
    expect(foldExtendedRouteType(105)).toBe(RouteType.Rail);
    expect(foldExtendedRouteType(200)).toBe(RouteType.Bus);
    expect(foldExtendedRouteType(401)).toBe(RouteType.Subway);
    expect(foldExtendedRouteType(700)).toBe(RouteType.Bus);
    expect(foldExtendedRouteType(800)).toBe(RouteType.Trolleybus);
    expect(foldExtendedRouteType(900)).toBe(RouteType.Tram);
    expect(foldExtendedRouteType(1000)).toBe(RouteType.Ferry);
    expect(foldExtendedRouteType(1100)).toBe(RouteType.AerialLift);
    expect(foldExtendedRouteType(1200)).toBe(RouteType.Ferry);
    expect(foldExtendedRouteType(1300)).toBe(RouteType.AerialLift);
    expect(foldExtendedRouteType(1400)).toBe(RouteType.Funicular);
    expect(foldExtendedRouteType(1500)).toBeUndefined();
    expect(foldExtendedRouteType(300)).toBeUndefined();
  });

  it("names every basic route type", () => {
    const names = [
      RouteType.Tram,
      RouteType.Subway,
      RouteType.Rail,
      RouteType.Bus,
      RouteType.Ferry,
      RouteType.CableTram,
      RouteType.AerialLift,
      RouteType.Funicular,
      RouteType.Trolleybus,
      RouteType.Monorail,
    ].map(routeTypeName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("bus");
  });

  it("labels a route by short name, then long name, then id", () => {
    const { loaded, sink } = load(
      "routes.txt",
      table(header, [
        ["A", "1", "Main", "3"],
        ["B", "", "Long only", "3"],
      ]),
    );
    const routes = readRoutes(loaded, sink);
    expect(routeLabel(routes[0] as Route)).toBe("1");
    expect(routeLabel(routes[1] as Route)).toBe("Long only");
  });
});

describe("compareRoutesForDisplay", () => {
  const build = (rows: string[][]): Route[] => {
    const { loaded, sink } = load(
      "routes.txt",
      table(["route_id", "route_short_name", "route_type", "route_sort_order"], rows),
    );
    return readRoutes(loaded, sink);
  };

  it("honours an explicit sort order", () => {
    const routes = build([
      ["A", "9", "3", "2"],
      ["B", "1", "3", "1"],
    ]);
    expect(routes.slice().sort(compareRoutesForDisplay).map((route) => route.routeId)).toEqual(["B", "A"]);
  });

  it("puts routes without a sort order last", () => {
    const routes = build([
      ["A", "1", "3", ""],
      ["B", "2", "3", "1"],
    ]);
    expect(routes.slice().sort(compareRoutesForDisplay).map((route) => route.routeId)).toEqual(["B", "A"]);
  });

  it("compares numbered routes numerically", () => {
    const routes = build([
      ["A", "10", "3", ""],
      ["B", "9", "3", ""],
    ]);
    expect(routes.slice().sort(compareRoutesForDisplay).map((route) => route.routeId)).toEqual(["B", "A"]);
  });

  it("sorts numbered routes before named ones", () => {
    const routes = build([
      ["A", "Circle", "3", ""],
      ["B", "7", "3", ""],
    ]);
    expect(routes.slice().sort(compareRoutesForDisplay).map((route) => route.routeId)).toEqual(["B", "A"]);
  });

  it("falls back to the route id for identical labels", () => {
    const routes = build([
      ["B", "1", "3", ""],
      ["A", "1", "3", ""],
    ]);
    expect(routes.slice().sort(compareRoutesForDisplay).map((route) => route.routeId)).toEqual(["A", "B"]);
  });
});

describe("readTrips", () => {
  const header = ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "block_id"];

  it("reads a trip", () => {
    const { loaded, sink } = load("trips.txt", table(header, [["R", "S", "T", "Somewhere", "0", ""]]));
    const trip = readTrips(loaded, sink)[0];
    expect(trip?.tripId).toBe("T");
    expect(trip?.directionId).toBe(0);
    expect(sink.hasErrors()).toBe(false);
  });

  it("drops a trip missing any required id", () => {
    const { loaded, sink } = load(
      "trips.txt",
      table(header, [
        ["", "S", "T", "", "", ""],
        ["R", "", "T", "", "", ""],
        ["R", "S", "", "", "", ""],
      ]),
    );
    expect(readTrips(loaded, sink)).toEqual([]);
  });

  it("notes a block without a direction", () => {
    const { loaded, sink } = load("trips.txt", table(header, [["R", "S", "T", "", "", "BLK"]]));
    readTrips(loaded, sink);
    expect(sink.bySeverity("info").some((entry) => entry.rule === "trip.block_without_direction")).toBe(true);
  });

  it("labels a trip by headsign, then short name, then id", () => {
    const { loaded, sink } = load(
      "trips.txt",
      table(
        ["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name"],
        [
          ["R", "S", "A", "Head", "Short"],
          ["R", "S", "B", "", "Short"],
          ["R", "S", "C", "", ""],
        ],
      ),
    );
    const trips = readTrips(loaded, sink);
    expect(tripLabel(trips[0] as never)).toBe("Head");
    expect(tripLabel(trips[1] as never)).toBe("Short");
    expect(tripLabel(trips[2] as never)).toBe("C");
  });

  it("groups trips by block, ignoring those without one", () => {
    const { loaded, sink } = load(
      "trips.txt",
      table(header, [
        ["R", "S", "A", "", "0", "BLK"],
        ["R", "S", "B", "", "0", "BLK"],
        ["R", "S", "C", "", "0", ""],
      ]),
    );
    const blocks = tripsByBlock(readTrips(loaded, sink));
    expect(blocks.size).toBe(1);
    expect(blocks.get("BLK")?.map((trip) => trip.tripId)).toEqual(["A", "B"]);
  });
});
