/**
 * The Rivertown fixture: a small feed that is nonetheless complete.
 *
 * One synthetic network exercised by most of the suite, rather than a bespoke
 * feed per test. It is deliberately built to contain each of the awkward cases
 * the engine has to handle:
 *
 * - a station with two platforms, so origin expansion and in-station transfers
 *   are exercised;
 * - a published transfer that overrides a generated footpath;
 * - a tram service running past midnight, anchored to the previous date;
 * - a service that runs only at weekends, plus a calendar exception that swaps
 *   the two on one date;
 * - a headway-based route, so frequency expansion is exercised;
 * - fare zones with a transfer allowance;
 * - a stop no trip calls at, and a route with no trips.
 *
 * Geometry is chosen so that only the three central stops are within walking
 * distance of one another; everything else must be reached by vehicle.
 */

import { ServiceDate } from "../../src/time/date.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { loadFeed } from "../../src/feed/loader.js";
import type { GtfsFeed } from "../../src/feed/feed.js";
import { buildNetwork, type BuildOptions } from "../../src/model/builder.js";
import type { Network } from "../../src/model/network.js";
import { table, tableOf } from "./csv.js";

/** A Monday inside the fixture's service period. */
export const MONDAY = ServiceDate.parse("20230605");

/** A Saturday inside the fixture's service period. */
export const SATURDAY = ServiceDate.parse("20230610");

/** The Monday on which the calendar exception swaps weekday for weekend. */
export const EXCEPTION_MONDAY = ServiceDate.parse("20230612");

/** A date after the fixture's calendar ends. */
export const AFTER_SERVICE = ServiceDate.parse("20231001");

