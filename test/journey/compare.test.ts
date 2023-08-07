/**
 * Direct comparator tests.
 *
 * The comparators in `journey/compare.ts` decide result order, and each has a
 * chain of tie-breaks that only fires when the earlier keys are equal. Driving
 * them through a real search exercises the first key and little else, so these
 * tests build itineraries by hand with exactly one difference at a time.
 */

import { describe, expect, it } from "vitest";

import type { Itinerary } from "../../src/journey/itinerary.js";
import type { JourneyLeg } from "../../src/journey/leg.js";
import {
  compareByArrival,
  compareByDeparture,
  compareByDuration,
  compareByTransfers,
  compareByWalking,
  criteriaOfItinerary,
  deduplicateItineraries,
  tieBreakKey,
} from "../../src/journey/compare.js";
import { MONDAY } from "../support/fixtures.js";

interface Shape {
  readonly departure?: number;
  readonly arrival?: number;
  readonly boardings?: number;
  readonly transfers?: number;
  readonly totalSeconds?: number;
  readonly legs?: readonly JourneyLeg[];
}

function ride(routeId: string, tripId: string, seconds = 600): JourneyLeg {
  return {
    kind: "ride",
    routeId,
    routeName: routeId,
    routeType: 3,
    tripId,
    headsign: undefined,
    fromStopId: "A",
    fromStopName: "A",
    toStopId: "B",
    toStopName: "B",
    serviceDate: MONDAY,
    intermediateStops: [],
    expectedWaitSeconds: 0,
    departure: 0,
    arrival: seconds,
    seconds,
  };
}

function walk(seconds: number): JourneyLeg {
  return {
    kind: "walk",
    fromStopId: "B",
    fromStopName: "B",
    toStopId: "C",
    toStopName: "C",
    departure: 0,
    arrival: seconds,
    seconds,
    published: false,
  };
}

function access(seconds: number): JourneyLeg {
  return { kind: "access", toStopId: "A", toStopName: "A", departure: 0, arrival: seconds, seconds };
}

function egress(seconds: number): JourneyLeg {
  return { kind: "egress", fromStopId: "C", fromStopName: "C", departure: 0, arrival: seconds, seconds };
}

function itinerary(shape: Shape = {}): Itinerary {
  return {
    legs: shape.legs ?? [access(0), ride("R1", "T1")],
    date: MONDAY,
    departure: shape.departure ?? 0,
    arrival: shape.arrival ?? 600,
    totalSeconds: shape.totalSeconds ?? 600,
    boardings: shape.boardings ?? 1,
    transfers: shape.transfers ?? 0,
  };
}

describe("criteriaOfItinerary", () => {
  it("reads arrival, boardings, and walking from the itinerary", () => {
    const criteria = criteriaOfItinerary(
      itinerary({ arrival: 900, boardings: 2, legs: [access(30), ride("R1", "T1"), walk(60)] }),
    );
    expect(criteria.arrival).toBe(900);
    expect(criteria.boardings).toBe(2);
    expect(criteria.walkSeconds).toBe(90);
  });
});

describe("tieBreakKey", () => {
  it("encodes every kind of leg", () => {
    const key = tieBreakKey(itinerary({ legs: [access(30), ride("R1", "T1"), walk(60), egress(20)] }));
    expect(key).toContain("a:A:30");
    expect(key).toContain("r:R1:T1:A:B");
    expect(key).toContain("w:B:C:60");
    expect(key).toContain("e:C:20");
  });

  it("distinguishes itineraries using different trips", () => {
    expect(tieBreakKey(itinerary({ legs: [ride("R1", "T1")] }))).not.toBe(
      tieBreakKey(itinerary({ legs: [ride("R1", "T2")] })),
    );
  });

  it("is stable across calls", () => {
    const value = itinerary();
    expect(tieBreakKey(value)).toBe(tieBreakKey(value));
  });
});

describe("compareByArrival", () => {
  it("prefers the earlier arrival", () => {
    expect(compareByArrival(itinerary({ arrival: 100 }), itinerary({ arrival: 200 }))).toBeLessThan(0);
  });

  it("breaks an arrival tie on boardings", () => {
    expect(
      compareByArrival(itinerary({ boardings: 1 }), itinerary({ boardings: 2 })),
    ).toBeLessThan(0);
  });

  it("breaks a boarding tie on elapsed time", () => {
    expect(
      compareByArrival(itinerary({ totalSeconds: 300 }), itinerary({ totalSeconds: 600 })),
    ).toBeLessThan(0);
  });

  it("breaks every numeric tie on structure", () => {
    const left = itinerary({ legs: [ride("R1", "T1")] });
    const right = itinerary({ legs: [ride("R2", "T1")] });
    expect(compareByArrival(left, right)).toBeLessThan(0);
    expect(compareByArrival(right, left)).toBeGreaterThan(0);
  });

  it("reports identical itineraries as equal", () => {
    expect(compareByArrival(itinerary(), itinerary())).toBe(0);
  });
});

