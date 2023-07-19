import { describe, expect, it } from "vitest";

import { MeridianError, NetworkBuildError, UnknownStopError } from "../../src/errors.js";
import { coordinate } from "../../src/geo/coordinate.js";
import { LocationType } from "../../src/feed/stops.js";
import {
  Interner,
  NO_INDEX,
  isIndex,
  patternIndex,
  stopIndex,
  tripIndex,
} from "../../src/model/ids.js";
import { StopCatalogue } from "../../src/model/stop-index.js";
import {
  allowsAlightingAt,
  allowsBoardingAt,
  buildPatterns,
  indexPatternsByStop,
  isLoop,
  patternKeyOf,
  positionOf,
  positionsOf,
  type RoutePattern,
} from "../../src/model/route-pattern.js";
import { PatternTimetable } from "../../src/model/timetable.js";
import {
  DEFAULT_MAX_WALK_METRES,
  TransferGraph,
} from "../../src/model/transfer-graph.js";
import { assertNetworkConsistent, buildNetwork } from "../../src/model/builder.js";
import {
  RUN_SEPARATOR,
  expandFrequencies,
  isGeneratedRun,
  templateTripIdOf,
} from "../../src/model/frequency-expansion.js";
import { minimalFeed, rivertownFeed, rivertownNetwork } from "../support/fixtures.js";

describe("Interner", () => {
  it("assigns indices in first-seen order", () => {
    const interner = new Interner();
    expect(interner.intern("b")).toBe(0);
    expect(interner.intern("a")).toBe(1);
    expect(interner.intern("b")).toBe(0);
    expect(interner.size).toBe(2);
  });

  it("looks ids up in both directions", () => {
    const interner = new Interner();
    interner.intern("x");
    expect(interner.indexOf("x")).toBe(0);
    expect(interner.idAt(0)).toBe("x");
    expect(interner.indexOf("y")).toBeUndefined();
    expect(interner.has("x")).toBe(true);
    expect(interner.has("y")).toBe(false);
  });

  it("lists ids in index order", () => {
    const interner = new Interner();
    interner.intern("b");
    interner.intern("a");
    expect(interner.ids()).toEqual(["b", "a"]);
  });

  it("throws for an index it never assigned", () => {
    expect(() => new Interner().idAt(3)).toThrow(MeridianError);
  });
});

describe("index brands", () => {
  it("wrap plain numbers", () => {
    expect(stopIndex(3)).toBe(3);
    expect(patternIndex(4)).toBe(4);
    expect(tripIndex(5)).toBe(5);
  });

  it("recognise the absent sentinel", () => {
    expect(isIndex(0)).toBe(true);
    expect(isIndex(NO_INDEX)).toBe(false);
  });
});

