/**
 * `trips.txt` — one vehicle journey along a route, on the days a service
 * calendar makes active.
 *
 * The trip is the unit routing actually boards: a route says "the 47", a
 * service says "weekdays", and a trip says "the 08:14 departure that stops
 * here, then here, then here".
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, warnIfEmpty, type LoadedTable } from "./table.js";

/** The `direction_id` enumeration. Its meaning is agency-defined. */
export enum DirectionId {
  Outbound = 0,
  Inbound = 1,
}

/** The `wheelchair_accessible` enumeration. */
export enum WheelchairAccessibility {
  Unknown = 0,
  Accessible = 1,
  NotAccessible = 2,
}

/** The `bikes_allowed` enumeration. */
export enum BikesAllowed {
  Unknown = 0,
  Allowed = 1,
  NotAllowed = 2,
}

/** One row of `trips.txt`. */
export interface Trip {
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly tripHeadsign: string | undefined;
  readonly tripShortName: string | undefined;
  readonly directionId: DirectionId | undefined;
  /**
   * Groups trips a vehicle runs back to back. Two trips sharing a block id
   * may be ridden through without alighting, which the in-seat transfer rules
   * in `src/routing/footpath.ts` rely on.
   */
  readonly blockId: string | undefined;
  readonly shapeId: string | undefined;
  readonly wheelchairAccessible: WheelchairAccessibility;
  readonly bikesAllowed: BikesAllowed;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const TRIP_REQUIRED_COLUMNS: readonly string[] = ["route_id", "service_id", "trip_id"];

/** Rule identifiers emitted by this module. */
export const TRIP_RULES = {
  blockWithoutDirection: "trip.block_without_direction",
} as const;

const DIRECTION_VALUES = [0, 1];
const ACCESSIBILITY_VALUES = [0, 1, 2];

/**
 * Reads every trip from a loaded table.
 *
 * Rows missing any of the three required ids are dropped: a trip without a
 * route cannot be labelled, and one without a service can never be active, so
 * neither is recoverable.
 */
export function readTrips(table: LoadedTable, sink: DiagnosticSink): Trip[] {
  requireColumns(table, TRIP_REQUIRED_COLUMNS, sink);
  warnIfEmpty(table, sink);

  const trips: Trip[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const tripId = reader.requiredId("trip_id");
    const routeId = reader.requiredId("route_id");
    const serviceId = reader.requiredId("service_id");
    if (tripId === undefined || routeId === undefined || serviceId === undefined) {
      continue;
    }

    const directionRaw = reader.enumeration("direction_id", DIRECTION_VALUES);
    const blockId = reader.optionalId("block_id");
    if (blockId !== undefined && directionRaw === undefined) {
      sink.info(
        TRIP_RULES.blockWithoutDirection,
        `trip "${tripId}" declares a block_id but no direction_id, so through-running cannot be checked for a turnaround`,
        row.positionOf("direction_id"),
      );
    }

    trips.push({
      tripId,
      routeId,
      serviceId,
      tripHeadsign: reader.optionalText("trip_headsign"),
      tripShortName: reader.optionalText("trip_short_name"),
      directionId: directionRaw === undefined ? undefined : (directionRaw as DirectionId),
      blockId,
      shapeId: reader.optionalId("shape_id"),
      wheelchairAccessible: reader.enumerationOr(
        "wheelchair_accessible",
        ACCESSIBILITY_VALUES,
        WheelchairAccessibility.Unknown,
      ) as WheelchairAccessibility,
      bikesAllowed: reader.enumerationOr(
        "bikes_allowed",
        ACCESSIBILITY_VALUES,
        BikesAllowed.Unknown,
      ) as BikesAllowed,
      line: row.line,
    });
  }
  return trips;
}

/**
 * A trip's display label: its headsign when it has one, otherwise its short
 * name, otherwise its id.
 */
export function tripLabel(trip: Trip): string {
  return trip.tripHeadsign ?? trip.tripShortName ?? trip.tripId;
}

/**
 * Groups trips by block, dropping trips with no block id.
 *
 * Trips inside a group are left in input order; the timetable builder sorts
 * them by departure once their stop times are known.
 */
export function tripsByBlock(trips: readonly Trip[]): Map<string, Trip[]> {
  const blocks = new Map<string, Trip[]>();
  for (const trip of trips) {
    if (trip.blockId === undefined) {
      continue;
    }
    const existing = blocks.get(trip.blockId);
    if (existing === undefined) {
      blocks.set(trip.blockId, [trip]);
    } else {
      existing.push(trip);
    }
  }
  return blocks;
}
