/**
 * Per-pattern timetables.
 *
 * A timetable is two flat `Int32Array`s of arrival and departure seconds,
 * indexed `trip * stopCount + position`. Flat typed arrays rather than nested
 * objects because RAPTOR's inner loop walks one pattern's trips at one
 * position, which is a strided read the engine performs millions of times per
 * query.
 *
 * The central operation is "the earliest trip departing this position at or
 * after time T, among trips whose service is active". When the pattern's trips
 * are ordered consistently at every position — no vehicle overtakes another —
 * that is a binary search. Real feeds do contain overtaking, usually where an
 * express and a stopping service share a pattern, so the timetable detects it
 * at build time and falls back to a linear scan for the patterns affected.
 */

import { NetworkBuildError } from "../errors.js";
import type { TripWithCalls } from "../feed/feed.js";
import { tripIndex, type TripIndex } from "./ids.js";
import type { RoutePattern } from "./route-pattern.js";

/**
 * Predicate deciding whether a trip may be used.
 *
 * Takes a trip index rather than a service id so that a caller can combine
 * service activity with per-trip restrictions — accessibility, mode, a
 * particular operator — in one pass. Use {@link PatternTimetable.serviceIdAt}
 * and {@link PatternTimetable.tripIdAt} to read what the index refers to.
 */
export type TripFilter = (trip: TripIndex) => boolean;

/** A pattern's trips, as a flat time matrix. */
export class PatternTimetable {
  /** The pattern these trips follow. */
  readonly pattern: RoutePattern;

  /** Number of trips. */
  readonly tripCount: number;

  /** Number of stops in the pattern. */
  readonly stopCount: number;

  /** Trip ids, ordered as in the matrix. */
  readonly tripIds: readonly string[];

  /** Service id of each trip, parallel to {@link tripIds}. */
  readonly serviceIds: readonly string[];

  /**
   * True when trip order is consistent at every position, so a binary search
   * is sound. False when at least one trip overtakes another.
   */
  readonly isTotallyOrdered: boolean;

  private readonly arrivals: Int32Array;
  private readonly departures: Int32Array;

  private constructor(
    pattern: RoutePattern,
    tripIds: readonly string[],
    serviceIds: readonly string[],
    arrivals: Int32Array,
    departures: Int32Array,
    isTotallyOrdered: boolean,
  ) {
    this.pattern = pattern;
    this.tripIds = tripIds;
    this.serviceIds = serviceIds;
    this.arrivals = arrivals;
    this.departures = departures;
    this.tripCount = tripIds.length;
    this.stopCount = pattern.stops.length;
    this.isTotallyOrdered = isTotallyOrdered;
  }

  /**
   * Builds a timetable from the trips following a pattern.
   *
   * @throws {NetworkBuildError} if a trip's call count does not match the
   * pattern's, which would mean the pattern key was computed inconsistently.
   */
  static build(
    pattern: RoutePattern,
    tripsById: ReadonlyMap<string, TripWithCalls>,
  ): PatternTimetable {
    const stopCount = pattern.stops.length;
    const tripIds = pattern.tripIds;
    const arrivals = new Int32Array(tripIds.length * stopCount);
    const departures = new Int32Array(tripIds.length * stopCount);
    const serviceIds: string[] = [];

    for (let trip = 0; trip < tripIds.length; trip += 1) {
      const tripId = tripIds[trip] as string;
      const record = tripsById.get(tripId);
      if (record === undefined) {
        throw new NetworkBuildError(`pattern references unknown trip "${tripId}"`, { tripId });
      }
      if (record.calls.length !== stopCount) {
        throw new NetworkBuildError(
          `trip "${tripId}" has ${record.calls.length} calls but its pattern has ${stopCount}`,
          { tripId, calls: record.calls.length, stops: stopCount },
        );
      }
      serviceIds.push(record.serviceId);
      const base = trip * stopCount;
      for (let position = 0; position < stopCount; position += 1) {
        const call = record.calls[position];
        if (call === undefined) {
          throw new NetworkBuildError(`trip "${tripId}" is missing call ${position}`, { tripId });
        }
        arrivals[base + position] = call.arrivalTime;
        departures[base + position] = call.departureTime;
      }
    }

    return new PatternTimetable(
      pattern,
      tripIds,
      serviceIds,
      arrivals,
      departures,
      checkTotalOrder(departures, tripIds.length, stopCount),
    );
  }

