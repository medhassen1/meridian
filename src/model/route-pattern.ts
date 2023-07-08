/**
 * Route patterns: the distinct stop sequences a route's vehicles actually
 * follow.
 *
 * RAPTOR does not scan routes, despite the name in the original paper. It
 * scans sequences of stops that share an ordering, so that "board the first
 * trip departing after time T" is a single position along one array. A GTFS
 * route rarely has that property — the same route number runs short workings,
 * express variants, and a different sequence at weekends — so the trips are
 * grouped by their actual call sequence instead.
 *
 * Two trips share a pattern when they call at the same stops in the same order
 * with the same boarding permissions. Boarding permissions belong in the key
 * because a trip that only sets down at a stop offers a different set of
 * journeys from one that also picks up there.
 */

import { BoardingRule, type StopTime } from "../feed/stop-times.js";
import type { TripWithCalls } from "../feed/feed.js";
import { patternIndex, type PatternIndex, type StopIndex } from "./ids.js";
import type { StopCatalogue } from "./stop-index.js";

/** A distinct stop sequence, together with the trips that follow it. */
export interface RoutePattern {
  readonly index: PatternIndex;
  readonly routeId: string;
  /** The direction every trip in the pattern runs, when they agree on one. */
  readonly directionId: number | undefined;
  /** The stops called at, in order. Always at least two. */
  readonly stops: readonly StopIndex[];
  /** Boarding permission at each position, parallel to {@link stops}. */
  readonly pickup: readonly BoardingRule[];
  /** Alighting permission at each position, parallel to {@link stops}. */
  readonly dropOff: readonly BoardingRule[];
  /** Trip ids following this pattern, ordered as in the timetable. */
  readonly tripIds: readonly string[];
  /** The headsign shared by every trip, when they agree on one. */
  readonly headsign: string | undefined;
}

/** A pattern under construction, before trips are ordered. */
interface PatternDraft {
  readonly key: string;
  readonly routeId: string;
  readonly stops: StopIndex[];
  readonly pickup: BoardingRule[];
  readonly dropOff: BoardingRule[];
  readonly trips: TripWithCalls[];
}

/**
 * The key identifying a pattern.
 *
 * Built from the route, the stop indices, and the boarding permissions. Stop
 * *indices* rather than ids keep the key short for a table with millions of
 * rows, and they are stable because the catalogue assigns them in sorted id
 * order.
 */
export function patternKeyOf(
  routeId: string,
  calls: readonly StopTime[],
  catalogue: StopCatalogue,
): string | undefined {
  const parts: string[] = [routeId];
  for (const call of calls) {
    const index = catalogue.indexOf(call.stopId);
    if (index === undefined) {
      // The call names a stop the feed does not define. The validator reports
      // it; here the whole trip is skipped, because a pattern with a hole in
      // it would silently teleport passengers.
      return undefined;
    }
    parts.push(`${index}:${call.pickupType}:${call.dropOffType}`);
  }
  return parts.join("|");
}

/**
 * Groups trips into patterns.
 *
 * Trips whose calls reference an unknown stop are dropped. Patterns are
 * returned in ascending key order so that pattern indices are reproducible.
 */
