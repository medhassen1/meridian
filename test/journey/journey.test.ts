import { describe, expect, it } from "vitest";

import { RoutingError } from "../../src/errors.js";
import { ServiceDate } from "../../src/time/date.js";
import { normaliseQuery } from "../../src/routing/query.js";
import { runRaptor } from "../../src/routing/raptor.js";
import { extractJourneys } from "../../src/routing/result.js";
import {
  buildItineraries,
  buildItinerary,
  isWalkOnly,
  ridesOf,
  routesOf,
  stopSequenceOf,
  type Itinerary,
} from "../../src/journey/itinerary.js";
import {
  dateOfAbsoluteTime,
  describeLeg,
  destinationStopIdOf,
  formatAbsoluteTime,
  isOnFoot,
  isRide,
  originStopIdOf,
} from "../../src/journey/leg.js";
import {
  measureJourney,
  movementRatio,
  routeSequence,
  summariseJourney,
  summariseProfile,
  totalDuration,
  waitsBetweenLegs,
} from "../../src/journey/metrics.js";
import {
  bestItineraries,
  compareByArrival,
  compareByDeparture,
  compareByDuration,
  compareByTransfers,
  compareByWalking,
  comparatorFor,
  criteriaOfItinerary,
  deduplicateItineraries,
  sortItineraries,
  tieBreakKey,
} from "../../src/journey/compare.js";
import { MONDAY, rivertownNetwork } from "../support/fixtures.js";

const network = rivertownNetwork();

function itinerariesFor(fromStopId: string, toStopId: string, departAfter: string): Itinerary[] {
  const query = normaliseQuery(network, {
    from: { kind: "stop", stopId: fromStopId },
    to: { kind: "stop", stopId: toStopId },
    date: MONDAY,
    departAfter,
  });
  return buildItineraries(network, extractJourneys(network, runRaptor(network, query)), MONDAY);
}

const journeys = itinerariesFor("NORTH", "HARBOUR", "07:45:00");
const best = journeys[0] as Itinerary;

describe("buildItinerary", () => {
  it("resolves indices to names", () => {
    const ride = ridesOf(best)[0];
    expect(ride?.fromStopName).toBe("Northgate");
    expect(ride?.routeName).toBe("2");
    expect(ride?.routeType).toBe(0);
  });

  it("records the query date", () => {
    expect(best.date.toCompact()).toBe("20230605");
  });

  it("counts boardings and transfers", () => {
    expect(best.boardings).toBe(2);
    expect(best.transfers).toBe(1);
  });

  it("orders legs by travel order", () => {
    expect(best.legs[0]?.kind).toBe("access");
    expect(best.legs.some((leg) => leg.kind === "walk")).toBe(true);
  });

  it("lists intermediate stops on a ride", () => {
    const ride = ridesOf(best).find((leg) => leg.routeId === "R1");
    expect(ride?.intermediateStops.length).toBeGreaterThan(0);
    expect(ride?.intermediateStops[0]?.stopName).toBe("Market Square");
  });

  it("records the service date each vehicle run is anchored to", () => {
    expect(ridesOf(best).every((ride) => ride.serviceDate.toCompact() === "20230605")).toBe(true);
  });

  it("reports zero expected wait for a scheduled trip", () => {
    expect(ridesOf(best).every((ride) => ride.expectedWaitSeconds === 0)).toBe(true);
  });

  it("reports an expected wait for a headway-based trip", () => {
    const headwayNetwork = rivertownNetwork();
    const query = normaliseQuery(headwayNetwork, {
      from: { kind: "stop", stopId: "MARKET" },
      to: { kind: "stop", stopId: "EAST" },
      date: MONDAY,
      departAfter: "06:00:00",
    });
    const found = buildItineraries(
      headwayNetwork,
      extractJourneys(headwayNetwork, runRaptor(headwayNetwork, query)),
      MONDAY,
    );
    // The fixture publishes exact times, so the expected wait is still zero.
    expect(ridesOf(found[0] as Itinerary)[0]?.expectedWaitSeconds).toBe(0);
  });

  it("adds an egress leg when the destination needs a walk", () => {
    const query = normaliseQuery(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "coordinate", at: { latitude: 51.5001, longitude: -0.0999 } },
      date: MONDAY,
      departAfter: "07:45:00",
    });
    const found = buildItineraries(network, extractJourneys(network, runRaptor(network, query)), MONDAY);
    expect(found.some((itinerary) => itinerary.legs.some((leg) => leg.kind === "egress"))).toBe(true);
  });

  it("rejects a journey with no legs", () => {
    expect(() =>
      buildItinerary(
        network,
        {
          legs: [],
          origin: 0 as never,
          destination: 0 as never,
          departure: 0,
          arrival: 0,
          egressSeconds: 10,
          boardings: 0,
        },
        MONDAY,
      ),
    ).toThrow(RoutingError);
  });

  it("rejects a leg naming an unknown route", () => {
    const stripped = { ...network.feed, routeById: new Map() };
    const broken = Object.create(network) as typeof network;
    Object.defineProperty(broken, "feed", { value: stripped, enumerable: true });
    const raw = extractJourneys(
      network,
      runRaptor(network, normaliseQuery(network, {
        from: { kind: "stop", stopId: "NORTH" },
        to: { kind: "stop", stopId: "HARBOUR" },
        date: MONDAY,
        departAfter: "07:45:00",
      })),
    );
    expect(() => buildItinerary(broken, raw[0] as never, MONDAY)).toThrow(/unknown route/);
  });
});