/** The tables making up the Rivertown feed. */
export function rivertownTables(): Record<string, string> {
  return {
    "agency.txt": tableOf(
      ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"],
      [
        {
          agency_id: "RT",
          agency_name: "Rivertown Transit",
          agency_url: "https://rivertown.example/transit",
          agency_timezone: "Europe/London",
          agency_lang: "en",
        },
      ],
    ),

    "stops.txt": tableOf(
      [
        "stop_id",
        "stop_name",
        "stop_lat",
        "stop_lon",
        "location_type",
        "parent_station",
        "zone_id",
        "wheelchair_boarding",
      ],
      [
        { stop_id: "CENTRAL", stop_name: "Central", stop_lat: 51.5004, stop_lon: -0.1, location_type: 1 },
        {
          stop_id: "CENTRAL_A",
          stop_name: "Central Platform A",
          stop_lat: 51.5,
          stop_lon: -0.1,
          location_type: 0,
          parent_station: "CENTRAL",
          zone_id: "A",
          wheelchair_boarding: 1,
        },
        {
          stop_id: "CENTRAL_B",
          stop_name: "Central Platform B",
          stop_lat: 51.5008,
          stop_lon: -0.1,
          location_type: 0,
          parent_station: "CENTRAL",
          zone_id: "A",
          wheelchair_boarding: 1,
        },
        { stop_id: "MARKET", stop_name: "Market Square", stop_lat: 51.503, stop_lon: -0.1, zone_id: "A" },
        { stop_id: "NORTH", stop_name: "Northgate", stop_lat: 51.52, stop_lon: -0.1, zone_id: "A" },
        { stop_id: "SOUTH", stop_name: "Southbank", stop_lat: 51.48, stop_lon: -0.1, zone_id: "B" },
        { stop_id: "EAST", stop_name: "Eastfield", stop_lat: 51.5, stop_lon: -0.07, zone_id: "B" },
        { stop_id: "WEST", stop_name: "Westmoor", stop_lat: 51.5, stop_lon: -0.13, zone_id: "B" },
        { stop_id: "HARBOUR", stop_name: "Harbour", stop_lat: 51.5, stop_lon: -0.04, zone_id: "B" },
        { stop_id: "DEPOT", stop_name: "Depot", stop_lat: 51.51, stop_lon: -0.12, zone_id: "A" },
      ],
    ),

    "routes.txt": tableOf(
      ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color"],
      [
        { route_id: "R1", agency_id: "RT", route_short_name: "1", route_long_name: "Harbour Line", route_type: 3 },
        { route_id: "R2", agency_id: "RT", route_short_name: "2", route_long_name: "River Tram", route_type: 0 },
        { route_id: "R3", agency_id: "RT", route_short_name: "3", route_long_name: "Cross-City", route_type: 2 },
        { route_id: "R4", agency_id: "RT", route_short_name: "4", route_long_name: "Market Shuttle", route_type: 3 },
        { route_id: "R9", agency_id: "RT", route_short_name: "9", route_long_name: "Withdrawn", route_type: 3 },
      ],
    ),

    "trips.txt": tableOf(
      [
        "route_id",
        "service_id",
        "trip_id",
        "trip_headsign",
        "direction_id",
        "shape_id",
        "wheelchair_accessible",
        "bikes_allowed",
      ],
      [
        { route_id: "R1", service_id: "WEEKDAY", trip_id: "R1-1", trip_headsign: "Harbour", direction_id: 0, shape_id: "S1", wheelchair_accessible: 1, bikes_allowed: 1 },
        { route_id: "R1", service_id: "WEEKDAY", trip_id: "R1-2", trip_headsign: "Harbour", direction_id: 0, shape_id: "S1", wheelchair_accessible: 1 },
        { route_id: "R1", service_id: "WEEKDAY", trip_id: "R1-3", trip_headsign: "Harbour", direction_id: 0, shape_id: "S1" },
        { route_id: "R1", service_id: "WEEKEND", trip_id: "R1-W1", trip_headsign: "Harbour", direction_id: 0 },
        { route_id: "R2", service_id: "WEEKDAY", trip_id: "R2-1", trip_headsign: "Southbank", direction_id: 0 },
        { route_id: "R2", service_id: "WEEKDAY", trip_id: "R2-2", trip_headsign: "Southbank", direction_id: 0 },
        { route_id: "R2", service_id: "WEEKDAY", trip_id: "R2-N", trip_headsign: "Southbank (night)", direction_id: 0 },
        { route_id: "R3", service_id: "WEEKDAY", trip_id: "R3-1", trip_headsign: "Eastfield", direction_id: 0 },
        { route_id: "R3", service_id: "WEEKDAY", trip_id: "R3-2", trip_headsign: "Eastfield", direction_id: 0 },
        { route_id: "R4", service_id: "WEEKDAY", trip_id: "R4-T", trip_headsign: "Eastfield", direction_id: 0 },
      ],
    ),

    "stop_times.txt": table(
      [
        "trip_id",
        "arrival_time",
        "departure_time",
        "stop_id",
        "stop_sequence",
        "pickup_type",
        "drop_off_type",
      ],
      [
        ...calls("R1-1", [
          ["CENTRAL_A", "08:00:00"],
          ["MARKET", "08:05:00"],
          ["EAST", "08:20:00"],
          ["HARBOUR", "08:30:00"],
        ]),
        ...calls("R1-2", [
          ["CENTRAL_A", "08:30:00"],
          ["MARKET", "08:35:00"],
          ["EAST", "08:50:00"],
          ["HARBOUR", "09:00:00"],
        ]),
        ...calls("R1-3", [
          ["CENTRAL_A", "09:00:00"],
          ["MARKET", "09:05:00"],
          ["EAST", "09:20:00"],
          ["HARBOUR", "09:30:00"],
        ]),
        ...calls("R1-W1", [
          ["CENTRAL_A", "10:00:00"],
          ["MARKET", "10:06:00"],
          ["EAST", "10:25:00"],
          ["HARBOUR", "10:40:00"],
        ]),
        ...calls("R2-1", [
          ["NORTH", "07:50:00"],
          ["CENTRAL_B", "08:02:00"],
          ["SOUTH", "08:15:00"],
        ]),
        ...calls("R2-2", [
          ["NORTH", "08:20:00"],
          ["CENTRAL_B", "08:32:00"],
          ["SOUTH", "08:45:00"],
        ]),
        // Anchored to its own service date but calling past midnight, so a
        // search on the following morning has to look back a day to find it.
        ...calls("R2-N", [
          ["NORTH", "23:50:00"],
          ["CENTRAL_B", "24:02:00"],
          ["SOUTH", "24:15:00"],
        ]),
        ...calls("R3-1", [
          ["WEST", "08:10:00"],
          ["CENTRAL_A", "08:25:00"],
          ["EAST", "08:40:00"],
        ]),
        ...calls("R3-2", [
          ["WEST", "09:10:00"],
          ["CENTRAL_A", "09:25:00"],
          ["EAST", "09:40:00"],
        ]),
        ...calls("R4-T", [
          ["MARKET", "06:00:00"],
          ["EAST", "06:12:00"],
        ]),
      ],
    ),

    "calendar.txt": tableOf(
      [
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
      ],
      [
        {
          service_id: "WEEKDAY",
          monday: 1,
          tuesday: 1,
          wednesday: 1,
          thursday: 1,
          friday: 1,
          saturday: 0,
          sunday: 0,
          start_date: "20230601",
          end_date: "20230831",
        },
        {
          service_id: "WEEKEND",
          monday: 0,
          tuesday: 0,
          wednesday: 0,
          thursday: 0,
          friday: 0,
          saturday: 1,
          sunday: 1,
          start_date: "20230601",
          end_date: "20230831",
        },
      ],
    ),

    "calendar_dates.txt": tableOf(
      ["service_id", "date", "exception_type"],
      [
        { service_id: "WEEKDAY", date: "20230612", exception_type: 2 },
        { service_id: "WEEKEND", date: "20230612", exception_type: 1 },
      ],
    ),

    "frequencies.txt": tableOf(
      ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"],
      [{ trip_id: "R4-T", start_time: "06:00:00", end_time: "07:00:00", headway_secs: 900, exact_times: 1 }],
    ),

    "transfers.txt": tableOf(
      ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"],
      [
        { from_stop_id: "CENTRAL_B", to_stop_id: "CENTRAL_A", transfer_type: 2, min_transfer_time: 60 },
        { from_stop_id: "CENTRAL_A", to_stop_id: "CENTRAL_B", transfer_type: 2, min_transfer_time: 60 },
      ],
    ),

    "shapes.txt": tableOf(
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      [
        { shape_id: "S1", shape_pt_lat: 51.5, shape_pt_lon: -0.1, shape_pt_sequence: 1 },
        { shape_id: "S1", shape_pt_lat: 51.503, shape_pt_lon: -0.1, shape_pt_sequence: 2 },
        { shape_id: "S1", shape_pt_lat: 51.5, shape_pt_lon: -0.07, shape_pt_sequence: 3 },
        { shape_id: "S1", shape_pt_lat: 51.5, shape_pt_lon: -0.04, shape_pt_sequence: 4 },
      ],
    ),

    "fare_attributes.txt": tableOf(
      ["fare_id", "price", "currency_type", "payment_method", "transfers", "transfer_duration"],
      [
        { fare_id: "F_BASE", price: "2.50", currency_type: "GBP", payment_method: 1, transfers: 1, transfer_duration: 3600 },
        { fare_id: "F_LONG", price: "4.00", currency_type: "GBP", payment_method: 1, transfers: 0 },
      ],
    ),

    "fare_rules.txt": tableOf(
      ["fare_id", "route_id"],
      [
        { fare_id: "F_BASE", route_id: "R1" },
        { fare_id: "F_BASE", route_id: "R2" },
        { fare_id: "F_BASE", route_id: "R4" },
        { fare_id: "F_LONG", route_id: "R3" },
      ],
    ),

    "feed_info.txt": tableOf(
      ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
      [
        {
          feed_publisher_name: "Rivertown Transit",
          feed_publisher_url: "https://rivertown.example",
          feed_lang: "en",
          feed_start_date: "20230601",
          feed_end_date: "20230831",
          feed_version: "2023-06-01",
        },
      ],
    ),
  };
}

