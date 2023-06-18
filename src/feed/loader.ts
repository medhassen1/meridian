/**
 * Loading a feed: reading every table, resolving trips against their calls,
 * and reporting what could not be used.
 *
 * The loader never throws for bad feed data. A feed is an artefact produced by
 * someone else's software, and the useful response to a broken one is a full
 * account of what is wrong, not the first exception. It returns `undefined`
 * for the feed only when a required table is missing outright, at which point
 * there is nothing to report about.
 */

import { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { readAgencies } from "./agency.js";
import {
  readCalendarExceptions,
  readCalendars,
  reportRedundantExceptions,
  type CalendarEntry,
  type CalendarException,
} from "./calendar.js";
import { readFareAttributes, readFareRules, type FareAttribute, type FareRule } from "./fares.js";
import { readFeedInfo, type FeedInfo } from "./feed-info.js";
import { readFrequencies, type Frequency } from "./frequencies.js";
import { readLevels, readPathways, type Level, type Pathway } from "./pathways.js";
import { readRoutes } from "./routes.js";
import { buildShapes, readShapePoints, type Shape } from "./shapes.js";
import {
  groupStopTimes,
  interpolateStopTimes,
  readStopTimes,
  type RawStopTime,
} from "./stop-times.js";
import { readStops } from "./stops.js";
import { readTransfers, type Transfer } from "./transfers.js";
import { readTrips, type Trip } from "./trips.js";
import type { GtfsFeed, TripWithCalls } from "./feed.js";
import {
  hasAnyCalendarTable,
  missingRequiredTables,
  TABLES,
  type FeedSource,
} from "./source.js";
import { indexByKey, readTable, type TableReadOptions } from "./table.js";

/** Options controlling a load. */
export interface LoadOptions extends TableReadOptions {
  /** Maximum diagnostics retained. Defaults to the sink's own limit. */
  readonly diagnosticLimit?: number;
  /**
   * When true, trips whose calls could not be resolved are dropped and loading
   * continues. When false the feed is rejected. Defaults to true.
   */
  readonly tolerateBrokenTrips?: boolean;
}

/** The outcome of a load. */
export interface LoadResult {
  /** The feed, or `undefined` when it could not be assembled at all. */
  readonly feed: GtfsFeed | undefined;
  /** Everything noticed while reading. */
  readonly diagnostics: DiagnosticSink;
}

/** Rule identifiers emitted by this module. */
export const LOADER_RULES = {
  missingTable: "loader.missing_table",
  noCalendar: "loader.no_calendar",
  tripWithoutCalls: "loader.trip_without_calls",
  callsWithoutTrip: "loader.calls_without_trip",
  brokenTrips: "loader.broken_trips",
} as const;

/**
 * Reads every table a source can supply and assembles a feed.
 *
 * Optional tables that are absent yield empty collections rather than
 * diagnostics: a feed with no `shapes.txt` is complete, just less detailed.
 */
export function loadFeed(source: FeedSource, options: LoadOptions = {}): LoadResult {
  const sink = new DiagnosticSink(options.diagnosticLimit);
  const readOptions: TableReadOptions = {
    ...(options.raggedRows === undefined ? {} : { raggedRows: options.raggedRows }),
    ...(options.trimCells === undefined ? {} : { trimCells: options.trimCells }),
  };

  const missing = missingRequiredTables(source);
  if (missing.length > 0) {
    for (const table of missing) {
      sink.error(LOADER_RULES.missingTable, `required table ${table} is missing`, position(table, 1, 1));
    }
    return { feed: undefined, diagnostics: sink };
  }
  if (!hasAnyCalendarTable(source)) {
    sink.error(
      LOADER_RULES.noCalendar,
      "the feed supplies neither calendar.txt nor calendar_dates.txt, so no service is ever active",
      position(TABLES.calendar, 1, 1),
    );
  }

  const agencyTable = readTable(source, TABLES.agency, sink, readOptions);
  const stopTable = readTable(source, TABLES.stops, sink, readOptions);
  const routeTable = readTable(source, TABLES.routes, sink, readOptions);
  const tripTable = readTable(source, TABLES.trips, sink, readOptions);
  const stopTimeTable = readTable(source, TABLES.stopTimes, sink, readOptions);

  if (
    agencyTable === undefined ||
    stopTable === undefined ||
    routeTable === undefined ||
    tripTable === undefined ||
    stopTimeTable === undefined
  ) {
    // readTable has already recorded why each unreadable table failed.
    return { feed: undefined, diagnostics: sink };
  }

  const agencies = readAgencies(agencyTable, sink);
  const stops = readStops(stopTable, sink);
  const routes = readRoutes(routeTable, sink);
  const trips = readTrips(tripTable, sink);
  const rawStopTimes = readStopTimes(stopTimeTable, sink);

  const calendars = readOptionalTable(source, TABLES.calendar, sink, readOptions, readCalendars) ?? [];
  const calendarExceptions =
    readOptionalTable(source, TABLES.calendarDates, sink, readOptions, readCalendarExceptions) ?? [];
  reportRedundantExceptions(calendars, calendarExceptions, TABLES.calendarDates, sink);

  const frequencies =
    readOptionalTable(source, TABLES.frequencies, sink, readOptions, readFrequencies) ?? [];
  const transfers = readOptionalTable(source, TABLES.transfers, sink, readOptions, readTransfers) ?? [];
  const fareAttributes =
    readOptionalTable(source, TABLES.fareAttributes, sink, readOptions, readFareAttributes) ?? [];
  const fareRules = readOptionalTable(source, TABLES.fareRules, sink, readOptions, readFareRules) ?? [];
  const pathways = readOptionalTable(source, TABLES.pathways, sink, readOptions, readPathways) ?? [];
  const levels = readOptionalTable(source, TABLES.levels, sink, readOptions, readLevels) ?? [];
  const feedInfo = readOptionalTable(source, TABLES.feedInfo, sink, readOptions, readFeedInfo);

  const shapeTable = readTable(source, TABLES.shapes, sink, readOptions);
  const shapes: ReadonlyMap<string, Shape> =
    shapeTable === undefined
      ? new Map()
      : buildShapes(readShapePoints(shapeTable, sink), TABLES.shapes, sink);

  const resolved = resolveTrips(trips, rawStopTimes, sink, options.tolerateBrokenTrips ?? true);
  if (resolved === undefined) {
    return { feed: undefined, diagnostics: sink };
  }

  const stopById = indexByKey(stops, (stop) => stop.stopId, TABLES.stops, "stop", sink, (stop) => stop.line);
  const routeById = indexByKey(
    routes,
    (route) => route.routeId,
    TABLES.routes,
    "route",
    sink,
    (route) => route.line,
  );
  const tripById = new Map(resolved.map((trip) => [trip.tripId, trip]));

  const feed: GtfsFeed = {
    agencies,
    stops,
    routes,
    trips: resolved,
    calendars,
    calendarExceptions,
    frequencies,
    transfers,
    shapes,
    fareAttributes,
    fareRules,
    pathways,
    levels,
    feedInfo,
    stopById,
    routeById,
    tripById,
  };
  return { feed, diagnostics: sink };
}

/**
 * Pairs each trip with its resolved calls.
 *
 * Trips whose calls cannot be interpolated are dropped, and stop times naming
 * a trip that does not exist are reported. Resolved trips come back sorted by
 * id so that every downstream index is built in a stable order regardless of
 * how the feed happened to order its rows.
 */
function resolveTrips(
  trips: readonly Trip[],
  rawStopTimes: readonly RawStopTime[],
  sink: DiagnosticSink,
  tolerateBroken: boolean,
): TripWithCalls[] | undefined {
  const grouped = groupStopTimes(rawStopTimes, TABLES.stopTimes, sink);
  const knownTripIds = new Set(trips.map((trip) => trip.tripId));

  for (const [tripId, calls] of grouped) {
    if (!knownTripIds.has(tripId)) {
      sink.error(
        LOADER_RULES.callsWithoutTrip,
        `stop_times.txt references trip "${tripId}", which trips.txt does not define`,
        position(TABLES.stopTimes, (calls[0] as RawStopTime).line, 1),
      );
    }
  }

  const resolved: TripWithCalls[] = [];
  let broken = 0;

  for (const trip of trips) {
    const calls = grouped.get(trip.tripId);
    if (calls === undefined) {
      sink.error(
        LOADER_RULES.tripWithoutCalls,
        `trip "${trip.tripId}" has no rows in stop_times.txt`,
        position(TABLES.trips, trip.line, 1),
      );
      broken += 1;
      continue;
    }

    const interpolated = interpolateStopTimes(trip.tripId, calls, TABLES.stopTimes, sink);
    if (interpolated === undefined) {
      broken += 1;
      continue;
    }

    resolved.push({
      tripId: trip.tripId,
      routeId: trip.routeId,
      serviceId: trip.serviceId,
      tripHeadsign: trip.tripHeadsign,
      tripShortName: trip.tripShortName,
      directionId: trip.directionId,
      blockId: trip.blockId,
      shapeId: trip.shapeId,
      wheelchairAccessible: trip.wheelchairAccessible,
      bikesAllowed: trip.bikesAllowed,
      calls: interpolated,
      line: trip.line,
    });
  }

  if (broken > 0 && !tolerateBroken) {
    sink.error(
      LOADER_RULES.brokenTrips,
      `${broken} trip(s) could not be resolved and tolerateBrokenTrips is disabled`,
      position(TABLES.trips, 1, 1),
    );
    return undefined;
  }

  resolved.sort((a, b) => a.tripId.localeCompare(b.tripId));
  return resolved;
}

/**
 * Reads an optional table, returning `undefined` when the source does not
 * supply it.
 */
function readOptionalTable<T>(
  source: FeedSource,
  file: string,
  sink: DiagnosticSink,
  options: TableReadOptions,
  read: (table: NonNullable<ReturnType<typeof readTable>>, sink: DiagnosticSink) => T,
): T | undefined {
  const table = readTable(source, file, sink, options);
  return table === undefined ? undefined : read(table, sink);
}

/** Convenience wrapper that also reports the tables a source supplied. */
export function loadFeedFromTables(
  tables: Readonly<Record<string, string>>,
  options: LoadOptions = {},
): LoadResult {
  const source: FeedSource = {
    has: (table) => Object.prototype.hasOwnProperty.call(tables, table),
    read: (table) => tables[table],
    tableNames: () => Object.keys(tables).sort(),
  };
  return loadFeed(source, options);
}

/** Re-exported for callers building their own diagnostics pipeline. */
export type { CalendarEntry, CalendarException, FareAttribute, FareRule, FeedInfo, Frequency, Level, Pathway, Transfer };
