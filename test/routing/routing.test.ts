import { describe, expect, it } from "vitest";

import { QueryError, RoutingError, UnknownStopError } from "../../src/errors.js";
import { ServiceDate } from "../../src/time/date.js";
import { parseTimeOfDay } from "../../src/time/time-of-day.js";
import { coordinate } from "../../src/geo/coordinate.js";
import { RouteType } from "../../src/feed/routes.js";
import { stopIndex } from "../../src/model/ids.js";
import { TransferGraph } from "../../src/model/transfer-graph.js";
import {
  DEFAULT_MAX_BOARDINGS,
  DEFAULT_MAX_JOURNEY_SECONDS,
  DEFAULT_MIN_TRANSFER_SECONDS,
  MAX_ACCESS_STOPS,
  hasTripFilters,
  normaliseQuery,
  resolvePlace,
  searchHorizon,
  tripPermitted,
  type JourneyQuery,
} from "../../src/routing/query.js";
import { DayScanner } from "../../src/routing/day-scan.js";
import { LabelSet, MarkedStops, UNREACHED } from "../../src/routing/labels.js";
import { bestDestinationArrival, relaxFootpaths, seedOrigins } from "../../src/routing/footpath.js";
import { MAX_ROUNDS, collectPatternQueue, runRaptor } from "../../src/routing/raptor.js";
import {
  extractBestJourney,
  extractJourneys,
  journeyKey,
  rideSeconds,
  waitSeconds,
  walkSeconds,
} from "../../src/routing/result.js";
import {
  compareCriteria,
  diversify,
  dominates,
  paretoFrontier,
  profileDominates,
  profileFrontier,
  profileStrictlyDominates,
  strictlyDominates,
  type Criteria,
  type ProfileCriteria,
} from "../../src/routing/pareto.js";
import {
  DEFAULT_MAX_DEPARTURES,
  candidateDepartures,
  departureBoard,
  runRangeRaptor,
} from "../../src/routing/range-raptor.js";
import { MONDAY, minimalNetwork, rivertownNetwork } from "../support/fixtures.js";

const network = rivertownNetwork();

const baseRequest = {
  from: { kind: "stop" as const, stopId: "NORTH" },
  to: { kind: "stop" as const, stopId: "HARBOUR" },
  date: MONDAY,
  departAfter: "07:45:00",
};

describe("normaliseQuery", () => {
  it("resolves stop ids to indices", () => {
    const query = normaliseQuery(network, baseRequest);
    expect(query.origins).toHaveLength(1);
    expect(network.stops.idAt(query.origins[0]?.stop as never)).toBe("NORTH");
    expect(query.departAfter).toBe(parseTimeOfDay("07:45:00"));
  });

  it("accepts a resolved time of day", () => {
    const query = normaliseQuery(network, { ...baseRequest, departAfter: parseTimeOfDay("08:00:00") });
    expect(query.departAfter).toBe(8 * 3600);
  });

  it("applies documented defaults", () => {
    const query = normaliseQuery(network, baseRequest);
    expect(query.maxBoardings).toBe(DEFAULT_MAX_BOARDINGS);
    expect(query.minTransferSeconds).toBe(DEFAULT_MIN_TRANSFER_SECONDS);
    expect(query.maxJourneySeconds).toBe(DEFAULT_MAX_JOURNEY_SECONDS);
    expect(query.allowedRouteTypes).toBeUndefined();
    expect(query.requireWheelchair).toBe(false);
    expect(query.requireBikes).toBe(false);
  });

  it("expands a station to its platforms", () => {
    const query = normaliseQuery(network, { ...baseRequest, from: { kind: "stop", stopId: "CENTRAL" } });
    expect(query.origins).toHaveLength(2);
  });

  it("resolves a coordinate to nearby stops", () => {
    const query = normaliseQuery(network, {
      ...baseRequest,
      from: { kind: "coordinate", at: coordinate(51.5, -0.1) },
    });
    expect(query.origins.length).toBeGreaterThan(1);
    expect(query.origins.every((origin) => origin.seconds >= 0)).toBe(true);
  });

  it("rejects an unknown stop", () => {
    expect(() => normaliseQuery(network, { ...baseRequest, from: { kind: "stop", stopId: "NOPE" } })).toThrow(
      UnknownStopError,
    );
  });

  it("rejects an origin equal to the destination", () => {
    expect(() =>
      normaliseQuery(network, { ...baseRequest, to: { kind: "stop", stopId: "NORTH" } }),
    ).toThrow(/same stops/);
  });

  it("rejects a coordinate with no boardable stop nearby", () => {
    expect(() =>
      normaliseQuery(network, {
        ...baseRequest,
        from: { kind: "coordinate", at: coordinate(0, 0), maxWalkMetres: 100 },
      }),
    ).toThrow(/no boardable stop/);
  });

  it("rejects an unboardable named stop", () => {
    const feedNetwork = minimalNetwork();
    expect(() => resolvePlace(feedNetwork, { kind: "stop", stopId: "A" }, "from")).not.toThrow();
  });

  it("rejects invalid numeric options", () => {
    expect(() => normaliseQuery(network, { ...baseRequest, maxBoardings: 0 })).toThrow(QueryError);
    expect(() => normaliseQuery(network, { ...baseRequest, maxBoardings: 1.5 })).toThrow(QueryError);
    expect(() => normaliseQuery(network, { ...baseRequest, minTransferSeconds: -1 })).toThrow(QueryError);
    expect(() => normaliseQuery(network, { ...baseRequest, maxJourneySeconds: 0 })).toThrow(QueryError);
  });

  it("caps the number of access stops", () => {
    expect(MAX_ACCESS_STOPS).toBeGreaterThan(1);
    const points = resolvePlace(
      network,
      { kind: "coordinate", at: coordinate(51.5, -0.1), maxWalkMetres: 100_000 },
      "from",
    );
    expect(points.length).toBeLessThanOrEqual(MAX_ACCESS_STOPS);
    expect(points.every((point) => network.stops.isBoardable(point.stop))).toBe(true);
  });

  it("computes the search horizon", () => {
    const query = normaliseQuery(network, { ...baseRequest, maxJourneySeconds: 3600 });
    expect(searchHorizon(query)).toBe(query.departAfter + 3600);
  });
});

