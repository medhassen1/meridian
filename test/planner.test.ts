import { describe, expect, it } from "vitest";

import { ServiceDate } from "../src/time/date.js";
import {
  DEFAULT_PLAN_LIMIT,
  fastestJourney,
  fewestTransfers,
  isEmpty,
  planJourney,
  planProfile,
} from "../src/planner.js";
import { VERSION } from "../src/index.js";
import { MONDAY, rivertownNetwork } from "./support/fixtures.js";

const network = rivertownNetwork();

const request = {
  from: { kind: "stop" as const, stopId: "NORTH" },
  to: { kind: "stop" as const, stopId: "HARBOUR" },
  date: MONDAY,
  departAfter: "07:45:00",
};

describe("planJourney", () => {
  it("returns journeys with metrics and fares", () => {
    const result = planJourney(network, request);
    expect(result.journeys.length).toBeGreaterThan(0);
    const first = result.journeys[0];
    expect(first?.itinerary.boardings).toBe(2);
    expect(first?.metrics.totalSeconds).toBeGreaterThan(0);
    expect(first?.fare.total).toBe(2.5);
  });

  it("records the query date and search statistics", () => {
    const result = planJourney(network, request);
    expect(result.date.toCompact()).toBe("20230605");
    expect(result.statistics.patternScans).toBeGreaterThan(0);
  });

  it("returns nothing on a date with no service", () => {
    const result = planJourney(network, { ...request, date: ServiceDate.parse("20231001") });
    expect(result.journeys).toEqual([]);
    expect(isEmpty(result)).toBe(true);
  });

  it("honours a result limit", () => {
    const result = planJourney(network, { ...request, maxBoardings: 4 }, { limit: 1 });
    expect(result.journeys).toHaveLength(1);
  });

  it("uses a documented default limit", () => {
    expect(DEFAULT_PLAN_LIMIT).toBeGreaterThan(0);
    const result = planJourney(network, request);
    expect(result.journeys.length).toBeLessThanOrEqual(DEFAULT_PLAN_LIMIT);
  });

  it("can return every journey rather than the frontier", () => {
    const frontier = planJourney(network, request, { paretoOnly: true, limit: 20 });
    const all = planJourney(network, request, { paretoOnly: false, limit: 20 });
    expect(all.journeys.length).toBeGreaterThanOrEqual(frontier.journeys.length);
  });

  it("honours a sort order", () => {
    const byTransfers = planJourney(network, request, { order: "transfers", paretoOnly: false });
    const transfers = byTransfers.journeys.map((journey) => journey.itinerary.transfers);
    expect(transfers).toEqual(transfers.slice().sort((a, b) => a - b));
  });

  it("can skip fare computation", () => {
    const result = planJourney(network, request, { computeFares: false });
    expect(result.journeys[0]?.fare.total).toBeUndefined();
    expect(result.journeys[0]?.fare.reason).toBe("no-fares-defined");
  });

  it("finds the fastest journey", () => {
    const result = planJourney(network, request);
    expect(fastestJourney(result)?.itinerary.arrival).toBe(
      Math.min(...result.journeys.map((journey) => journey.itinerary.arrival)),
    );
  });

  it("finds the journey with fewest changes", () => {
    const result = planJourney(network, request);
    expect(fewestTransfers(result)?.itinerary.transfers).toBe(
      Math.min(...result.journeys.map((journey) => journey.itinerary.transfers)),
    );
  });

  it("returns undefined selectors for an empty plan", () => {
    const result = planJourney(network, { ...request, date: ServiceDate.parse("20231001") });
    expect(fastestJourney(result)).toBeUndefined();
    expect(fewestTransfers(result)).toBeUndefined();
  });
});

describe("planProfile", () => {
  const profileRequest = {
    from: { kind: "stop" as const, stopId: "CENTRAL_A" },
    to: { kind: "stop" as const, stopId: "HARBOUR" },
    date: MONDAY,
    departAfter: "07:30:00",
  };

  it("returns one journey per worthwhile departure", () => {
    const result = planProfile(network, profileRequest, { windowSeconds: 2 * 3600 });
    expect(result.journeys.map((journey) => journey.itinerary.departure)).toEqual([
      8 * 3600,
      8 * 3600 + 30 * 60,
      9 * 3600,
    ]);
  });

  it("prices every departure", () => {
    const result = planProfile(network, profileRequest, { windowSeconds: 2 * 3600 });
    expect(result.journeys.every((journey) => journey.fare.total === 2.5)).toBe(true);
  });

  it("honours the profile's own journey cap", () => {
    const result = planProfile(network, profileRequest, { windowSeconds: 2 * 3600, maxJourneys: 2 });
    expect(result.journeys).toHaveLength(2);
  });

  it("lets an explicit limit override the profile's", () => {
    const result = planProfile(
      network,
      profileRequest,
      { windowSeconds: 2 * 3600, maxJourneys: 3 },
      { limit: 1 },
    );
    expect(result.journeys).toHaveLength(1);
  });

  it("returns nothing when no service runs", () => {
    const result = planProfile(
      network,
      { ...profileRequest, date: ServiceDate.parse("20231001") },
      { windowSeconds: 3600 },
    );
    expect(isEmpty(result)).toBe(true);
  });
});

describe("the package entry point", () => {
  it("declares a version matching the CLI", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
