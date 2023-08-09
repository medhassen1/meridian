import { describe, expect, it } from "vitest";

import { normaliseQuery } from "../../src/routing/query.js";
import { runRaptor } from "../../src/routing/raptor.js";
import { extractJourneys } from "../../src/routing/result.js";
import { buildItineraries, type Itinerary } from "../../src/journey/itinerary.js";
import type { RideLeg } from "../../src/journey/leg.js";
import { FareMatcher, compareMatches, ruleApplies } from "../../src/fares/matcher.js";
import {
  buildZoneIndex,
  computeFare,
  coversLeg,
  describeFare,
  describeFareableLeg,
  formatFare,
} from "../../src/fares/compute.js";
import type { FareAttribute } from "../../src/feed/fares.js";
import { MONDAY, rivertownFeed, rivertownNetwork } from "../support/fixtures.js";

const network = rivertownNetwork();
const feed = network.feed;

function itineraryFor(fromStopId: string, toStopId: string, departAfter: string): Itinerary {
  const query = normaliseQuery(network, {
    from: { kind: "stop", stopId: fromStopId },
    to: { kind: "stop", stopId: toStopId },
    date: MONDAY,
    departAfter,
  });
  const found = buildItineraries(network, extractJourneys(network, runRaptor(network, query)), MONDAY);
  return found[0] as Itinerary;
}

describe("buildZoneIndex", () => {
  it("maps stops to their fare zones", () => {
    const zones = buildZoneIndex(feed);
    expect(zones.get("CENTRAL_A")).toBe("A");
    expect(zones.get("HARBOUR")).toBe("B");
  });

  it("omits stops with no zone", () => {
    const zones = buildZoneIndex({ ...feed, stops: feed.stops.map((stop) => ({ ...stop, zoneId: undefined })) });
    expect(zones.size).toBe(0);
  });
});

describe("FareMatcher", () => {
  const matcher = FareMatcher.build(feed);

  it("indexes the feed's fares", () => {
    expect(matcher.isEmpty).toBe(false);
    expect(matcher.fareCount).toBe(2);
    expect(matcher.fareById("F_BASE")?.price).toBe(2.5);
    expect(matcher.fareById("NOPE")).toBeUndefined();
  });

  it("lists the rules defined for a fare", () => {
    expect(matcher.rulesFor("F_BASE")).toHaveLength(3);
    expect(matcher.rulesFor("NOPE")).toEqual([]);
  });

  it("reports an empty matcher for a feed with no fares", () => {
    const empty = FareMatcher.build({ ...feed, fareAttributes: [], fareRules: [] });
    expect(empty.isEmpty).toBe(true);
    expect(empty.candidates({ routeId: "R1", originZoneId: undefined, destinationZoneId: undefined, zonesTouched: new Set() })).toEqual([]);
  });

  it("ignores a rule naming an unknown fare", () => {
    const withGhost = FareMatcher.build({
      ...feed,
      fareRules: [
        ...feed.fareRules,
        { fareId: "GHOST", routeId: "R1", originId: undefined, destinationId: undefined, containsId: undefined, line: 99 },
      ],
    });
    expect(withGhost.rulesFor("GHOST")).toEqual([]);
  });

  it("matches a fare by route", () => {
    const match = matcher.best({
      routeId: "R1",
      originZoneId: "A",
      destinationZoneId: "B",
      zonesTouched: new Set(["A", "B"]),
    });
    expect(match?.fare.fareId).toBe("F_BASE");
  });

  it("returns nothing when no rule applies", () => {
    expect(
      matcher.best({
        routeId: "UNKNOWN",
        originZoneId: undefined,
        destinationZoneId: undefined,
        zonesTouched: new Set(),
      }),
    ).toBeUndefined();
  });

  it("returns each fare at most once", () => {
    const candidates = matcher.candidates({
      routeId: "R1",
      originZoneId: "A",
      destinationZoneId: "B",
      zonesTouched: new Set(["A", "B"]),
    });
    expect(new Set(candidates.map((match) => match.fare.fareId)).size).toBe(candidates.length);
  });
});