describe("trip filters", () => {
  const query = normaliseQuery(network, baseRequest);

  it("reports no filters when nothing is restricted", () => {
    expect(hasTripFilters(query)).toBe(false);
  });

  it("reports filters when accessibility is required", () => {
    expect(hasTripFilters({ ...query, requireWheelchair: true })).toBe(true);
    expect(hasTripFilters({ ...query, requireBikes: true })).toBe(true);
    expect(hasTripFilters({ ...query, allowedRouteTypes: new Set([RouteType.Bus]) })).toBe(true);
  });

  it("permits every trip when nothing is restricted", () => {
    expect(tripPermitted(network, query, "R1-1")).toBe(true);
  });

  it("rejects an unknown trip", () => {
    expect(tripPermitted(network, query, "GHOST")).toBe(false);
  });

  it("rejects a trip whose accessibility is unknown", () => {
    const strict: JourneyQuery = { ...query, requireWheelchair: true };
    expect(tripPermitted(network, strict, "R1-1")).toBe(true);
    expect(tripPermitted(network, strict, "R1-3")).toBe(false);
  });

  it("rejects a trip that does not carry bicycles", () => {
    const strict: JourneyQuery = { ...query, requireBikes: true };
    expect(tripPermitted(network, strict, "R1-1")).toBe(true);
    expect(tripPermitted(network, strict, "R1-2")).toBe(false);
  });

  it("rejects a trip of an excluded mode", () => {
    const strict: JourneyQuery = { ...query, allowedRouteTypes: new Set([RouteType.Rail]) };
    expect(tripPermitted(network, strict, "R3-1")).toBe(true);
    expect(tripPermitted(network, strict, "R1-1")).toBe(false);
  });
});

