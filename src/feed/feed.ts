/**
 * The in-memory shape of a parsed GTFS feed.
 *
 * A {@link GtfsFeed} is the faithful reading of the tables: entities as
 * published, with times interpolated and obvious contradictions already
 * removed, but nothing derived. Deriving the structures routing needs —
 * patterns, timetables, transfer graphs — is the job of `src/model`, and
 * keeping the two apart means a validator can inspect exactly what the agency
 * wrote.
 */

import type { Agency } from "./agency.js";
import type { CalendarEntry, CalendarException } from "./calendar.js";
import type { FareAttribute, FareRule } from "./fares.js";
import type { FeedInfo } from "./feed-info.js";
import type { Frequency } from "./frequencies.js";
import type { Level, Pathway } from "./pathways.js";
import type { Route } from "./routes.js";
import type { Shape } from "./shapes.js";
import type { Stop } from "./stops.js";
import type { StopTime } from "./stop-times.js";
import type { Transfer } from "./transfers.js";
import { isBoardable } from "./stops.js";

/** A parsed GTFS feed. */
export interface GtfsFeed {
  readonly agencies: readonly Agency[];
  readonly stops: readonly Stop[];
  readonly routes: readonly Route[];
  readonly trips: readonly TripWithCalls[];
  readonly calendars: readonly CalendarEntry[];
  readonly calendarExceptions: readonly CalendarException[];
  readonly frequencies: readonly Frequency[];
  readonly transfers: readonly Transfer[];
  readonly shapes: ReadonlyMap<string, Shape>;
  readonly fareAttributes: readonly FareAttribute[];
  readonly fareRules: readonly FareRule[];
  readonly pathways: readonly Pathway[];
  readonly levels: readonly Level[];
  readonly feedInfo: FeedInfo | undefined;

  /** Stops by id. */
  readonly stopById: ReadonlyMap<string, Stop>;
  /** Routes by id. */
  readonly routeById: ReadonlyMap<string, Route>;
  /** Trips by id, with their resolved calls. */
  readonly tripById: ReadonlyMap<string, TripWithCalls>;
}

/**
 * A trip together with the stop times that make it up.
 *
 * Pairing them removes an entire class of bug: nothing downstream can hold a
 * trip whose calls were dropped during interpolation, because such trips never
 * make it into the feed.
 */
export interface TripWithCalls {
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly tripHeadsign: string | undefined;
  readonly tripShortName: string | undefined;
  readonly directionId: number | undefined;
  readonly blockId: string | undefined;
  readonly shapeId: string | undefined;
  readonly wheelchairAccessible: number;
  readonly bikesAllowed: number;
  /** At least two calls, ordered by `stop_sequence`, with resolved times. */
  readonly calls: readonly StopTime[];
  readonly line: number;
}

/** Summary counts, used by reports and by the CLI's `describe` command. */
export interface FeedSummary {
  readonly agencies: number;
  readonly stops: number;
  readonly boardableStops: number;
  readonly routes: number;
  readonly trips: number;
  readonly calls: number;
  readonly services: number;
  readonly shapes: number;
  readonly transfers: number;
  readonly fares: number;
}

/** Counts the feed's contents. */
export function summariseFeed(feed: GtfsFeed): FeedSummary {
  let calls = 0;
  for (const trip of feed.trips) {
    calls += trip.calls.length;
  }
  const services = new Set<string>();
  for (const entry of feed.calendars) {
    services.add(entry.serviceId);
  }
  for (const exception of feed.calendarExceptions) {
    services.add(exception.serviceId);
  }

  return {
    agencies: feed.agencies.length,
    stops: feed.stops.length,
    boardableStops: feed.stops.filter(isBoardable).length,
    routes: feed.routes.length,
    trips: feed.trips.length,
    calls,
    services: services.size,
    shapes: feed.shapes.size,
    transfers: feed.transfers.length,
    fares: feed.fareAttributes.length,
  };
}

/**
 * Trips using a given service, in feed order.
 *
 * Feed order is trip-id order after loading, which makes the result stable
 * without an extra sort.
 */
export function tripsForService(feed: GtfsFeed, serviceId: string): TripWithCalls[] {
  return feed.trips.filter((trip) => trip.serviceId === serviceId);
}

/** Trips belonging to a route, in feed order. */
export function tripsForRoute(feed: GtfsFeed, routeId: string): TripWithCalls[] {
  return feed.trips.filter((trip) => trip.routeId === routeId);
}

/**
 * Stop ids that at least one trip calls at, sorted.
 *
 * A feed routinely contains stops no trip serves — decommissioned platforms,
 * or entries kept for a future timetable. They are not errors, but they should
 * not appear in a network.
 */
export function servedStopIds(feed: GtfsFeed): string[] {
  const served = new Set<string>();
  for (const trip of feed.trips) {
    for (const call of trip.calls) {
      served.add(call.stopId);
    }
  }
  return Array.from(served).sort();
}

/** Stops that no trip calls at, in feed order. */
export function unservedStops(feed: GtfsFeed): Stop[] {
  const served = new Set(servedStopIds(feed));
  return feed.stops.filter((stop) => isBoardable(stop) && !served.has(stop.stopId));
}

/** Service ids referenced by at least one trip, sorted. */
export function referencedServiceIds(feed: GtfsFeed): string[] {
  const referenced = new Set<string>();
  for (const trip of feed.trips) {
    referenced.add(trip.serviceId);
  }
  return Array.from(referenced).sort();
}
