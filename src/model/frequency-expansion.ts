/**
 * Turning headway-based trips into concrete ones.
 *
 * `frequencies.txt` publishes a trip once and says it repeats every N seconds.
 * The routing engine could carry that indirection into its inner loop, but
 * every trip lookup would then have to ask "is this a template, and if so
 * which run of it am I looking at" — a branch in the hottest code in the
 * library, for a feature a minority of feeds use.
 *
 * Expanding instead, once at build time, keeps the query path exact and
 * uniform. The cost is memory proportional to the number of generated runs,
 * which the loader already caps per frequency row.
 *
 * The expansion is faithful for `exact_times = 1`, where the generated times
 * are the published ones. For `exact_times = 0` only the headway is promised,
 * so a rider does not actually get the modelled departure; the engine records
 * the expected wait separately so a result can say so.
 */

import { NetworkBuildError } from "../errors.js";
import { MAX_TIME_OF_DAY, timeOfDay } from "../time/time-of-day.js";
import {
  ExactTimes,
  generateDepartures,
  type Frequency,
} from "../feed/frequencies.js";
import type { GtfsFeed, TripWithCalls } from "../feed/feed.js";
import type { StopTime } from "../feed/stop-times.js";

/** Separator between a template trip id and its run ordinal. */
export const RUN_SEPARATOR = "#";

/** A generated run's provenance. */
export interface ExpandedRun {
  /** The synthetic trip id, `<templateId>#<ordinal>`. */
  readonly tripId: string;
  /** The `frequencies.txt` template this run came from. */
  readonly templateTripId: string;
  /** Zero-based ordinal within the template's departures. */
  readonly ordinal: number;
  /** Seconds a rider is expected to wait; zero when times are exact. */
  readonly expectedWaitSeconds: number;
}

/** The outcome of an expansion. */
export interface ExpansionResult {
  /** The feed with template trips replaced by their generated runs. */
  readonly feed: GtfsFeed;
  /** Provenance for each generated run, keyed by synthetic trip id. */
  readonly runs: ReadonlyMap<string, ExpandedRun>;
}

/**
 * True when a synthetic trip id was produced by expansion.
 *
 * Relies on the separator, which no GTFS id may contain a delimiter around;
 * `tripIdOfRun` recovers the template.
 */
export function isGeneratedRun(tripId: string): boolean {
  return tripId.includes(RUN_SEPARATOR);
}

/** The template trip id behind a generated run id. */
export function templateTripIdOf(tripId: string): string {
  const index = tripId.lastIndexOf(RUN_SEPARATOR);
  return index === -1 ? tripId : tripId.slice(0, index);
}

/**
 * Replaces every frequency-based trip with its generated runs.
 *
 * Trips with no frequency row are passed through untouched. The returned feed
 * shares every other collection with the input; only `trips` and `tripById`
 * are rebuilt.
 *
 * @throws {NetworkBuildError} if a generated run would exceed the
 * representable time of day, which means the feed's headway and window
 * disagree with its template's own duration.
 */
export function expandFrequencies(feed: GtfsFeed): ExpansionResult {
  if (feed.frequencies.length === 0) {
    return { feed, runs: new Map() };
  }

  const byTrip = new Map<string, Frequency[]>();
  for (const frequency of feed.frequencies) {
    const existing = byTrip.get(frequency.tripId);
    if (existing === undefined) {
      byTrip.set(frequency.tripId, [frequency]);
    } else {
      existing.push(frequency);
    }
  }
  for (const windows of byTrip.values()) {
    windows.sort((a, b) => a.startTime - b.startTime || a.line - b.line);
  }

  const expanded: TripWithCalls[] = [];
  const runs = new Map<string, ExpandedRun>();

  for (const trip of feed.trips) {
    const windows = byTrip.get(trip.tripId);
    if (windows === undefined) {
      expanded.push(trip);
      continue;
    }

    const anchor = (trip.calls[0] as StopTime).departureTime;
    let ordinal = 0;

    for (const window of windows) {
      const expectedWait =
        window.exactTimes === ExactTimes.Exact ? 0 : Math.ceil(window.headwaySecs / 2);

      for (const departure of generateDepartures(window)) {
        const shift = departure - anchor;
        const tripId = `${trip.tripId}${RUN_SEPARATOR}${ordinal}`;
        expanded.push({ ...trip, tripId, calls: shiftCalls(trip, shift, tripId) });
        runs.set(tripId, {
          tripId,
          templateTripId: trip.tripId,
          ordinal,
          expectedWaitSeconds: expectedWait,
        });
        ordinal += 1;
      }
    }
  }

  expanded.sort((a, b) => a.tripId.localeCompare(b.tripId));

  return {
    feed: {
      ...feed,
      trips: expanded,
      tripById: new Map(expanded.map((trip) => [trip.tripId, trip])),
    },
    runs,
  };
}

/** Re-times a template's calls onto a generated run. */
function shiftCalls(trip: TripWithCalls, shift: number, tripId: string): StopTime[] {
  return trip.calls.map((call) => {
    const arrival = call.arrivalTime + shift;
    const departure = call.departureTime + shift;
    if (arrival < 0 || departure > MAX_TIME_OF_DAY) {
      throw new NetworkBuildError(
        `generated run "${tripId}" falls outside the representable time range`,
        { tripId, arrival, departure },
      );
    }
    return {
      ...call,
      tripId,
      arrivalTime: timeOfDay(arrival),
      departureTime: timeOfDay(departure),
    };
  });
}