describe("DayScanner", () => {
  it("enumerates the query date and the days before it", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const shifts = scanner.anchorList().map((anchor) => anchor.dayShift);
    expect(shifts).toContain(0);
    expect(shifts).toContain(1);
  });

  it("drops anchors with no active service", () => {
    const scanner = DayScanner.build(network, ServiceDate.parse("20231001"), 3600);
    expect(scanner.isEmpty).toBe(true);
    expect(scanner.anchorList()).toEqual([]);
  });

  it("includes forward days for a long horizon", () => {
    const scanner = DayScanner.build(network, MONDAY, 2 * 86_400);
    expect(scanner.anchorList().some((anchor) => anchor.dayShift < 0)).toBe(true);
  });

  it("builds a single-day scanner", () => {
    const scanner = DayScanner.forSingleDay(network, MONDAY);
    expect(scanner.anchorList()).toHaveLength(1);
    expect(scanner.date.toCompact()).toBe("20230605");
  });

  it("reports a single-day scanner as empty when nothing runs", () => {
    expect(DayScanner.forSingleDay(network, ServiceDate.parse("20231001")).isEmpty).toBe(true);
  });

  it("converts between published and absolute time", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const yesterday = scanner.anchorList().find((anchor) => anchor.dayShift === 1);
    expect(yesterday).toBeDefined();
    expect(scanner.toAbsolute(yesterday as never, 86_400 + 600)).toBe(600);
    expect(scanner.toPublished(yesterday as never, 600)).toBe(86_400 + 600);
  });

  it("finds the earliest boarding across anchors", () => {
    const scanner = DayScanner.build(network, ServiceDate.parse("20230606"), 3600);
    const stop = network.requireStop("CENTRAL_B");
    const pattern = network
      .patternsAt(stop)
      .find((index) => network.patternAt(index).routeId === "R2") as never;
    const timetable = network.timetableFor(pattern);
    const position = network.patternAt(pattern).stops.indexOf(stop);

    const boarding = scanner.earliestBoarding(timetable, position, 0);
    expect(boarding).toBeDefined();
    // Monday's 24:02 call, expressed on Tuesday's clock.
    expect(boarding?.departure).toBe(120);
    expect(boarding?.anchor.date.toCompact()).toBe("20230605");
  });

  it("honours a trip predicate", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const stop = network.requireStop("CENTRAL_A");
    const pattern = network
      .patternsAt(stop)
      .find((index) => network.patternAt(index).routeId === "R1") as never;
    const timetable = network.timetableFor(pattern);
    const position = network.patternAt(pattern).stops.indexOf(stop);

    expect(
      scanner.earliestBoarding(timetable, position, 0, (tripId) => tripId === "R1-3")?.departure,
    ).toBe(9 * 3600);
  });

  it("returns undefined when no anchor offers a boarding", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const stop = network.requireStop("CENTRAL_A");
    const pattern = network
      .patternsAt(stop)
      .find((index) => network.patternAt(index).routeId === "R1") as never;
    const timetable = network.timetableFor(pattern);
    const position = network.patternAt(pattern).stops.indexOf(stop);
    expect(scanner.earliestBoarding(timetable, position, 23 * 3600)).toBeUndefined();
  });

  it("finds the latest alighting", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const stop = network.requireStop("HARBOUR");
    const pattern = network.patternsAt(stop)[0] as never;
    const timetable = network.timetableFor(pattern);
    const position = network.patternAt(pattern).stops.indexOf(stop);

    const alighting = scanner.latestAlighting(timetable, position, 9 * 3600);
    expect(alighting?.arrival).toBe(9 * 3600);
    // Nothing on any anchor arrives two days before the query date.
    expect(scanner.latestAlighting(timetable, position, -2 * 86_400)).toBeUndefined();
  });

  it("reads a known trip's times", () => {
    const scanner = DayScanner.build(network, MONDAY, 3600);
    const stop = network.requireStop("CENTRAL_A");
    const pattern = network
      .patternsAt(stop)
      .find((index) => network.patternAt(index).routeId === "R1") as never;
    const timetable = network.timetableFor(pattern);
    const anchor = scanner.anchorList().find((entry) => entry.dayShift === 0) as never;
    expect(scanner.departureOf(timetable, anchor, 0 as never, 0)).toBe(8 * 3600);
    expect(scanner.arrivalOf(timetable, anchor, 0 as never, 3)).toBe(8 * 3600 + 30 * 60);
  });
});

