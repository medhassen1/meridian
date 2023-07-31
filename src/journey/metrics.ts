/**
 * Measuring an itinerary.
 *
 * Every figure here is derived from the legs rather than accumulated during
 * the search, so the two can never disagree. A passenger comparing two options
 * cares about a handful of numbers — how long, how many changes, how much
 * walking, how much standing about — and each of them is a sum over legs.
 */

import { duration, formatDuration, type Duration } from "../time/duration.js";
import { isRide, type JourneyLeg, type RideLeg } from "./leg.js";
import { ridesOf, type Itinerary } from "./itinerary.js";

/** The measurable properties of an itinerary. */
export interface JourneyMetrics {
  /** Total elapsed time. */
  readonly totalSeconds: number;
  /** Seconds aboard a vehicle. */
  readonly rideSeconds: number;
  /** Seconds on foot, including access and egress. */
  readonly walkSeconds: number;
  /** Seconds waiting at a stop. */
  readonly waitSeconds: number;
  /** Number of vehicle boardings. */
  readonly boardings: number;
  /** Number of changes between vehicles. */
  readonly transfers: number;
  /** Intermediate stops passed through while aboard. */
  readonly intermediateStops: number;
  /** Longest single wait, in seconds. */
  readonly longestWaitSeconds: number;
  /** Longest single walk, in seconds. */
  readonly longestWalkSeconds: number;
  /**
   * Additional expected wait for headway-based legs, in seconds.
   *
   * Zero for a fully scheduled journey. When non-zero the arrival time should
   * be read as a best case, since only the headway was published.
   */
  readonly expectedExtraWaitSeconds: number;
}

/** Measures an itinerary. */
export function measureJourney(itinerary: Itinerary): JourneyMetrics {
  let rideSeconds = 0;
  let walkSeconds = 0;
  let intermediateStops = 0;
  let longestWalk = 0;
  let expectedExtraWait = 0;

  for (const leg of itinerary.legs) {
    if (isRide(leg)) {
      rideSeconds += leg.seconds;
      intermediateStops += leg.intermediateStops.length;
      expectedExtraWait += leg.expectedWaitSeconds;
      continue;
    }
    walkSeconds += leg.seconds;
    if (leg.seconds > longestWalk) {
      longestWalk = leg.seconds;
    }
  }

  const waits = waitsBetweenLegs(itinerary.legs);
  const waitSeconds = waits.reduce((total, value) => total + value, 0);

  return {
    totalSeconds: itinerary.totalSeconds,
    rideSeconds,
    walkSeconds,
    waitSeconds,
    boardings: itinerary.boardings,
    transfers: itinerary.transfers,
    intermediateStops,
    longestWaitSeconds: waits.reduce((longest, value) => Math.max(longest, value), 0),
    longestWalkSeconds: longestWalk,
    expectedExtraWaitSeconds: expectedExtraWait,
  };
}

/**
 * The gaps between consecutive legs, in seconds.
 *
 * A gap is time the passenger spends at a stop: they have arrived and the next
 * leg has not started. Negative gaps cannot occur in a well formed itinerary
 * and are clamped to zero rather than propagated.
 */
export function waitsBetweenLegs(legs: readonly JourneyLeg[]): number[] {
  const waits: number[] = [];
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1] as JourneyLeg;
    const current = legs[index] as JourneyLeg;
    waits.push(Math.max(0, current.departure - previous.arrival));
  }
  return waits;
}

/**
 * The fraction of elapsed time spent moving.
 *
 * A useful single number for comparing options: a journey that is 90% movement
 * feels direct, one that is 40% movement feels like waiting around, even when
 * both take the same time.
 */
export function movementRatio(metrics: JourneyMetrics): number {
  if (metrics.totalSeconds <= 0) {
    return 1;
  }
  return (metrics.rideSeconds + metrics.walkSeconds) / metrics.totalSeconds;
}

/** Total elapsed time as a {@link Duration}. */
export function totalDuration(metrics: JourneyMetrics): Duration {
  return duration(Math.max(0, metrics.totalSeconds));
}

/**
 * A one-line summary: total time, changes, and walking.
 *
 * Written for a terminal, where a passenger scanning a list needs the three
 * figures that decide between options and nothing else.
 */
export function summariseJourney(metrics: JourneyMetrics): string {
  const parts = [formatDuration(duration(Math.max(0, metrics.totalSeconds)))];
  parts.push(
    metrics.transfers === 0
      ? "direct"
      : `${metrics.transfers} change${metrics.transfers === 1 ? "" : "s"}`,
  );
  if (metrics.walkSeconds > 0) {
    parts.push(`${formatDuration(duration(metrics.walkSeconds))} walking`);
  }
  if (metrics.expectedExtraWaitSeconds > 0) {
    parts.push(`+${formatDuration(duration(metrics.expectedExtraWaitSeconds))} expected wait`);
  }
  return parts.join(", ");
}

/**
 * The route names an itinerary uses, in travel order.
 *
 * Repeats are kept: boarding the same route twice after a change is a real
 * journey and hiding the repetition would misdescribe it.
 */
export function routeSequence(itinerary: Itinerary): string[] {
  return ridesOf(itinerary).map((ride: RideLeg) => ride.routeName);
}

/** Aggregate metrics across several itineraries, for a profile summary. */
export interface ProfileMetrics {
  readonly journeys: number;
  readonly fastestSeconds: number;
  readonly slowestSeconds: number;
  readonly medianSeconds: number;
  readonly fewestTransfers: number;
}

/**
 * Summarises a set of itineraries.
 *
 * Returns `undefined` for an empty set rather than zeroes, so a caller cannot
 * mistake "no journeys" for "instant journeys".
 */
export function summariseProfile(itineraries: readonly Itinerary[]): ProfileMetrics | undefined {
  if (itineraries.length === 0) {
    return undefined;
  }
  const durations = itineraries.map((itinerary) => itinerary.totalSeconds).sort((a, b) => a - b);
  const middle = Math.floor((durations.length - 1) / 2);

  return {
    journeys: itineraries.length,
    fastestSeconds: durations[0] as number,
    slowestSeconds: durations[durations.length - 1] as number,
    medianSeconds: durations[middle] as number,
    fewestTransfers: itineraries.reduce(
      (fewest, itinerary) => Math.min(fewest, itinerary.transfers),
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