describe("StopCatalogue", () => {
  const catalogue = StopCatalogue.build(rivertownFeed().stops);

  it("indexes stops in ascending id order", () => {
    const ids = catalogue.allIndices().map((index) => catalogue.idAt(index));
    expect(ids).toEqual(ids.slice().sort());
  });

  it("counts every stop, boardable or not", () => {
    expect(catalogue.count).toBe(10);
    expect(catalogue.boardableIndices()).toHaveLength(9);
  });

  it("resolves ids to indices and back", () => {
    const index = catalogue.indexOf("CENTRAL_A");
    expect(index).toBeDefined();
    expect(catalogue.idAt(index as never)).toBe("CENTRAL_A");
    expect(catalogue.indexOf("NOPE")).toBeUndefined();
  });

  it("exposes the stop record and its label", () => {
    const index = catalogue.indexOf("MARKET") as never;
    expect(catalogue.stopAt(index).stopName).toBe("Market Square");
    expect(catalogue.labelAt(index)).toBe("Market Square");
    expect(catalogue.coordinateAt(index)).toBeDefined();
  });

  it("throws for an out of range index", () => {
    expect(() => catalogue.stopAt(999 as never)).toThrow(/no stop at index/);
  });

  it("reports boardability", () => {
    expect(catalogue.isBoardable(catalogue.indexOf("CENTRAL_A") as never)).toBe(true);
    expect(catalogue.isBoardable(catalogue.indexOf("CENTRAL") as never)).toBe(false);
  });

  it("links platforms to their station", () => {
    const station = catalogue.indexOf("CENTRAL") as never;
    const platform = catalogue.indexOf("CENTRAL_A") as never;
    expect(catalogue.parentOf(platform)).toBe(station);
    expect(catalogue.parentOf(station)).toBeUndefined();
    expect(catalogue.childrenOf(station)).toHaveLength(2);
    expect(catalogue.childrenOf(platform)).toEqual([]);
  });

  it("groups a platform with its siblings", () => {
    const platform = catalogue.indexOf("CENTRAL_A") as never;
    const siblings = catalogue.siblingsOf(platform).map((index) => catalogue.idAt(index));
    expect(siblings.sort()).toEqual(["CENTRAL", "CENTRAL_A", "CENTRAL_B"]);
  });

  it("groups a station with its children", () => {
    const station = catalogue.indexOf("CENTRAL") as never;
    expect(catalogue.siblingsOf(station)).toHaveLength(3);
  });

  it("treats a stop with no parent or children as its own group", () => {
    const lone = catalogue.indexOf("MARKET") as never;
    expect(catalogue.siblingsOf(lone)).toEqual([lone]);
  });

  it("expands a station to its boardable platforms", () => {
    const station = catalogue.indexOf("CENTRAL") as never;
    const points = catalogue.boardingPointsOf(station).map((index) => catalogue.idAt(index));
    expect(points.sort()).toEqual(["CENTRAL_A", "CENTRAL_B"]);
  });

  it("resolves a platform to itself", () => {
    const platform = catalogue.indexOf("CENTRAL_A") as never;
    expect(catalogue.boardingPointsOf(platform)).toEqual([platform]);
  });

  it("finds nearby stops", () => {
    const point = coordinate(51.5, -0.1);
    const nearby = catalogue.nearby(point, 500).map((match) => catalogue.idAt(match.value));
    expect(nearby).toContain("CENTRAL_A");
    expect(nearby).toContain("CENTRAL_B");
    expect(nearby).not.toContain("HARBOUR");
  });

  it("finds the nearest few stops", () => {
    expect(catalogue.nearest(coordinate(51.5, -0.1), 2, 1000)).toHaveLength(2);
  });

  it("reports the bounding box of located stops", () => {
    expect(catalogue.boundingBox).toBeDefined();
    expect(catalogue.boundingBox?.minLatitude).toBeCloseTo(51.48, 4);
  });

  it("copes with a feed whose stops have no coordinates", () => {
    const empty = StopCatalogue.build([
      {
        stopId: "A",
        stopCode: undefined,
        stopName: "Alpha",
        stopDesc: undefined,
        coordinate: undefined,
        zoneId: undefined,
        stopUrl: undefined,
        locationType: LocationType.GenericNode,
        parentStation: undefined,
        stopTimezone: undefined,
        wheelchairBoarding: 0,
        platformCode: undefined,
        levelId: undefined,
        line: 2,
      },
    ]);
    expect(empty.boundingBox).toBeUndefined();
    expect(empty.nearby(coordinate(0, 0), 100)).toEqual([]);
  });

  it("treats a dangling parent reference as no parent", () => {
    const catalogueWithGhost = StopCatalogue.build([
      {
        stopId: "A",
        stopCode: undefined,
        stopName: "Alpha",
        stopDesc: undefined,
        coordinate: coordinate(0, 0),
        zoneId: undefined,
        stopUrl: undefined,
        locationType: LocationType.Stop,
        parentStation: "GHOST",
        stopTimezone: undefined,
        wheelchairBoarding: 0,
        platformCode: undefined,
        levelId: undefined,
        line: 2,
      },
    ]);
    expect(catalogueWithGhost.parentOf(stopIndex(0))).toBeUndefined();
  });
});

