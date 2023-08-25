import { describe, expect, it } from "vitest";

import { ServiceDate } from "../../src/time/date.js";
import { loadFeed } from "../../src/feed/loader.js";
import { summariseFeed } from "../../src/feed/feed.js";
import { buildNetwork, assertNetworkConsistent } from "../../src/model/builder.js";
import { validateFeed } from "../../src/validate/report.js";
import { planJourney, planProfile } from "../../src/planner.js";
import { renderDepartureBoard, renderPlan } from "../../src/report/text.js";
import { planToJson } from "../../src/report/json.js";
import { computeReach } from "../../src/isochrone/reach.js";
import {
  EXCEPTION_MONDAY,
  MONDAY,
  SATURDAY,
  rivertownFeed,
  rivertownNetwork,
  rivertownSource,
} from "../support/fixtures.js";

describe("the Rivertown fixture", () => {
  it("loads without errors", () => {
    const result = loadFeed(rivertownSource());
    expect(result.feed).toBeDefined();
    expect(result.diagnostics.bySeverity("error")).toEqual([]);
  });

  it("summarises to the expected counts", () => {
    const summary = summariseFeed(rivertownFeed());
    expect(summary.agencies).toBe(1);
    expect(summary.stops).toBe(10);
    expect(summary.boardableStops).toBe(9);
    expect(summary.routes).toBe(5);
    expect(summary.trips).toBe(10);
    expect(summary.services).toBe(2);
  });

  it("compiles into a consistent network", () => {
    const built = buildNetwork(rivertownFeed());
    expect(() => assertNetworkConsistent(built.network)).not.toThrow();
    expect(built.network.statistics().patterns).toBeGreaterThan(0);
  });

  it("expands the headway-based route into four runs", () => {
    const built = buildNetwork(rivertownFeed());
    expect(built.generatedRuns.size).toBe(4);
    expect(Array.from(built.generatedRuns.keys()).sort()).toEqual([
      "R4-T#0",
      "R4-T#1",
      "R4-T#2",
      "R4-T#3",
    ]);
  });

  it("generates footpaths only between the three central stops", () => {
    const network = rivertownNetwork();
    const centralA = network.requireStop("CENTRAL_A");
    const neighbours = network.transfers
      .neighbours(centralA)
      .map((stop) => network.stops.idAt(stop))
      .sort();
    expect(neighbours).toEqual(["CENTRAL_B", "MARKET"]);

    const harbour = network.requireStop("HARBOUR");
    expect(network.transfers.from(harbour)).toEqual([]);
  });

  it("honours the published transfer time over the generated walk", () => {
    const network = rivertownNetwork();
    const seconds = network.transfers.secondsBetween(
      network.requireStop("CENTRAL_B"),
      network.requireStop("CENTRAL_A"),
    );
    expect(seconds).toBe(60);
  });
});