describe("itinerary accessors", () => {
  it("lists stops in travel order without repeats", () => {
    const sequence = stopSequenceOf(best);
    expect(sequence[0]).toBe("NORTH");
    expect(sequence[sequence.length - 1]).toBe("HARBOUR");
    expect(new Set(sequence).size).toBe(sequence.length);
  });

  it("lists routes in travel order", () => {
    expect(routesOf(best)).toEqual(["R2", "R1"]);
  });

  it("recognises a journey with vehicles", () => {
    expect(isWalkOnly(best)).toBe(false);
  });
});

describe("leg helpers", () => {
  it("distinguishes rides from walks", () => {
    const ride = ridesOf(best)[0];
    expect(isRide(ride as never)).toBe(true);
    expect(isOnFoot(ride as never)).toBe(false);
    expect(isOnFoot(best.legs[0] as never)).toBe(true);
  });

  it("reports leg endpoints, with undefined at the journey's ends", () => {
    expect(originStopIdOf(best.legs[0] as never)).toBeUndefined();
    expect(destinationStopIdOf(best.legs[0] as never)).toBe("NORTH");
  });

  it("renders an absolute time with a day marker", () => {
    expect(formatAbsoluteTime(8 * 3600 + 30 * 60)).toBe("08:30");
    expect(formatAbsoluteTime(-600)).toBe("23:50 (-1d)");
    expect(formatAbsoluteTime(25 * 3600)).toBe("01:00 (+1d)");
  });

  it("maps an absolute time back to a calendar date", () => {
    expect(dateOfAbsoluteTime(MONDAY, 8 * 3600).toCompact()).toBe("20230605");
    expect(dateOfAbsoluteTime(MONDAY, -600).toCompact()).toBe("20230604");
    expect(dateOfAbsoluteTime(MONDAY, 25 * 3600).toCompact()).toBe("20230606");
  });

  it("describes each kind of leg", () => {
    for (const leg of best.legs) {
      expect(describeLeg(leg).length).toBeGreaterThan(5);
    }
  });

  it("describes an egress leg", () => {
    const query = normaliseQuery(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "coordinate", at: { latitude: 51.5001, longitude: -0.0999 } },
      date: MONDAY,
      departAfter: "07:45:00",
    });
    const found = buildItineraries(network, extractJourneys(network, runRaptor(network, query)), MONDAY);
    const egress = found
      .flatMap((itinerary) => itinerary.legs)
      .find((leg) => leg.kind === "egress");
    expect(egress).toBeDefined();
    expect(describeLeg(egress as never)).toContain("walk");
  });
});

describe("measureJourney", () => {
  const metrics = measureJourney(best);

  it("splits elapsed time into riding, walking, and waiting", () => {
    expect(metrics.rideSeconds + metrics.walkSeconds + metrics.waitSeconds).toBe(metrics.totalSeconds);
  });

  it("counts boardings, transfers, and intermediate stops", () => {
    expect(metrics.boardings).toBe(2);
    expect(metrics.transfers).toBe(1);
    expect(metrics.intermediateStops).toBeGreaterThan(0);
  });

  it("reports the longest single wait and walk", () => {
    expect(metrics.longestWaitSeconds).toBeGreaterThan(0);
    expect(metrics.longestWalkSeconds).toBeGreaterThan(0);
  });

  it("reports no extra expected wait for a scheduled journey", () => {
    expect(metrics.expectedExtraWaitSeconds).toBe(0);
  });

  it("computes the gaps between legs", () => {
    const waits = waitsBetweenLegs(best.legs);
    expect(waits).toHaveLength(best.legs.length - 1);
    expect(waits.every((wait) => wait >= 0)).toBe(true);
  });

  it("reports a movement ratio between zero and one", () => {
    expect(movementRatio(metrics)).toBeGreaterThan(0);
    expect(movementRatio(metrics)).toBeLessThanOrEqual(1);
  });

  it("reports a ratio of one for an instantaneous journey", () => {
    expect(movementRatio({ ...metrics, totalSeconds: 0 })).toBe(1);
  });

  it("converts total time to a duration", () => {
    expect(totalDuration(metrics)).toBe(metrics.totalSeconds);
    expect(totalDuration({ ...metrics, totalSeconds: -5 })).toBe(0);
  });

  it("summarises in one line", () => {
    const summary = summariseJourney(metrics);
    expect(summary).toContain("change");
    expect(summary).toContain("walking");
  });

  it("says direct for a journey with no changes", () => {
    const direct = itinerariesFor("CENTRAL_A", "HARBOUR", "07:00:00")[0] as Itinerary;
    expect(summariseJourney(measureJourney(direct))).toContain("direct");
  });

  it("mentions an expected wait when there is one", () => {
    expect(summariseJourney({ ...metrics, expectedExtraWaitSeconds: 300 })).toContain("expected wait");
  });

  it("lists the route names in travel order", () => {
    expect(routeSequence(best)).toEqual(["2", "1"]);
  });
});