describe("route patterns", () => {
  const feed = rivertownFeed();
  const catalogue = StopCatalogue.build(feed.stops);
  const { patterns, skippedTripIds } = buildPatterns(feed.trips, catalogue);

  it("groups trips sharing a stop sequence", () => {
    const r1 = patterns.find((pattern) => pattern.routeId === "R1");
    expect(r1?.tripIds).toHaveLength(4);
    expect(r1?.stops).toHaveLength(4);
  });

  it("skips no trip in a clean feed", () => {
    expect(skippedTripIds).toEqual([]);
  });

  it("assigns pattern indices matching array position", () => {
    patterns.forEach((pattern, index) => expect(pattern.index).toBe(index));
  });

  it("orders each pattern's trips by first departure", () => {
    const r1 = patterns.find((pattern) => pattern.routeId === "R1") as RoutePattern;
    expect(r1.tripIds).toEqual(["R1-1", "R1-2", "R1-3", "R1-W1"]);
  });

  it("reports a shared direction and headsign", () => {
    const r1 = patterns.find((pattern) => pattern.routeId === "R1") as RoutePattern;
    expect(r1.directionId).toBe(0);
    expect(r1.headsign).toBe("Harbour");
  });

  it("reports no shared headsign when trips disagree", () => {
    const r2 = patterns.find((pattern) => pattern.routeId === "R2") as RoutePattern;
    expect(r2.headsign).toBeUndefined();
  });

  it("locates stops within a pattern", () => {
    const r1 = patterns.find((pattern) => pattern.routeId === "R1") as RoutePattern;
    const market = catalogue.indexOf("MARKET") as never;
    expect(positionOf(r1, market)).toBe(1);
    expect(positionsOf(r1, market)).toEqual([1]);
    expect(positionOf(r1, catalogue.indexOf("NORTH") as never)).toBe(-1);
  });

  it("reports a pattern that never repeats a stop as not a loop", () => {
    expect(patterns.every((pattern) => !isLoop(pattern))).toBe(true);
  });

  it("forbids boarding at the last stop and alighting at the first", () => {
    const r1 = patterns.find((pattern) => pattern.routeId === "R1") as RoutePattern;
    expect(allowsBoardingAt(r1, 0)).toBe(true);
    expect(allowsBoardingAt(r1, r1.stops.length - 1)).toBe(false);
    expect(allowsAlightingAt(r1, 0)).toBe(false);
    expect(allowsAlightingAt(r1, 1)).toBe(true);
  });

  it("indexes patterns by the stops they call at", () => {
    const byStop = indexPatternsByStop(patterns, catalogue.count);
    const centralA = catalogue.indexOf("CENTRAL_A") as number;
    expect((byStop[centralA] as readonly number[]).length).toBeGreaterThan(1);
    const depot = catalogue.indexOf("DEPOT") as number;
    expect(byStop[depot]).toEqual([]);
  });

  it("computes a key that includes boarding permissions", () => {
    const trip = feed.tripById.get("R1-1");
    const key = patternKeyOf("R1", trip?.calls ?? [], catalogue);
    expect(key).toContain("R1");
    expect(key).toContain(":0:0");
  });

  it("returns no key when a call names an unknown stop", () => {
    const trip = feed.tripById.get("R1-1");
    const emptyCatalogue = StopCatalogue.build([]);
    expect(patternKeyOf("R1", trip?.calls ?? [], emptyCatalogue)).toBeUndefined();
  });

  it("skips trips whose calls reference unknown stops", () => {
    const emptyCatalogue = StopCatalogue.build([]);
    const result = buildPatterns(feed.trips, emptyCatalogue);
    expect(result.patterns).toEqual([]);
    expect(result.skippedTripIds).toHaveLength(feed.trips.length);
  });
});