export function buildPatterns(
  trips: readonly TripWithCalls[],
  catalogue: StopCatalogue,
): { patterns: RoutePattern[]; skippedTripIds: string[] } {
  const drafts = new Map<string, PatternDraft>();
  const skippedTripIds: string[] = [];

  for (const trip of trips) {
    const key = patternKeyOf(trip.routeId, trip.calls, catalogue);
    if (key === undefined) {
      skippedTripIds.push(trip.tripId);
      continue;
    }

    let draft = drafts.get(key);
    if (draft === undefined) {
      const stops: StopIndex[] = [];
      const pickup: BoardingRule[] = [];
      const dropOff: BoardingRule[] = [];
      for (const call of trip.calls) {
        stops.push(catalogue.indexOf(call.stopId) as StopIndex);
        pickup.push(call.pickupType);
        dropOff.push(call.dropOffType);
      }
      draft = { key, routeId: trip.routeId, stops, pickup, dropOff, trips: [] };
      drafts.set(key, draft);
    }
    draft.trips.push(trip);
  }

  const ordered = Array.from(drafts.values()).sort((a, b) => a.key.localeCompare(b.key));
  const patterns: RoutePattern[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const draft = ordered[index] as PatternDraft;
    // Trips are ordered by their departure from the first stop; ties break on
    // trip id so the order is total.
    const sortedTrips = draft.trips.slice().sort((a, b) => {
      const left = (a.calls[0] as StopTime).departureTime;
      const right = (b.calls[0] as StopTime).departureTime;
      return left - right || a.tripId.localeCompare(b.tripId);
    });

    patterns.push({
      index: patternIndex(index),
      routeId: draft.routeId,
      directionId: sharedValue(sortedTrips.map((trip) => trip.directionId)),
      stops: draft.stops,
      pickup: draft.pickup,
      dropOff: draft.dropOff,
      tripIds: sortedTrips.map((trip) => trip.tripId),
      headsign: sharedValue(sortedTrips.map((trip) => trip.tripHeadsign)),
    });
  }

  return { patterns, skippedTripIds };
}

/** Position of a stop within a pattern, or `-1` when it is not called at. */
export function positionOf(pattern: RoutePattern, stop: StopIndex): number {
  return pattern.stops.indexOf(stop);
}

/**
 * Every position at which a pattern calls at a stop.
 *
 * A loop route calls at its terminus twice, and boarding at the first
 * occurrence is a different journey from boarding at the second.
 */
export function positionsOf(pattern: RoutePattern, stop: StopIndex): number[] {
  const positions: number[] = [];
  for (let index = 0; index < pattern.stops.length; index += 1) {
    if (pattern.stops[index] === stop) {
      positions.push(index);
    }
  }
  return positions;
}

/** True when passengers may board at a position. */
export function allowsBoardingAt(pattern: RoutePattern, position: number): boolean {
  // The final stop never offers a useful boarding, whatever the feed says.
  if (position >= pattern.stops.length - 1) {
    return false;
  }
  return pattern.pickup[position] !== BoardingRule.None;
}

/** True when passengers may alight at a position. */
export function allowsAlightingAt(pattern: RoutePattern, position: number): boolean {
  if (position <= 0) {
    return false;
  }
  return pattern.dropOff[position] !== BoardingRule.None;
}

/** True when the pattern returns to a stop it has already called at. */
export function isLoop(pattern: RoutePattern): boolean {
  return new Set(pattern.stops).size !== pattern.stops.length;
}

/**
 * Indexes patterns by the stops they call at.
 *
 * This is the structure RAPTOR's round loop reads: given the stops improved in
 * the last round, which patterns are worth scanning. Each entry pairs a
 * pattern with the earliest position at which the stop is reached, since
 * boarding later along the same pattern can never help.
 */
export function indexPatternsByStop(
  patterns: readonly RoutePattern[],
  stopCount: number,
): ReadonlyArray<readonly PatternIndex[]> {
  const byStop: PatternIndex[][] = Array.from({ length: stopCount }, () => []);
  for (const pattern of patterns) {
    const seen = new Set<StopIndex>();
    for (const stop of pattern.stops) {
      if (seen.has(stop)) {
        continue;
      }
      seen.add(stop);
      (byStop[stop] as PatternIndex[]).push(pattern.index);
    }
  }
  return byStop;
}

/** The single value shared by every entry, or `undefined` when they differ. */
function sharedValue<T>(values: readonly (T | undefined)[]): T | undefined {
  const first = values[0];
  if (first === undefined) {
    return undefined;
  }
  return values.every((value) => value === first) ? first : undefined;
}