describe("planning across the Rivertown network", () => {
  const network = rivertownNetwork();

  it("finds the two-vehicle journey from Northgate to the Harbour", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "07:45:00",
    });

    expect(result.journeys.length).toBeGreaterThan(0);
    const best = result.journeys[0];
    expect(best).toBeDefined();
    if (best === undefined) {
      return;
    }

    expect(best.itinerary.boardings).toBe(2);
    // Leaves on the 07:50 tram and arrives on the 09:00 bus.
    expect(best.itinerary.departure).toBe(7 * 3600 + 50 * 60);
    expect(best.itinerary.arrival).toBe(9 * 3600);
    expect(best.metrics.transfers).toBe(1);
  });

  it("uses the station's other platform via the published transfer", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "07:45:00",
    });
    const best = result.journeys[0];
    const walk = best?.itinerary.legs.find((leg) => leg.kind === "walk");
    expect(walk).toBeDefined();
    expect(walk?.seconds).toBe(60);
  });

  it("charges one fare for the whole journey, the transfer being covered", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "07:45:00",
    });
    const best = result.journeys[0];
    expect(best?.fare.total).toBe(2.5);
    expect(best?.fare.currency).toBe("GBP");
    expect(best?.fare.legs.filter((leg) => leg.coveredByTransfer)).toHaveLength(1);
  });

  it("finds a direct journey when one exists", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "07:00:00",
    });
    const best = result.journeys[0];
    expect(best?.itinerary.boardings).toBe(1);
    expect(best?.itinerary.arrival).toBe(8 * 3600 + 30 * 60);
  });

  it("expands a station origin to both its platforms", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL" },
      to: { kind: "stop", stopId: "SOUTH" },
      date: MONDAY,
      departAfter: "07:00:00",
    });
    const best = result.journeys[0];
    // Only platform B is served by the tram to Southbank.
    expect(best?.itinerary.legs.some((leg) => leg.kind === "ride")).toBe(true);
    expect(best?.itinerary.arrival).toBe(8 * 3600 + 15 * 60);
  });

  it("finds no journey on a date with no service", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: ServiceDate.parse("20231001"),
      departAfter: "08:00:00",
    });
    expect(result.journeys).toEqual([]);
  });

  it("applies the calendar exception that swaps weekday for weekend", () => {
    const weekday = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "07:00:00",
    });
    const swapped = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: EXCEPTION_MONDAY,
      departAfter: "07:00:00",
    });

    expect(weekday.journeys[0]?.itinerary.departure).toBe(8 * 3600);
    // On the exception date only the weekend timetable runs.
    expect(swapped.journeys[0]?.itinerary.departure).toBe(10 * 3600);
  });

  it("runs the weekend timetable on a Saturday", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: SATURDAY,
      departAfter: "07:00:00",
    });
    expect(result.journeys[0]?.itinerary.arrival).toBe(10 * 3600 + 40 * 60);
  });

  it("carries a journey past midnight into the next calendar day", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "stop", stopId: "SOUTH" },
      date: MONDAY,
      departAfter: "23:00:00",
    });

    const best = result.journeys[0];
    expect(best?.itinerary.departure).toBe(23 * 3600 + 50 * 60);
    // 24:15:00 on Monday's anchor is 00:15 on Tuesday.
    expect(best?.itinerary.arrival).toBe(24 * 3600 + 15 * 60);
  });

  it("finds a vehicle anchored to the previous service date after midnight", () => {
    const result = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_B" },
      to: { kind: "stop", stopId: "SOUTH" },
      // Tuesday: the vehicle it must catch is Monday's, calling at 24:02.
      date: ServiceDate.parse("20230606"),
      departAfter: "00:00:00",
    });

    const best = result.journeys[0];
    expect(best).toBeDefined();
    // 24:02 on Monday's anchor is 00:02 on Tuesday.
    expect(best?.itinerary.departure).toBe(2 * 60);
    expect(best?.itinerary.arrival).toBe(15 * 60);
    const ride = best?.itinerary.legs.find((leg) => leg.kind === "ride");
    expect(ride?.kind === "ride" ? ride.serviceDate.toCompact() : "").toBe("20230605");
  });

  it("respects a wheelchair accessibility filter", () => {
    const unrestricted = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "08:45:00",
    });
    const accessible = planJourney(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      to: { kind: "stop", stopId: "HARBOUR" },
      date: MONDAY,
      departAfter: "08:45:00",
      requireWheelchair: true,
    });

    // The 09:00 departure is not marked accessible, so the filter removes it.
    expect(unrestricted.journeys.length).toBeGreaterThan(0);
    expect(accessible.journeys).toEqual([]);
  });

  it("restricts the search to a chosen mode", () => {
    const railOnly = planJourney(network, {
      from: { kind: "stop", stopId: "WEST" },
      to: { kind: "stop", stopId: "EAST" },
      date: MONDAY,
      departAfter: "08:00:00",
      allowedRouteTypes: [2],
    });
    expect(railOnly.journeys[0]?.itinerary.boardings).toBe(1);

    const busOnly = planJourney(network, {
      from: { kind: "stop", stopId: "WEST" },
      to: { kind: "stop", stopId: "EAST" },
      date: MONDAY,
      departAfter: "08:00:00",
      allowedRouteTypes: [3],
    });
    expect(busOnly.journeys).toEqual([]);
  });

  it("returns several departures from a profile search", () => {
    const result = planProfile(
      network,
      {
        from: { kind: "stop", stopId: "CENTRAL_A" },
        to: { kind: "stop", stopId: "HARBOUR" },
        date: MONDAY,
        departAfter: "07:30:00",
      },
      { windowSeconds: 2 * 3600 },
    );

    const departures = result.journeys.map((journey) => journey.itinerary.departure).sort((a, b) => a - b);
    expect(departures).toEqual([8 * 3600, 8 * 3600 + 30 * 60, 9 * 3600]);
  });
});

describe("rendering Rivertown results", () => {
  const network = rivertownNetwork();
  const plan = planJourney(network, {
    from: { kind: "stop", stopId: "NORTH" },
    to: { kind: "stop", stopId: "HARBOUR" },
    date: MONDAY,
    departAfter: "07:45:00",
  });

  it("renders a stable text plan", () => {
    const text = renderPlan(plan);
    expect(text).toContain("Option 1");
    expect(text).toContain("Northgate");
    expect(text).toContain("Harbour");
    expect(renderPlan(plan)).toBe(text);
  });

  it("renders a departure board", () => {
    const board = renderDepartureBoard(plan);
    expect(board.split("\n")[0]).toContain("Depart");
    expect(board).toContain("07:50");
    expect(board).toContain("09:00");
  });

  it("renders JSON with sorted keys", () => {
    const json = planToJson(plan);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["date", "journeys", "statistics"]);
    expect(planToJson(plan)).toBe(json);
  });
});

describe("validating Rivertown", () => {
  it("reports no errors", () => {
    const report = validateFeed(rivertownFeed());
    expect(report.errors).toBe(0);
  });

  it("notices the withdrawn route and the unserved stop", () => {
    const report = validateFeed(rivertownFeed());
    const rules = new Set(report.diagnostics.map((entry) => entry.rule));
    expect(rules.has("cover.route_without_trips")).toBe(true);
    expect(rules.has("cover.unserved_stop")).toBe(true);
  });
});

describe("reachability from Rivertown's centre", () => {
  it("reaches more stops with a larger budget", () => {
    const network = rivertownNetwork();
    const short = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 15 * 60,
    });
    const long = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 60 * 60,
    });

    expect(long.reached.length).toBeGreaterThan(short.reached.length);
    expect(short.reached.map((stop) => stop.stopId)).toContain("MARKET");
  });
});