describe("PatternTimetable", () => {
  const feed = rivertownFeed();
  const catalogue = StopCatalogue.build(feed.stops);
  const { patterns } = buildPatterns(feed.trips, catalogue);
  const r1 = patterns.find((pattern) => pattern.routeId === "R1") as RoutePattern;
  const timetable = PatternTimetable.build(r1, feed.tripById);
  const always = () => true;

  it("stores each trip's times", () => {
    expect(timetable.tripCount).toBe(4);
    expect(timetable.stopCount).toBe(4);
    expect(timetable.departureAt(tripIndex(0), 0)).toBe(8 * 3600);
    expect(timetable.arrivalAt(tripIndex(0), 3)).toBe(8 * 3600 + 30 * 60);
  });

  it("exposes trip and service ids", () => {
    expect(timetable.tripIdAt(tripIndex(0))).toBe("R1-1");
    expect(timetable.serviceIdAt(tripIndex(0))).toBe("WEEKDAY");
  });

  it("detects a totally ordered pattern", () => {
    expect(timetable.isTotallyOrdered).toBe(true);
  });

  it("finds the earliest trip after a time", () => {
    expect(timetable.earliestTripAfter(0, 8 * 3600 + 1, always)).toBe(1);
    expect(timetable.earliestTripAfter(0, 0, always)).toBe(0);
  });

  it("returns undefined when nothing departs late enough", () => {
    expect(timetable.earliestTripAfter(0, 23 * 3600, always)).toBeUndefined();
  });

  it("returns undefined for an out of range position", () => {
    expect(timetable.earliestTripAfter(-1, 0, always)).toBeUndefined();
    expect(timetable.earliestTripAfter(99, 0, always)).toBeUndefined();
    expect(timetable.latestTripBefore(99, 0, always)).toBeUndefined();
  });

  it("honours a trip filter", () => {
    const onlyWeekend = (trip: number) => timetable.serviceIdAt(trip as never) === "WEEKEND";
    expect(timetable.tripIdAt(timetable.earliestTripAfter(0, 0, onlyWeekend as never) as never)).toBe(
      "R1-W1",
    );
  });

  it("finds the latest trip arriving at or before a time", () => {
    // R1-2 reaches the final stop at exactly 09:00, so it qualifies.
    expect(timetable.tripIdAt(timetable.latestTripBefore(3, 9 * 3600, always) as never)).toBe("R1-2");
    expect(
      timetable.tripIdAt(timetable.latestTripBefore(3, 9 * 3600 - 1, always) as never),
    ).toBe("R1-1");
  });

  it("returns undefined when nothing arrives early enough", () => {
    expect(timetable.latestTripBefore(3, 0, always)).toBeUndefined();
  });

  it("reports the earliest departure and latest arrival", () => {
    expect(timetable.earliestDeparture(0)).toBe(8 * 3600);
    expect(timetable.latestArrival(3)).toBe(10 * 3600 + 40 * 60);
  });

  it("rejects a pattern naming an unknown trip", () => {
    const broken: RoutePattern = { ...r1, tripIds: ["GHOST"] };
    expect(() => PatternTimetable.build(broken, feed.tripById)).toThrow(NetworkBuildError);
  });

  it("rejects a trip whose call count disagrees with the pattern", () => {
    const broken: RoutePattern = { ...r1, stops: r1.stops.slice(0, 2), pickup: r1.pickup.slice(0, 2), dropOff: r1.dropOff.slice(0, 2) };
    expect(() => PatternTimetable.build(broken, feed.tripById)).toThrow(/calls but its pattern/);
  });

  it("reports an empty timetable's extremes as undefined", () => {
    const empty = PatternTimetable.build({ ...r1, tripIds: [] }, feed.tripById);
    expect(empty.earliestDeparture(0)).toBeUndefined();
    expect(empty.latestArrival(0)).toBeUndefined();
    expect(empty.earliestTripAfter(0, 0, always)).toBeUndefined();
  });
});