  /** Arrival time of a trip at a position. */
  arrivalAt(trip: TripIndex, position: number): number {
    return this.arrivals[trip * this.stopCount + position] as number;
  }

  /** Departure time of a trip at a position. */
  departureAt(trip: TripIndex, position: number): number {
    return this.departures[trip * this.stopCount + position] as number;
  }

  /** The trip id at a trip index. */
  tripIdAt(trip: TripIndex): string {
    return this.tripIds[trip] as string;
  }

  /** The service id of a trip. */
  serviceIdAt(trip: TripIndex): string {
    return this.serviceIds[trip] as string;
  }

  /**
   * The earliest usable trip departing `position` at or after `time`, or
   * `undefined` when none qualifies.
   *
   * On a totally ordered pattern the starting point is found by binary search
   * and the first trip passing `permitted` wins, because no later trip can
   * depart earlier. On an overtaking pattern every trip has to be weighed, so
   * the earliest qualifying departure wins rather than the first encountered.
   */
  earliestTripAfter(
    position: number,
    time: number,
    permitted: TripFilter,
  ): TripIndex | undefined {
    if (position < 0 || position >= this.stopCount || this.tripCount === 0) {
      return undefined;
    }

    if (this.isTotallyOrdered) {
      for (
        let trip = this.firstDepartingAtOrAfter(position, time);
        trip < this.tripCount;
        trip += 1
      ) {
        if (permitted(tripIndex(trip))) {
          return tripIndex(trip);
        }
      }
      return undefined;
    }

    let best: number | undefined;
    let bestTime = Number.POSITIVE_INFINITY;
    for (let trip = 0; trip < this.tripCount; trip += 1) {
      const departure = this.departures[trip * this.stopCount + position] as number;
      if (departure < time || departure >= bestTime) {
        continue;
      }
      if (!permitted(tripIndex(trip))) {
        continue;
      }
      best = trip;
      bestTime = departure;
    }
    return best === undefined ? undefined : tripIndex(best);
  }

  /**
   * The latest usable trip arriving at `position` at or before `time`, used by
   * the arrive-by search.
   */
  latestTripBefore(
    position: number,
    time: number,
    permitted: TripFilter,
  ): TripIndex | undefined {
    if (position < 0 || position >= this.stopCount || this.tripCount === 0) {
      return undefined;
    }
    let best: number | undefined;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (let trip = this.tripCount - 1; trip >= 0; trip -= 1) {
      const arrival = this.arrivals[trip * this.stopCount + position] as number;
      if (arrival > time || arrival <= bestTime) {
        continue;
      }
      if (!permitted(tripIndex(trip))) {
        continue;
      }
      best = trip;
      bestTime = arrival;
    }
    return best === undefined ? undefined : tripIndex(best);
  }

  /** The earliest departure from a position across every trip. */
  earliestDeparture(position: number): number | undefined {
    if (this.tripCount === 0) {
      return undefined;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (let trip = 0; trip < this.tripCount; trip += 1) {
      const departure = this.departures[trip * this.stopCount + position] as number;
      if (departure < earliest) {
        earliest = departure;
      }
    }
    return earliest;
  }

  /** The latest arrival at a position across every trip. */
  latestArrival(position: number): number | undefined {
    if (this.tripCount === 0) {
      return undefined;
    }
    let latest = Number.NEGATIVE_INFINITY;
    for (let trip = 0; trip < this.tripCount; trip += 1) {
      const arrival = this.arrivals[trip * this.stopCount + position] as number;
      if (arrival > latest) {
        latest = arrival;
      }
    }
    return latest;
  }

  /**
   * Index of the first trip departing `position` at or after `time`, ignoring
   * service activity. Only sound on a totally ordered pattern.
   */
  private firstDepartingAtOrAfter(position: number, time: number): number {
    let low = 0;
    let high = this.tripCount;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.departures[mid * this.stopCount + position] as number) < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }
}

/**
 * True when departures are non-decreasing across trips at every position.
 *
 * Checked once per pattern at build time. The cost is one pass over the
 * matrix, against a per-query saving of turning every trip lookup from linear
 * into logarithmic.
 */
function checkTotalOrder(departures: Int32Array, tripCount: number, stopCount: number): boolean {
  for (let trip = 1; trip < tripCount; trip += 1) {
    const previous = (trip - 1) * stopCount;
    const current = trip * stopCount;
    for (let position = 0; position < stopCount; position += 1) {
      if ((departures[current + position] as number) < (departures[previous + position] as number)) {
        return false;
      }
    }
  }
  return true;
}