describe("ruleApplies", () => {
  const leg = {
    routeId: "R1",
    originZoneId: "A",
    destinationZoneId: "B",
    zonesTouched: new Set(["A", "B"]),
  };
  const rule = (overrides: Record<string, string | undefined>) => ({
    fareId: "F",
    routeId: undefined,
    originId: undefined,
    destinationId: undefined,
    containsId: undefined,
    line: 1,
    ...overrides,
  });

  it("accepts a rule with no constraints", () => {
    expect(ruleApplies(rule({}), leg)).toBe(true);
  });

  it("matches on route", () => {
    expect(ruleApplies(rule({ routeId: "R1" }), leg)).toBe(true);
    expect(ruleApplies(rule({ routeId: "R2" }), leg)).toBe(false);
  });

  it("matches on origin and destination zones", () => {
    expect(ruleApplies(rule({ originId: "A", destinationId: "B" }), leg)).toBe(true);
    expect(ruleApplies(rule({ originId: "B" }), leg)).toBe(false);
    expect(ruleApplies(rule({ destinationId: "A" }), leg)).toBe(false);
  });

  it("matches on a zone the leg passes through", () => {
    expect(ruleApplies(rule({ containsId: "A" }), leg)).toBe(true);
    expect(ruleApplies(rule({ containsId: "Z" }), leg)).toBe(false);
  });
});

describe("compareMatches", () => {
  const fare = (fareId: string, price: number): FareAttribute => ({
    fareId,
    price,
    currencyType: "GBP",
    paymentMethod: 1,
    transfers: undefined,
    agencyId: undefined,
    transferDuration: undefined,
    line: 1,
  });
  const rule = (fareId: string, routeId?: string, containsId?: string) => ({
    fareId,
    routeId,
    originId: undefined,
    destinationId: undefined,
    containsId,
    line: 1,
  });

  it("prefers the more specific rule", () => {
    const specific = { fare: fare("A", 5), rule: rule("A", "R1", "Z") };
    const general = { fare: fare("B", 1), rule: rule("B", "R1") };
    expect(compareMatches(specific, general)).toBeLessThan(0);
  });

  it("prefers the cheaper fare among equally specific rules", () => {
    const cheap = { fare: fare("A", 1), rule: rule("A", "R1") };
    const dear = { fare: fare("B", 5), rule: rule("B", "R1") };
    expect(compareMatches(cheap, dear)).toBeLessThan(0);
  });

  it("falls back to the fare id", () => {
    const first = { fare: fare("A", 1), rule: rule("A", "R1") };
    const second = { fare: fare("B", 1), rule: rule("B", "R1") };
    expect(compareMatches(first, second)).toBeLessThan(0);
  });
});

describe("computeFare", () => {
  it("charges one fare and covers the transfer", () => {
    const fare = computeFare(feed, itineraryFor("NORTH", "HARBOUR", "07:45:00"));
    expect(fare.total).toBe(2.5);
    expect(fare.currency).toBe("GBP");
    expect(fare.reason).toBeUndefined();
    expect(fare.legs.filter((leg) => leg.coveredByTransfer)).toHaveLength(1);
  });

  it("charges a single fare for a direct journey", () => {
    const fare = computeFare(feed, itineraryFor("CENTRAL_A", "HARBOUR", "07:00:00"));
    expect(fare.total).toBe(2.5);
    expect(fare.legs).toHaveLength(1);
  });

  it("prices a rail journey with its own fare", () => {
    const fare = computeFare(feed, itineraryFor("WEST", "EAST", "08:00:00"));
    expect(fare.total).toBe(4);
  });

  it("reports a walking journey as unpriced", () => {
    const walkOnly: Itinerary = {
      legs: [
        { kind: "access", toStopId: "A", toStopName: "A", departure: 0, arrival: 0, seconds: 0 },
      ],
      date: MONDAY,
      departure: 0,
      arrival: 0,
      totalSeconds: 0,
      boardings: 0,
      transfers: 0,
    };
    const fare = computeFare(feed, walkOnly);
    expect(fare.reason).toBe("walk-only");
    expect(fare.total).toBeUndefined();
  });

  it("reports a feed with no fares", () => {
    const fare = computeFare(
      { ...feed, fareAttributes: [], fareRules: [] },
      itineraryFor("NORTH", "HARBOUR", "07:45:00"),
    );
    expect(fare.reason).toBe("no-fares-defined");
    expect(fare.legs.every((leg) => leg.fare === undefined)).toBe(true);
  });

  it("reports a leg with no applicable fare", () => {
    const fare = computeFare(
      {
        ...feed,
        fareRules: feed.fareRules.filter((rule) => rule.routeId !== "R2"),
      },
      itineraryFor("NORTH", "HARBOUR", "07:45:00"),
    );
    expect(fare.reason).toBe("leg-without-fare");
    expect(fare.total).toBeUndefined();
  });

  it("refuses to total across currencies", () => {
    const mixed = rivertownFeed({
      "fare_attributes.txt":
        "fare_id,price,currency_type,payment_method,transfers,transfer_duration\nF_BASE,2.50,GBP,1,0,\nF_EUR,3.00,EUR,1,0,",
      "fare_rules.txt": "fare_id,route_id\nF_BASE,R2\nF_EUR,R1",
    });
    const fare = computeFare(mixed, itineraryFor("NORTH", "HARBOUR", "07:45:00"));
    expect(fare.reason).toBe("mixed-currencies");
    expect(fare.total).toBeUndefined();
  });

  it("charges again once the transfer allowance runs out", () => {
    const strict = rivertownFeed({
      "fare_attributes.txt":
        "fare_id,price,currency_type,payment_method,transfers,transfer_duration\nF_BASE,2.50,GBP,1,0,\nF_LONG,4.00,GBP,1,0,",
    });
    const fare = computeFare(strict, itineraryFor("NORTH", "HARBOUR", "07:45:00"));
    expect(fare.total).toBe(5);
    expect(fare.legs.every((leg) => !leg.coveredByTransfer)).toBe(true);
  });

  it("charges again once the transfer window expires", () => {
    const brief = rivertownFeed({
      "fare_attributes.txt":
        "fare_id,price,currency_type,payment_method,transfers,transfer_duration\nF_BASE,2.50,GBP,1,1,60\nF_LONG,4.00,GBP,1,0,",
    });
    const fare = computeFare(brief, itineraryFor("NORTH", "HARBOUR", "07:45:00"));
    expect(fare.total).toBe(5);
  });

  it("reuses a supplied matcher", () => {
    const matcher = FareMatcher.build(feed);
    const itinerary = itineraryFor("NORTH", "HARBOUR", "07:45:00");
    expect(computeFare(feed, itinerary, matcher).total).toBe(computeFare(feed, itinerary).total);
  });
});