/** The Rivertown feed as an in-memory source. */
export function rivertownSource(overrides: Record<string, string | null> = {}): MemoryFeedSource {
  const tables = rivertownTables();
  for (const [name, contents] of Object.entries(overrides)) {
    if (contents === null) {
      delete tables[name];
    } else {
      tables[name] = contents;
    }
  }
  return new MemoryFeedSource(tables);
}

/**
 * The loaded Rivertown feed.
 *
 * @throws if the fixture stops loading cleanly, which would mean a change to
 * the loader silently broke every test that depends on it.
 */
export function rivertownFeed(overrides: Record<string, string | null> = {}): GtfsFeed {
  const result = loadFeed(rivertownSource(overrides));
  if (result.feed === undefined) {
    throw new Error(
      `the Rivertown fixture failed to load: ${result.diagnostics
        .sorted()
        .map((entry) => entry.message)
        .join("; ")}`,
    );
  }
  return result.feed;
}

/** The compiled Rivertown network. */
export function rivertownNetwork(options: BuildOptions = {}): Network {
  return buildNetwork(rivertownFeed(), options).network;
}

/** Builds `stop_times.txt` rows for one trip from a list of stop/time pairs. */
export function calls(
  tripId: string,
  stops: readonly (readonly [string, string])[],
): string[][] {
  return stops.map(([stopId, time], index) => [
    tripId,
    time,
    time,
    stopId,
    String(index + 1),
    "0",
    "0",
  ]);
}