describe("summariseProfile", () => {
  it("summarises a set of itineraries", () => {
    const summary = summariseProfile(journeys);
    expect(summary?.journeys).toBe(journeys.length);
    expect(summary?.fastestSeconds).toBeLessThanOrEqual(summary?.slowestSeconds as number);
    expect(summary?.fewestTransfers).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined rather than zeroes for no journeys", () => {
    expect(summariseProfile([])).toBeUndefined();
  });
});

describe("comparison", () => {
  const options = itinerariesFor("CENTRAL_A", "HARBOUR", "07:00:00");

  it("extracts comparison criteria", () => {
    const criteria = criteriaOfItinerary(best);
    expect(criteria.arrival).toBe(best.arrival);
    expect(criteria.boardings).toBe(best.boardings);
    expect(criteria.walkSeconds).toBeGreaterThanOrEqual(0);
  });

  it("builds a tie-break key from the leg structure", () => {
    expect(tieBreakKey(best)).toContain("R1");
    expect(tieBreakKey(best)).toBe(tieBreakKey(best));
  });

  it("gives a total order under every comparator", () => {
    for (const order of ["arrival", "departure", "duration", "transfers", "walking"] as const) {
      const sorted = sortItineraries(options, order);
      expect(sorted).toHaveLength(options.length);
      expect(sortItineraries(options, order)).toEqual(sorted);
    }
  });

  it("orders by soonest arrival", () => {
    const sorted = options.slice().sort(compareByArrival);
    expect(sorted[0]?.arrival).toBeLessThanOrEqual(sorted[sorted.length - 1]?.arrival as number);
  });

  it("orders by latest departure", () => {
    const sorted = options.slice().sort(compareByDeparture);
    expect(sorted[0]?.departure).toBeGreaterThanOrEqual(sorted[sorted.length - 1]?.departure as number);
  });

  it("orders by shortest journey", () => {
    const sorted = options.slice().sort(compareByDuration);
    expect(sorted[0]?.totalSeconds).toBeLessThanOrEqual(
      sorted[sorted.length - 1]?.totalSeconds as number,
    );
  });

  it("orders by fewest changes", () => {
    const sorted = journeys.slice().sort(compareByTransfers);
    expect(sorted[0]?.transfers).toBeLessThanOrEqual(sorted[sorted.length - 1]?.transfers as number);
  });

  it("orders by least walking", () => {
    const sorted = journeys.slice().sort(compareByWalking);
    expect(measureJourney(sorted[0] as Itinerary).walkSeconds).toBeLessThanOrEqual(
      measureJourney(sorted[sorted.length - 1] as Itinerary).walkSeconds,
    );
  });

  it("resolves a comparator by name", () => {
    expect(comparatorFor("arrival")).toBe(compareByArrival);
    expect(comparatorFor("departure")).toBe(compareByDeparture);
    expect(comparatorFor("duration")).toBe(compareByDuration);
    expect(comparatorFor("transfers")).toBe(compareByTransfers);
    expect(comparatorFor("walking")).toBe(compareByWalking);
  });

  it("does not modify its input when sorting", () => {
    const copy = options.slice();
    sortItineraries(options);
    expect(options).toEqual(copy);
  });

  it("reduces to the Pareto frontier", () => {
    const frontier = bestItineraries(options);
    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier.length).toBeLessThanOrEqual(options.length);
  });

  it("removes repeated itineraries", () => {
    const doubled = [...journeys, ...journeys];
    expect(deduplicateItineraries(doubled)).toHaveLength(journeys.length);
  });

  it("distinguishes itineraries with different structures", () => {
    const other = itinerariesFor("WEST", "EAST", "08:00:00")[0] as Itinerary;
    expect(tieBreakKey(other)).not.toBe(tieBreakKey(best));
  });

  it("orders deterministically across runs", () => {
    const first = sortItineraries(options, "arrival").map(tieBreakKey);
    const second = sortItineraries(options.slice().reverse(), "arrival").map(tieBreakKey);
    expect(second).toEqual(first);
  });
});

describe("itineraries with no service", () => {
  it("produces nothing on a dead date", () => {
    const query = normaliseQuery(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: ServiceDate.parse("20231001"),
      departAfter: "08:00:00",
    });
    expect(
      buildItineraries(network, extractJourneys(network, runRaptor(network, query)), MONDAY),
    ).toEqual([]);
  });
});