describe("LabelSet", () => {
  const stop = stopIndex(0);
  const other = stopIndex(1);

  it("starts every stop unreached", () => {
    const labels = new LabelSet(3, 2);
    expect(labels.arrivalAt(0, stop)).toBe(UNREACHED);
    expect(labels.bestArrivalAt(stop)).toBe(UNREACHED);
    expect(labels.isReached(0, stop)).toBe(false);
    expect(labels.isReachedEver(stop)).toBe(false);
    expect(labels.legAt(0, stop)).toBeUndefined();
  });

  it("records an improvement", () => {
    const labels = new LabelSet(3, 2);
    const leg = { kind: "access", seconds: 0, departure: 100, arrival: 100 } as const;
    expect(labels.improve(0, stop, 100, leg)).toBe(true);
    expect(labels.arrivalAt(0, stop)).toBe(100);
    expect(labels.bestArrivalAt(stop)).toBe(100);
    expect(labels.legAt(0, stop)).toBe(leg);
  });

  it("rejects a label that is no better", () => {
    const labels = new LabelSet(3, 2);
    const leg = { kind: "access", seconds: 0, departure: 100, arrival: 100 } as const;
    labels.improve(0, stop, 100, leg);
    expect(labels.improve(0, stop, 100, leg)).toBe(false);
    expect(labels.improve(0, stop, 200, leg)).toBe(false);
  });

  it("carries labels into a later round", () => {
    const labels = new LabelSet(3, 2);
    const leg = { kind: "access", seconds: 0, departure: 100, arrival: 100 } as const;
    labels.improve(0, stop, 100, leg);
    labels.carryForward(0, 1);
    expect(labels.arrivalAt(1, stop)).toBe(100);
    expect(labels.legAt(1, stop)).toBe(leg);
  });

  it("finds the earliest arrival among a set, preferring fewer rounds", () => {
    const labels = new LabelSet(3, 2);
    const leg = { kind: "access", seconds: 0, departure: 0, arrival: 0 } as const;
    labels.improve(1, stop, 500, leg);
    labels.improve(0, other, 500, leg);
    const best = labels.earliestAmong([stop, other]);
    expect(best?.round).toBe(0);
    expect(best?.stop).toBe(other);
  });

  it("finds nothing among unreached stops", () => {
    expect(new LabelSet(3, 2).earliestAmong([stop])).toBeUndefined();
  });

  it("counts reached stops per round", () => {
    const labels = new LabelSet(3, 2);
    const leg = { kind: "access", seconds: 0, departure: 0, arrival: 0 } as const;
    labels.improve(0, stop, 100, leg);
    expect(labels.reachedCount(0)).toBe(1);
    expect(labels.reachedCount(1)).toBe(0);
  });
});

describe("MarkedStops", () => {
  it("adds each stop once", () => {
    const marked = new MarkedStops(4);
    expect(marked.add(stopIndex(1))).toBe(true);
    expect(marked.add(stopIndex(1))).toBe(false);
    expect(marked.size).toBe(1);
    expect(marked.has(stopIndex(1))).toBe(true);
    expect(marked.has(stopIndex(2))).toBe(false);
  });

  it("preserves insertion order", () => {
    const marked = new MarkedStops(4);
    marked.add(stopIndex(3));
    marked.add(stopIndex(1));
    expect(marked.values()).toEqual([3, 1]);
  });

  it("clears every mark", () => {
    const marked = new MarkedStops(4);
    marked.add(stopIndex(1));
    marked.clear();
    expect(marked.isEmpty).toBe(true);
    expect(marked.has(stopIndex(1))).toBe(false);
  });

  it("drains, returning what was marked", () => {
    const marked = new MarkedStops(4);
    marked.add(stopIndex(2));
    expect(marked.drain()).toEqual([2]);
    expect(marked.isEmpty).toBe(true);
    expect(marked.add(stopIndex(2))).toBe(true);
  });
});