describe("coversLeg", () => {
  const fare: FareAttribute = {
    fareId: "F",
    price: 2.5,
    currencyType: "GBP",
    paymentMethod: 1,
    transfers: 1,
    agencyId: undefined,
    transferDuration: 3600,
    line: 1,
  };
  const leg = { departure: 1000 } as RideLeg;

  it("covers a leg within both limits", () => {
    expect(coversLeg({ fare, purchasedAt: 0, transfersUsed: 0 }, leg)).toBe(true);
  });

  it("stops covering once the transfer count is spent", () => {
    expect(coversLeg({ fare, purchasedAt: 0, transfersUsed: 1 }, leg)).toBe(false);
  });

  it("stops covering once the window expires", () => {
    expect(coversLeg({ fare, purchasedAt: -4000, transfersUsed: 0 }, leg)).toBe(false);
  });

  it("covers indefinitely when transfers are unlimited and no window is set", () => {
    const generous = { ...fare, transfers: undefined, transferDuration: undefined };
    expect(coversLeg({ fare: generous, purchasedAt: -100_000, transfersUsed: 99 }, leg)).toBe(true);
  });
});

describe("describeFareableLeg", () => {
  it("collects every zone the leg touches", () => {
    const itinerary = itineraryFor("CENTRAL_A", "HARBOUR", "07:00:00");
    const ride = itinerary.legs.find((leg) => leg.kind === "ride") as RideLeg;
    const described = describeFareableLeg(ride, buildZoneIndex(feed));
    expect(described.originZoneId).toBe("A");
    expect(described.destinationZoneId).toBe("B");
    expect(described.zonesTouched.has("A")).toBe(true);
    expect(described.zonesTouched.has("B")).toBe(true);
  });

  it("omits zones for stops without one", () => {
    const itinerary = itineraryFor("CENTRAL_A", "HARBOUR", "07:00:00");
    const ride = itinerary.legs.find((leg) => leg.kind === "ride") as RideLeg;
    expect(describeFareableLeg(ride, new Map()).zonesTouched.size).toBe(0);
  });
});

describe("fare rendering", () => {
  it("formats a price with two decimal places", () => {
    expect(formatFare(2.5, "GBP")).toBe("2.50 GBP");
    expect(formatFare(0, "EUR")).toBe("0.00 EUR");
  });

  it("describes a priced journey", () => {
    expect(describeFare(computeFare(feed, itineraryFor("NORTH", "HARBOUR", "07:45:00")))).toBe(
      "2.50 GBP",
    );
  });

  it("explains each reason a journey is unpriced", () => {
    for (const reason of ["walk-only", "no-fares-defined", "leg-without-fare", "mixed-currencies"] as const) {
      const described = describeFare({ legs: [], total: undefined, currency: undefined, reason });
      expect(described.length).toBeGreaterThan(5);
    }
    expect(describeFare({ legs: [], total: undefined, currency: undefined, reason: undefined })).toBe(
      "no fare",
    );
  });
});