describe("TransferGraph", () => {
  const feed = rivertownFeed();
  const catalogue = StopCatalogue.build(feed.stops);

  it("generates footpaths between nearby stops", () => {
    const graph = TransferGraph.build(catalogue, []);
    const centralA = catalogue.indexOf("CENTRAL_A") as never;
    const neighbours = graph.neighbours(centralA).map((index) => catalogue.idAt(index));
    expect(neighbours).toContain("CENTRAL_B");
    expect(neighbours).not.toContain("HARBOUR");
  });

  it("orders footpaths by walk time", () => {
    const graph = TransferGraph.build(catalogue, []);
    const edges = graph.from(catalogue.indexOf("CENTRAL_A") as never);
    for (let index = 1; index < edges.length; index += 1) {
      expect((edges[index] as never as { seconds: number }).seconds).toBeGreaterThanOrEqual(
        (edges[index - 1] as never as { seconds: number }).seconds,
      );
    }
  });

  it("lets a published transfer override a generated walk", () => {
    const graph = TransferGraph.build(catalogue, feed.transfers);
    const seconds = graph.secondsBetween(
      catalogue.indexOf("CENTRAL_B") as never,
      catalogue.indexOf("CENTRAL_A") as never,
    );
    expect(seconds).toBe(60);
    expect(
      graph.from(catalogue.indexOf("CENTRAL_B") as never).find((edge) => edge.seconds === 60)?.published,
    ).toBe(true);
  });

  it("removes a forbidden interchange", () => {
    const graph = TransferGraph.build(catalogue, [
      {
        fromStopId: "CENTRAL_A",
        toStopId: "CENTRAL_B",
        transferType: 3,
        minTransferTime: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
        line: 2,
      },
    ]);
    expect(
      graph.secondsBetween(catalogue.indexOf("CENTRAL_A") as never, catalogue.indexOf("CENTRAL_B") as never),
    ).toBeUndefined();
  });

  it("ignores a transfer naming an unknown stop", () => {
    const graph = TransferGraph.build(catalogue, [
      {
        fromStopId: "GHOST",
        toStopId: "CENTRAL_B",
        transferType: 2,
        minTransferTime: 30,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
        line: 2,
      },
    ]);
    expect(graph.edgeCount).toBeGreaterThan(0);
  });

  it("ignores a trip-scoped rule with no stop endpoints", () => {
    const graph = TransferGraph.build(catalogue, [
      {
        fromStopId: undefined,
        toStopId: undefined,
        transferType: 4,
        minTransferTime: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: "A",
        toTripId: "B",
        line: 2,
      },
    ]);
    expect(graph.edgeCount).toBeGreaterThan(0);
  });

  it("produces no footpaths with a zero walk radius", () => {
    const graph = TransferGraph.build(catalogue, [], { maxWalkMetres: 0 });
    expect(graph.edgeCount).toBe(0);
  });

  it("builds an empty graph on request", () => {
    const graph = TransferGraph.empty(catalogue.count);
    expect(graph.edgeCount).toBe(0);
    expect(graph.stopCount).toBe(catalogue.count);
    expect(graph.from(stopIndex(0))).toEqual([]);
  });

  it("closes the relation transitively", () => {
    // MARKET is within walking distance of both platforms, and the platforms of
    // each other, so closure should not add anything unreachable.
    const closed = TransferGraph.build(catalogue, [], { transitiveClosure: true });
    const open = TransferGraph.build(catalogue, [], { transitiveClosure: false });
    expect(closed.edgeCount).toBeGreaterThanOrEqual(open.edgeCount);
  });

  it("respects the transfer time ceiling", () => {
    const graph = TransferGraph.build(catalogue, [], { maxTransferSeconds: 1 });
    expect(graph.edgeCount).toBe(0);
  });

  it("rejects invalid options", () => {
    expect(() => TransferGraph.build(catalogue, [], { maxWalkMetres: -1 })).toThrow(NetworkBuildError);
    expect(() => TransferGraph.build(catalogue, [], { boardingSlackSeconds: -1 })).toThrow(
      NetworkBuildError,
    );
  });

  it("uses a documented default walking radius", () => {
    expect(DEFAULT_MAX_WALK_METRES).toBeGreaterThan(100);
  });
});