describe("footpath relaxation", () => {
  const centralA = network.requireStop("CENTRAL_A");
  const centralB = network.requireStop("CENTRAL_B");

  it("seeds origins and reaches their neighbours", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    seedOrigins(labels, network.transfers, [{ stop: centralA, seconds: 0 }], 0, marked, 100_000);

    expect(labels.arrivalAt(0, centralA)).toBe(0);
    expect(labels.arrivalAt(0, centralB)).toBe(60);
    expect(marked.has(centralB)).toBe(true);
  });

  it("skips an origin beyond the horizon", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    seedOrigins(labels, network.transfers, [{ stop: centralA, seconds: 500 }], 0, marked, 100);
    expect(labels.isReached(0, centralA)).toBe(false);
  });

  it("does not chain a walk after a walk in one pass", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    seedOrigins(labels, network.transfers, [{ stop: centralA, seconds: 0 }], 0, marked, 100_000);

    const before = labels.arrivalAt(0, centralB);
    relaxFootpaths(labels, network.transfers, 0, [centralB], marked, 100_000);
    expect(labels.arrivalAt(0, centralB)).toBe(before);
  });

  it("counts the footpaths it examined", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    const leg = { kind: "ride" } as never;
    labels.improve(1, centralA, 0, leg);
    const outcome = relaxFootpaths(labels, network.transfers, 1, [centralA], marked, 100_000);
    expect(outcome.examined).toBeGreaterThan(0);
    expect(outcome.improved).toBeGreaterThan(0);
  });

  it("ignores an unreached source", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    expect(relaxFootpaths(labels, network.transfers, 0, [centralA], marked, 100_000).examined).toBe(0);
  });

  it("respects the horizon", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    const leg = { kind: "ride" } as never;
    labels.improve(1, centralA, 0, leg);
    expect(relaxFootpaths(labels, network.transfers, 1, [centralA], marked, 10).improved).toBe(0);
  });

  it("reports the best destination arrival", () => {
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    seedOrigins(labels, network.transfers, [{ stop: centralA, seconds: 0 }], 100, marked, 100_000);
    expect(bestDestinationArrival(labels, [{ stop: centralA, seconds: 30 }])).toBe(130);
  });

  it("reports unreached destinations", () => {
    const labels = new LabelSet(network.stops.count, 2);
    expect(bestDestinationArrival(labels, [{ stop: centralA, seconds: 0 }])).toBe(UNREACHED);
    expect(bestDestinationArrival(labels, [])).toBe(UNREACHED);
  });

  it("does nothing without footpaths", () => {
    const empty = TransferGraph.empty(network.stops.count);
    const labels = new LabelSet(network.stops.count, 2);
    const marked = new MarkedStops(network.stops.count);
    seedOrigins(labels, empty, [{ stop: centralA, seconds: 0 }], 0, marked, 100_000);
    expect(marked.values()).toEqual([centralA]);
  });
});

describe("runRaptor", () => {
  it("finds a journey and reports its work", () => {
    const query = normaliseQuery(network, baseRequest);
    const search = runRaptor(network, query);
    expect(search.statistics.rounds).toBeGreaterThan(0);
    expect(search.statistics.patternScans).toBeGreaterThan(0);
    expect(search.labels.isReachedEver(network.requireStop("HARBOUR"))).toBe(true);
  });

  it("returns empty labels when no service runs", () => {
    const query = normaliseQuery(network, { ...baseRequest, date: ServiceDate.parse("20231001") });
    const search = runRaptor(network, query);
    expect(search.statistics.rounds).toBe(0);
    expect(search.labels.isReachedEver(network.requireStop("HARBOUR"))).toBe(false);
  });

  it("stops early when a round improves nothing", () => {
    const query = normaliseQuery(network, { ...baseRequest, maxBoardings: 6 });
    const search = runRaptor(network, query);
    expect(search.statistics.rounds).toBeLessThan(6);
  });

  it("respects a boarding limit", () => {
    const query = normaliseQuery(network, { ...baseRequest, maxBoardings: 1 });
    const search = runRaptor(network, query);
    expect(search.labels.maxRound).toBe(1);
    expect(extractBestJourney(network, search)).toBeUndefined();
  });

  it("rejects a query above the hard round limit", () => {
    const query = normaliseQuery(network, baseRequest);
    expect(() => runRaptor(network, { ...query, maxBoardings: MAX_ROUNDS + 1 })).toThrow(RoutingError);
  });

  it("builds a pattern queue from marked stops", () => {
    const queue = collectPatternQueue(network, [network.requireStop("CENTRAL_A")]);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue).toEqual(queue.slice().sort(([a], [b]) => a - b));
    expect(queue.every(([, position]) => position >= 0)).toBe(true);
  });

  it("builds an empty queue from a stop no pattern serves", () => {
    expect(collectPatternQueue(network, [network.requireStop("DEPOT")])).toEqual([]);
  });
});