describe("compareByDeparture", () => {
  it("prefers the later departure", () => {
    expect(
      compareByDeparture(itinerary({ departure: 200 }), itinerary({ departure: 100 })),
    ).toBeLessThan(0);
  });

  it("breaks a departure tie on arrival", () => {
    expect(
      compareByDeparture(itinerary({ arrival: 100 }), itinerary({ arrival: 200 })),
    ).toBeLessThan(0);
  });

  it("breaks an arrival tie on boardings", () => {
    expect(
      compareByDeparture(itinerary({ boardings: 1 }), itinerary({ boardings: 2 })),
    ).toBeLessThan(0);
  });

  it("breaks every numeric tie on structure", () => {
    expect(
      compareByDeparture(
        itinerary({ legs: [ride("R1", "T1")] }),
        itinerary({ legs: [ride("R2", "T1")] }),
      ),
    ).toBeLessThan(0);
  });
});

describe("compareByDuration", () => {
  it("prefers the shorter journey", () => {
    expect(
      compareByDuration(itinerary({ totalSeconds: 300 }), itinerary({ totalSeconds: 600 })),
    ).toBeLessThan(0);
  });

  it("breaks a duration tie on boardings", () => {
    expect(
      compareByDuration(itinerary({ boardings: 1 }), itinerary({ boardings: 3 })),
    ).toBeLessThan(0);
  });

  it("breaks a boarding tie on arrival", () => {
    expect(
      compareByDuration(itinerary({ arrival: 100 }), itinerary({ arrival: 200 })),
    ).toBeLessThan(0);
  });

  it("breaks every numeric tie on structure", () => {
    expect(
      compareByDuration(
        itinerary({ legs: [ride("R1", "T1")] }),
        itinerary({ legs: [ride("R2", "T1")] }),
      ),
    ).toBeLessThan(0);
  });
});

describe("compareByTransfers", () => {
  it("prefers fewer changes", () => {
    expect(
      compareByTransfers(itinerary({ transfers: 0 }), itinerary({ transfers: 2 })),
    ).toBeLessThan(0);
  });

  it("breaks a transfer tie on arrival", () => {
    expect(
      compareByTransfers(itinerary({ arrival: 100 }), itinerary({ arrival: 200 })),
    ).toBeLessThan(0);
  });

  it("breaks an arrival tie on elapsed time", () => {
    expect(
      compareByTransfers(itinerary({ totalSeconds: 100 }), itinerary({ totalSeconds: 200 })),
    ).toBeLessThan(0);
  });

  it("breaks every numeric tie on structure", () => {
    expect(
      compareByTransfers(
        itinerary({ legs: [ride("R1", "T1")] }),
        itinerary({ legs: [ride("R2", "T1")] }),
      ),
    ).toBeLessThan(0);
  });
});

describe("compareByWalking", () => {
  it("prefers less walking", () => {
    expect(
      compareByWalking(
        itinerary({ legs: [access(10), ride("R1", "T1")] }),
        itinerary({ legs: [access(600), ride("R1", "T1")] }),
      ),
    ).toBeLessThan(0);
  });

  it("breaks a walking tie on arrival", () => {
    expect(
      compareByWalking(itinerary({ arrival: 100 }), itinerary({ arrival: 200 })),
    ).toBeLessThan(0);
  });

  it("breaks an arrival tie on boardings", () => {
    expect(
      compareByWalking(itinerary({ boardings: 1 }), itinerary({ boardings: 2 })),
    ).toBeLessThan(0);
  });

  it("breaks every numeric tie on structure", () => {
    expect(
      compareByWalking(
        itinerary({ legs: [ride("R1", "T1")] }),
        itinerary({ legs: [ride("R2", "T1")] }),
      ),
    ).toBeLessThan(0);
  });
});

describe("deduplicateItineraries", () => {
  it("keeps itineraries differing only in departure", () => {
    const entries = [itinerary({ departure: 0 }), itinerary({ departure: 100 })];
    expect(deduplicateItineraries(entries)).toHaveLength(2);
  });

  it("collapses itineraries identical in time and structure", () => {
    expect(deduplicateItineraries([itinerary(), itinerary()])).toHaveLength(1);
  });

  it("keeps itineraries differing only in structure", () => {
    const entries = [
      itinerary({ legs: [ride("R1", "T1")] }),
      itinerary({ legs: [ride("R2", "T1")] }),
    ];
    expect(deduplicateItineraries(entries)).toHaveLength(2);
  });

  it("returns nothing for no input", () => {
    expect(deduplicateItineraries([])).toEqual([]);
  });
});