describe("frequency expansion", () => {
  it("leaves a feed with no frequencies untouched", () => {
    const feed = minimalFeed();
    const result = expandFrequencies(feed);
    expect(result.feed).toBe(feed);
    expect(result.runs.size).toBe(0);
  });

  it("replaces a template with its generated runs", () => {
    const result = expandFrequencies(rivertownFeed());
    expect(result.feed.tripById.has("R4-T")).toBe(false);
    expect(result.feed.tripById.has("R4-T#0")).toBe(true);
    expect(result.runs.size).toBe(4);
  });

  it("shifts each run's times by its departure offset", () => {
    const result = expandFrequencies(rivertownFeed());
    expect(result.feed.tripById.get("R4-T#0")?.calls[0]?.departureTime).toBe(6 * 3600);
    expect(result.feed.tripById.get("R4-T#1")?.calls[0]?.departureTime).toBe(6 * 3600 + 900);
    expect(result.feed.tripById.get("R4-T#1")?.calls[1]?.arrivalTime).toBe(6 * 3600 + 900 + 12 * 60);
  });

  it("records an expected wait of zero for exact times", () => {
    const result = expandFrequencies(rivertownFeed());
    expect(result.runs.get("R4-T#0")?.expectedWaitSeconds).toBe(0);
  });

  it("records half a headway for headway-based service", () => {
    const feed = rivertownFeed({
      "frequencies.txt":
        "trip_id,start_time,end_time,headway_secs,exact_times\nR4-T,06:00:00,06:30:00,600,0",
    });
    const result = expandFrequencies(feed);
    expect(result.runs.get("R4-T#0")?.expectedWaitSeconds).toBe(300);
  });

  it("keeps generated trips sorted by id", () => {
    const ids = expandFrequencies(rivertownFeed()).feed.trips.map((trip) => trip.tripId);
    expect(ids).toEqual(ids.slice().sort());
  });

  it("recognises and unwraps a generated run id", () => {
    expect(isGeneratedRun(`T${RUN_SEPARATOR}3`)).toBe(true);
    expect(isGeneratedRun("T")).toBe(false);
    expect(templateTripIdOf(`T${RUN_SEPARATOR}3`)).toBe("T");
    expect(templateTripIdOf("T")).toBe("T");
  });

  it("rejects a run that would leave the representable time range", () => {
    const feed = rivertownFeed({
      "frequencies.txt":
        "trip_id,start_time,end_time,headway_secs,exact_times\nR4-T,167:00:00,168:00:00,600,1",
    });
    expect(() => expandFrequencies(feed)).toThrow(NetworkBuildError);
  });
});

describe("buildNetwork", () => {
  it("compiles a consistent network", () => {
    const built = buildNetwork(rivertownFeed());
    expect(() => assertNetworkConsistent(built.network)).not.toThrow();
    expect(built.network.statistics().patterns).toBeGreaterThan(3);
  });

  it("resolves stops, patterns, and routes", () => {
    const network = rivertownNetwork();
    const stop = network.requireStop("CENTRAL_A");
    expect(network.stops.idAt(stop)).toBe("CENTRAL_A");
    expect(network.stopById("CENTRAL_A")?.stopName).toBe("Central Platform A");
    expect(network.stopById("NOPE")).toBeUndefined();
    expect(() => network.requireStop("NOPE")).toThrow(UnknownStopError);

    const pattern = network.patternsAt(stop)[0] as never;
    expect(network.routeFor(pattern)).toBeDefined();
    expect(network.timetableFor(pattern).tripCount).toBeGreaterThan(0);
  });

  it("collects the patterns of several stops without repeats", () => {
    const network = rivertownNetwork();
    const stops = [network.requireStop("CENTRAL_A"), network.requireStop("CENTRAL_B")];
    const patterns = network.patternsAtAny(stops);
    expect(new Set(patterns).size).toBe(patterns.length);
    expect(patterns).toEqual(patterns.slice().sort((a, b) => a - b));
  });

  it("measures the feed's past-midnight overhang", () => {
    expect(rivertownNetwork().overhangDays).toBe(1);
    expect(buildNetwork(minimalFeed()).network.overhangDays).toBe(0);
  });

  it("reports frequency windows for a template trip", () => {
    const network = rivertownNetwork();
    expect(network.frequenciesFor("R4-T")).toHaveLength(1);
    expect(network.isFrequencyBased("R4-T")).toBe(true);
    expect(network.isFrequencyBased("R1-1")).toBe(false);
  });

  it("can be built without generated footpaths", () => {
    const built = buildNetwork(rivertownFeed(), { generateFootpaths: false });
    const centralA = built.network.requireStop("CENTRAL_A");
    // Only the published transfer survives.
    expect(built.network.transfers.neighbours(centralA)).toHaveLength(1);
  });

  it("can be built without expanding frequencies", () => {
    const built = buildNetwork(rivertownFeed(), { expandFrequencies: false });
    expect(built.generatedRuns.size).toBe(0);
    expect(built.network.feed.tripById.has("R4-T")).toBe(true);
  });

  it("reports an isolated served stop", () => {
    const built = buildNetwork(rivertownFeed(), { generateFootpaths: false });
    expect(built.diagnostics.bySeverity("info").some((entry) => entry.rule === "build.isolated_stop")).toBe(
      true,
    );
  });

  it("warns when a feed yields no patterns", () => {
    const feed = rivertownFeed();
    const built = buildNetwork({ ...feed, trips: [], tripById: new Map() });
    expect(built.diagnostics.bySeverity("warning").some((entry) => entry.rule === "build.no_patterns")).toBe(
      true,
    );
  });

  it("reports a trip excluded for naming an unknown stop", () => {
    const feed = rivertownFeed();
    const built = buildNetwork({ ...feed, stops: [] });
    expect(built.diagnostics.bySeverity("error").some((entry) => entry.rule === "build.trip_skipped")).toBe(
      true,
    );
  });

  it("reports network statistics", () => {
    const statistics = rivertownNetwork().statistics();
    expect(statistics.stops).toBe(10);
    expect(statistics.boardableStops).toBe(9);
    expect(statistics.trips).toBeGreaterThan(10);
    expect(statistics.footpaths).toBeGreaterThan(0);
    expect(statistics.overtakingPatterns).toBe(0);
  });

  it("reports the network bounding box", () => {
    expect(rivertownNetwork().boundingBox).toBeDefined();
  });

  it("finds stops near a point", () => {
    expect(rivertownNetwork().stopsNear(coordinate(51.5, -0.1), 500).length).toBeGreaterThan(1);
  });
});