/**
 * A minimal feed: two stops, one route, one trip, one service.
 *
 * Used where Rivertown's richness would obscure what a test is checking.
 */
export function minimalTables(): Record<string, string> {
  return {
    "agency.txt": tableOf(
      ["agency_name", "agency_url", "agency_timezone"],
      [{ agency_name: "Tiny", agency_url: "https://tiny.example", agency_timezone: "UTC" }],
    ),
    "stops.txt": tableOf(
      ["stop_id", "stop_name", "stop_lat", "stop_lon"],
      [
        { stop_id: "A", stop_name: "Alpha", stop_lat: 0, stop_lon: 0.01 },
        { stop_id: "B", stop_name: "Beta", stop_lat: 0, stop_lon: 0.1 },
      ],
    ),
    "routes.txt": tableOf(
      ["route_id", "route_short_name", "route_type"],
      [{ route_id: "L", route_short_name: "L", route_type: 3 }],
    ),
    "trips.txt": tableOf(
      ["route_id", "service_id", "trip_id"],
      [{ route_id: "L", service_id: "ALL", trip_id: "T1" }],
    ),
    "stop_times.txt": table(
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      [
        ["T1", "10:00:00", "10:00:00", "A", "1"],
        ["T1", "10:20:00", "10:20:00", "B", "2"],
      ],
    ),
    "calendar.txt": tableOf(
      [
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
      ],
      [
        {
          service_id: "ALL",
          monday: 1,
          tuesday: 1,
          wednesday: 1,
          thursday: 1,
          friday: 1,
          saturday: 1,
          sunday: 1,
          start_date: "20230101",
          end_date: "20231231",
        },
      ],
    ),
  };
}

/** The minimal feed as an in-memory source. */
export function minimalSource(overrides: Record<string, string | null> = {}): MemoryFeedSource {
  const tables = minimalTables();
  for (const [name, contents] of Object.entries(overrides)) {
    if (contents === null) {
      delete tables[name];
    } else {
      tables[name] = contents;
    }
  }
  return new MemoryFeedSource(tables);
}

/** The loaded minimal feed. */
export function minimalFeed(overrides: Record<string, string | null> = {}): GtfsFeed {
  const result = loadFeed(minimalSource(overrides));
  if (result.feed === undefined) {
    throw new Error("the minimal fixture failed to load");
  }
  return result.feed;
}

/** The compiled minimal network. */
export function minimalNetwork(options: BuildOptions = {}): Network {
  return buildNetwork(minimalFeed(), options).network;
}
