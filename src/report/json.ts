/**
 * JSON rendering with deterministic key order.
 *
 * Every object here is built with its keys in ascending lexicographic order,
 * by hand, rather than by serialising a domain object and hoping. That makes
 * the wire format a stated property of this module — reviewable in one place,
 * diffable between runs, and safe to assert against byte for byte — instead of
 * an accident of how the objects happened to be constructed.
 */

import { SECONDS_PER_DAY } from "../time/date.js";
import { formatTimeOfDay, timeOfDay } from "../time/time-of-day.js";
import { isRide, type JourneyLeg } from "../journey/leg.js";
import type { Itinerary } from "../journey/itinerary.js";
import type { JourneyMetrics } from "../journey/metrics.js";
import type { JourneyFare } from "../fares/compute.js";
import type { PlannedJourney, PlanResult } from "../planner.js";
import type { ReachResult } from "../isochrone/reach.js";

/** Options controlling JSON rendering. */
export interface JsonOptions {
  /** Indentation width; zero produces a single line. Defaults to 2. */
  readonly indent?: number;
  /** When true, stops passed through are included in ride legs. */
  readonly includeIntermediateStops?: boolean;
}

/** Serialises a plan. */
export function planToJson(result: PlanResult, options: JsonOptions = {}): string {
  return JSON.stringify(
    {
      date: result.date.toCompact(),
      journeys: result.journeys.map((journey) => journeyObject(journey, options)),
      statistics: {
        footpathsExamined: result.statistics.footpathsExamined,
        labelsImproved: result.statistics.labelsImproved,
        patternScans: result.statistics.patternScans,
        rounds: result.statistics.rounds,
        tripLookups: result.statistics.tripLookups,
      },
    },
    null,
    options.indent ?? 2,
  );
}

/** Serialises a single journey. */
export function journeyToJson(journey: PlannedJourney, options: JsonOptions = {}): string {
  return JSON.stringify(journeyObject(journey, options), null, options.indent ?? 2);
}

/** Serialises a reachability result. */
export function reachToJson(result: ReachResult, options: JsonOptions = {}): string {
  return JSON.stringify(
    {
      budgetSeconds: result.budgetSeconds,
      date: result.date.toCompact(),
      departAfter: formatTimeOfDay(result.departAfter),
      origin: result.origin,
      reached: result.reached.map((stop) => ({
        boardings: stop.boardings,
        latitude: stop.latitude,
        longitude: stop.longitude,
        seconds: stop.seconds,
        stopId: stop.stopId,
        stopName: stop.stopName,
      })),
    },
    null,
    options.indent ?? 2,
  );
}

/**
 * Renders an absolute time for the wire.
 *
 * Two fields rather than one: the second count is what a program should
 * compute with, and the clock string is what a human reading the payload
 * needs. Emitting only the clock would lose the day a journey crosses into.
 */
export function timeObject(seconds: number): { clock: string; dayOffset: number; seconds: number } {
  const dayOffset = Math.floor(seconds / SECONDS_PER_DAY);
  const withinDay = seconds - dayOffset * SECONDS_PER_DAY;
  return {
    clock: formatTimeOfDay(timeOfDay(withinDay)),
    dayOffset,
    seconds,
  };
}

function journeyObject(
  journey: PlannedJourney,
  options: JsonOptions,
): Record<string, unknown> {
  return {
    arrival: timeObject(journey.itinerary.arrival),
    boardings: journey.itinerary.boardings,
    departure: timeObject(journey.itinerary.departure),
    fare: fareObject(journey.fare),
    legs: journey.itinerary.legs.map((leg) => legObject(leg, options)),
    metrics: metricsObject(journey.metrics),
    totalSeconds: journey.itinerary.totalSeconds,
    transfers: journey.itinerary.transfers,
  };
}

function legObject(leg: JourneyLeg, options: JsonOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    arrival: timeObject(leg.arrival),
    departure: timeObject(leg.departure),
    kind: leg.kind,
    seconds: leg.seconds,
  };

  if (isRide(leg)) {
    const ride: Record<string, unknown> = {
      ...base,
      expectedWaitSeconds: leg.expectedWaitSeconds,
      fromStopId: leg.fromStopId,
      fromStopName: leg.fromStopName,
      headsign: leg.headsign ?? null,
      routeId: leg.routeId,
      routeName: leg.routeName,
      routeType: leg.routeType,
      serviceDate: leg.serviceDate.toCompact(),
      toStopId: leg.toStopId,
      toStopName: leg.toStopName,
      tripId: leg.tripId,
    };
    if (options.includeIntermediateStops ?? false) {
      ride["intermediateStops"] = leg.intermediateStops.map((call) => ({
        arrival: timeObject(call.arrival),
        departure: timeObject(call.departure),
        stopId: call.stopId,
        stopName: call.stopName,
      }));
    }
    return sortKeys(ride);
  }

  switch (leg.kind) {
    case "access":
      return sortKeys({ ...base, toStopId: leg.toStopId, toStopName: leg.toStopName });
    case "walk":
      return sortKeys({
        ...base,
        fromStopId: leg.fromStopId,
        fromStopName: leg.fromStopName,
        published: leg.published,
        toStopId: leg.toStopId,
        toStopName: leg.toStopName,
      });
    case "egress":
      return sortKeys({ ...base, fromStopId: leg.fromStopId, fromStopName: leg.fromStopName });
  }
}

function metricsObject(metrics: JourneyMetrics): Record<string, unknown> {
  return {
    boardings: metrics.boardings,
    expectedExtraWaitSeconds: metrics.expectedExtraWaitSeconds,
    intermediateStops: metrics.intermediateStops,
    longestWaitSeconds: metrics.longestWaitSeconds,
    longestWalkSeconds: metrics.longestWalkSeconds,
    rideSeconds: metrics.rideSeconds,
    totalSeconds: metrics.totalSeconds,
    transfers: metrics.transfers,
    waitSeconds: metrics.waitSeconds,
    walkSeconds: metrics.walkSeconds,
  };
}

function fareObject(fare: JourneyFare): Record<string, unknown> {
  return {
    currency: fare.currency ?? null,
    legs: fare.legs.map((entry) => ({
      amount: entry.amount,
      coveredByTransfer: entry.coveredByTransfer,
      fareId: entry.fare?.fareId ?? null,
      fromStopId: entry.leg.fromStopId,
      toStopId: entry.leg.toStopId,
    })),
    reason: fare.reason ?? null,
    total: fare.total ?? null,
  };
}

/** Returns a copy of the object with keys in ascending order. */
export function sortKeys(object: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    sorted[key] = object[key];
  }
  return sorted;
}

/** Serialises an itinerary alone, without metrics or fare. */
export function itineraryToJson(itinerary: Itinerary, options: JsonOptions = {}): string {
  return JSON.stringify(
    {
      arrival: timeObject(itinerary.arrival),
      boardings: itinerary.boardings,
      date: itinerary.date.toCompact(),
      departure: timeObject(itinerary.departure),
      legs: itinerary.legs.map((leg) => legObject(leg, options)),
      totalSeconds: itinerary.totalSeconds,
      transfers: itinerary.transfers,
    },
    null,
    options.indent ?? 2,
  );
}