describe("journey extraction", () => {
  const query = normaliseQuery(network, baseRequest);
  const search = runRaptor(network, query);
  const journeys = extractJourneys(network, search);

  it("returns journeys ordered by arrival", () => {
    expect(journeys.length).toBeGreaterThan(0);
    for (let index = 1; index < journeys.length; index += 1) {
      expect((journeys[index] as never as { arrival: number }).arrival).toBeGreaterThanOrEqual(
        (journeys[index - 1] as never as { arrival: number }).arrival,
      );
    }
  });

  it("returns the best journey first", () => {
    expect(extractBestJourney(network, search)).toEqual(journeys[0]);
  });

  it("starts each journey with an access leg", () => {
    expect(journeys[0]?.legs[0]?.leg.kind).toBe("access");
  });

  it("counts boardings", () => {
    expect(journeys[0]?.boardings).toBe(2);
  });

  it("removes duplicate journeys", () => {
    const keys = journeys.map(journeyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("measures ride, walk, and wait time consistently", () => {
    const journey = journeys[0];
    expect(journey).toBeDefined();
    if (journey === undefined) {
      return;
    }
    const total = journey.arrival - journey.departure;
    expect(rideSeconds(journey) + walkSeconds(journey) + waitSeconds(journey)).toBe(total);
  });

  it("returns nothing when no destination was reached", () => {
    const empty = runRaptor(
      network,
      normaliseQuery(network, { ...baseRequest, date: ServiceDate.parse("20231001") }),
    );
    expect(extractJourneys(network, empty)).toEqual([]);
  });
});

describe("Pareto comparison", () => {
  const make = (arrival: number, boardings: number, walkSeconds: number): Criteria => ({
    arrival,
    boardings,
    walkSeconds,
  });

  it("recognises weak dominance", () => {
    expect(dominates(make(100, 1, 0), make(100, 1, 0))).toBe(true);
    expect(dominates(make(100, 1, 0), make(200, 2, 10))).toBe(true);
    expect(dominates(make(200, 1, 0), make(100, 2, 10))).toBe(false);
  });

  it("recognises strict dominance", () => {
    expect(strictlyDominates(make(100, 1, 0), make(100, 1, 0))).toBe(false);
    expect(strictlyDominates(make(100, 1, 0), make(101, 1, 0))).toBe(true);
    expect(strictlyDominates(make(100, 1, 0), make(100, 2, 0))).toBe(true);
    expect(strictlyDominates(make(100, 1, 0), make(100, 1, 1))).toBe(true);
  });

  it("keeps only non-dominated entries", () => {
    const entries = [make(100, 3, 0), make(120, 1, 0), make(150, 4, 60)];
    expect(paretoFrontier(entries, (entry) => entry)).toEqual([entries[0], entries[1]]);
  });

  it("collapses exact duplicates to the first", () => {
    const entries = [make(100, 1, 0), make(100, 1, 0)];
    expect(paretoFrontier(entries, (entry) => entry)).toEqual([entries[0]]);
  });

  it("returns an empty frontier for no entries", () => {
    expect(paretoFrontier([], (entry: Criteria) => entry)).toEqual([]);
  });

  it("orders by arrival, then boardings, then walking", () => {
    expect(compareCriteria(make(100, 1, 0), make(200, 1, 0))).toBeLessThan(0);
    expect(compareCriteria(make(100, 2, 0), make(100, 1, 0))).toBeGreaterThan(0);
    expect(compareCriteria(make(100, 1, 60), make(100, 1, 0))).toBeGreaterThan(0);
    expect(compareCriteria(make(100, 1, 0), make(100, 1, 0))).toBe(0);
  });
});

describe("profile Pareto comparison", () => {
  const make = (departure: number, arrival: number, boardings = 1, walkSeconds = 0): ProfileCriteria => ({
    departure,
    arrival,
    boardings,
    walkSeconds,
  });

  it("treats a later departure as an advantage", () => {
    expect(profileDominates(make(200, 300), make(100, 300))).toBe(true);
    expect(profileDominates(make(100, 300), make(200, 300))).toBe(false);
  });

  it("recognises strict profile dominance", () => {
    expect(profileStrictlyDominates(make(200, 300), make(100, 300))).toBe(true);
    expect(profileStrictlyDominates(make(100, 300), make(100, 300))).toBe(false);
  });

  it("keeps every worthwhile departure", () => {
    const entries = [make(100, 200), make(200, 300), make(300, 400)];
    expect(profileFrontier(entries, (entry) => entry)).toHaveLength(3);
  });

  it("drops a departure that leaves earlier and arrives later", () => {
    const entries = [make(200, 300), make(100, 400)];
    expect(profileFrontier(entries, (entry) => entry)).toEqual([entries[0]]);
  });

  it("collapses exact duplicates", () => {
    const entries = [make(100, 200), make(100, 200)];
    expect(profileFrontier(entries, (entry) => entry)).toEqual([entries[0]]);
  });
});

describe("diversify", () => {
  const make = (arrival: number, boardings: number, walkSeconds: number): Criteria => ({
    arrival,
    boardings,
    walkSeconds,
  });

  it("returns everything below the limit", () => {
    const entries = [make(100, 1, 0), make(200, 2, 0)];
    expect(diversify(entries, (entry) => entry, 5)).toEqual(entries);
  });

  it("returns nothing for a limit of zero", () => {
    expect(diversify([make(100, 1, 0)], (entry) => entry, 0)).toEqual([]);
  });

  it("keeps the best entry and spreads the rest", () => {
    const entries = [
      make(100, 4, 600),
      make(105, 4, 600),
      make(110, 4, 600),
      make(400, 1, 0),
    ];
    const chosen = diversify(entries, (entry) => entry, 2);
    expect(chosen).toHaveLength(2);
    expect(chosen).toContain(entries[0]);
    expect(chosen).toContain(entries[3]);
  });

  it("returns results in presentation order", () => {
    const entries = [make(300, 1, 0), make(100, 3, 0), make(200, 2, 0), make(400, 1, 900)];
    const chosen = diversify(entries, (entry) => entry, 3);
    const arrivals = chosen.map((entry) => entry.arrival);
    expect(arrivals).toEqual(arrivals.slice().sort((a, b) => a - b));
  });
});

describe("runRangeRaptor", () => {
  const query = normaliseQuery(network, {
    from: { kind: "stop", stopId: "CENTRAL_A" },
    to: { kind: "stop", stopId: "HARBOUR" },
    date: MONDAY,
    departAfter: "07:30:00",
  });

  it("returns one journey per worthwhile departure", () => {
    const result = runRangeRaptor(network, query, { windowSeconds: 2 * 3600 });
    expect(result.journeys).toHaveLength(3);
    expect(result.departuresSearched.length).toBeGreaterThan(0);
  });

  it("sums the work of every underlying search", () => {
    const result = runRangeRaptor(network, query, { windowSeconds: 2 * 3600 });
    expect(result.statistics.patternScans).toBeGreaterThan(0);
  });

  it("honours a journey limit", () => {
    const result = runRangeRaptor(network, query, { windowSeconds: 2 * 3600, maxJourneys: 1 });
    expect(result.journeys).toHaveLength(1);
  });

  it("rejects an invalid window", () => {
    expect(() => runRangeRaptor(network, query, { windowSeconds: 0 })).toThrow(QueryError);
    expect(() => runRangeRaptor(network, query, { windowSeconds: 1.5 })).toThrow(QueryError);
  });

  it("returns nothing when no service runs", () => {
    const dead = normaliseQuery(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: ServiceDate.parse("20231001"),
      departAfter: "07:30:00",
    });
    expect(runRangeRaptor(network, dead, { windowSeconds: 3600 }).journeys).toEqual([]);
  });

  it("lists candidate departures ascending, including the window start", () => {
    const departures = candidateDepartures(network, query, 2 * 3600, 60);
    expect(departures[0]).toBe(query.departAfter);
    expect(departures).toEqual(departures.slice().sort((a, b) => a - b));
  });

  it("thins candidate departures down to the cap", () => {
    const departures = candidateDepartures(network, query, 6 * 3600, 2);
    expect(departures.length).toBeLessThanOrEqual(2);
    expect(departures[0]).toBe(query.departAfter);
  });

  it("returns only the window start when nothing runs", () => {
    const dead = normaliseQuery(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: ServiceDate.parse("20231001"),
      departAfter: "07:30:00",
    });
    expect(candidateDepartures(network, dead, 3600, 60)).toEqual([dead.departAfter]);
  });

  it("uses a documented default departure cap", () => {
    expect(DEFAULT_MAX_DEPARTURES).toBeGreaterThan(10);
  });

  it("renders a departure board of distinct times", () => {
    const result = runRangeRaptor(network, query, { windowSeconds: 2 * 3600 });
    const board = departureBoard(result);
    expect(board).toEqual([8 * 3600, 8 * 3600 + 30 * 60, 9 * 3600]);
  });
});