describe("assertNetworkConsistent", () => {
  const network = rivertownNetwork();

  it("rejects mismatched pattern and timetable counts", () => {
    const broken = Object.create(network) as typeof network;
    Object.defineProperty(broken, "timetables", { value: [], enumerable: true });
    expect(() => assertNetworkConsistent(broken)).toThrow(/counts disagree/);
  });

  it("rejects a pattern whose index does not match its position", () => {
    const broken = Object.create(network) as typeof network;
    const patterns = network.patterns.map((pattern) => ({ ...pattern, index: 99 as never }));
    Object.defineProperty(broken, "patterns", { value: patterns, enumerable: true });
    expect(() => assertNetworkConsistent(broken)).toThrow(/reports index/);
  });

  it("rejects a pattern with fewer than two stops", () => {
    const broken = Object.create(network) as typeof network;
    const patterns = network.patterns.map((pattern, index) =>
      index === 0 ? { ...pattern, stops: pattern.stops.slice(0, 1) } : pattern,
    );
    Object.defineProperty(broken, "patterns", { value: patterns, enumerable: true });
    expect(() => assertNetworkConsistent(broken)).toThrow(/fewer than 2 stops/);
  });

  it("rejects mismatched boarding rule arrays", () => {
    const broken = Object.create(network) as typeof network;
    const patterns = network.patterns.map((pattern, index) =>
      index === 0 ? { ...pattern, pickup: pattern.pickup.slice(0, 1) } : pattern,
    );
    Object.defineProperty(broken, "patterns", { value: patterns, enumerable: true });
    expect(() => assertNetworkConsistent(broken)).toThrow(/boarding rule arrays/);
  });

  it("rejects a pattern referencing an out of range stop", () => {
    const broken = Object.create(network) as typeof network;
    const patterns = network.patterns.map((pattern, index) =>
      index === 0
        ? { ...pattern, stops: pattern.stops.map(() => 999 as never) }
        : pattern,
    );
    Object.defineProperty(broken, "patterns", { value: patterns, enumerable: true });
    expect(() => assertNetworkConsistent(broken)).toThrow(/out of range stop/);
  });
});
