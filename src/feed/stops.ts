/**
 * `stops.txt` — the places a vehicle can be boarded, and the structures
 * containing them.
 *
 * A GTFS stop record is overloaded: the same table holds boardable stops,
 * the stations that group them, station entrances, generic pathway nodes, and
 * boarding areas. Only the first two matter to routing, but the rest must be
 * read correctly so that parent-child relationships resolve.
 */

import { coordinate, type Coordinate } from "../geo/coordinate.js";
import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, warnIfEmpty, type LoadedTable } from "./table.js";

/** The `location_type` enumeration. */
export enum LocationType {
  /** A boardable stop or platform. */
  Stop = 0,
  /** A station grouping one or more stops. */
  Station = 1,
  /** A way in or out of a station. */
  EntranceExit = 2,
  /** A node used only to connect pathways. */
  GenericNode = 3,
  /** A boarding area on a platform. */
  BoardingArea = 4,
}

/** The `wheelchair_boarding` enumeration. */
export enum WheelchairBoarding {
  /** No information, or inherited from the parent station. */
  Unknown = 0,
  /** Some vehicles can be boarded by a rider in a wheelchair. */
  Possible = 1,
  /** No accessible boarding. */
  NotPossible = 2,
}

/** One row of `stops.txt`. */
export interface Stop {
  readonly stopId: string;
  readonly stopCode: string | undefined;
  readonly stopName: string | undefined;
  readonly stopDesc: string | undefined;
  /**
   * The stop's position, absent only for location types that do not require
   * one. Routing skips stops without a position when generating footpaths.
   */
  readonly coordinate: Coordinate | undefined;
  readonly zoneId: string | undefined;
  readonly stopUrl: string | undefined;
  readonly locationType: LocationType;
  readonly parentStation: string | undefined;
  readonly stopTimezone: string | undefined;
  readonly wheelchairBoarding: WheelchairBoarding;
  readonly platformCode: string | undefined;
  readonly levelId: string | undefined;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const STOP_REQUIRED_COLUMNS: readonly string[] = ["stop_id"];

/** Location types that must carry a name and a position. */
export const LOCATED_TYPES: readonly LocationType[] = [
  LocationType.Stop,
  LocationType.Station,
  LocationType.EntranceExit,
];

/** Rule identifiers emitted by this module. */
export const STOP_RULES = {
  positionRequired: "stop.position_required",
  nameRequired: "stop.name_required",
  parentForbidden: "stop.parent_forbidden",
  parentRequired: "stop.parent_required",
  nullIsland: "stop.null_island",
} as const;

const ALL_LOCATION_TYPES = [0, 1, 2, 3, 4];
const ALL_WHEELCHAIR_VALUES = [0, 1, 2];

/**
 * Reads every stop from a loaded table.
 *
 * A row without a usable `stop_id` is dropped; everything else is kept, with
 * missing names and positions reported so the validator can decide how severe
 * they are for the location type involved.
 */
export function readStops(table: LoadedTable, sink: DiagnosticSink): Stop[] {
  requireColumns(table, STOP_REQUIRED_COLUMNS, sink);
  warnIfEmpty(table, sink);

  const stops: Stop[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const stopId = reader.requiredId("stop_id");
    if (stopId === undefined) {
      continue;
    }

    const locationType = reader.enumerationOr(
      "location_type",
      ALL_LOCATION_TYPES,
      LocationType.Stop,
    ) as LocationType;

    const latitude = reader.latitude("stop_lat");
    const longitude = reader.longitude("stop_lon");
    const point =
      latitude === undefined || longitude === undefined
        ? undefined
        : coordinate(latitude, longitude);

    if (point === undefined && LOCATED_TYPES.includes(locationType)) {
      sink.error(
        STOP_RULES.positionRequired,
        `stop "${stopId}" of location_type ${locationType} needs stop_lat and stop_lon`,
        row.positionOf("stop_lat"),
      );
    }

    const stopName = reader.optionalText("stop_name");
    if (stopName === undefined && LOCATED_TYPES.includes(locationType)) {
      sink.error(
        STOP_RULES.nameRequired,
        `stop "${stopId}" of location_type ${locationType} needs a stop_name`,
        row.positionOf("stop_name"),
      );
    }

    const parentStation = reader.optionalId("parent_station");
    if (parentStation !== undefined && locationType === LocationType.Station) {
      sink.error(
        STOP_RULES.parentForbidden,
        `station "${stopId}" must not declare a parent_station`,
        row.positionOf("parent_station"),
      );
    }
    if (
      parentStation === undefined &&
      (locationType === LocationType.EntranceExit ||
        locationType === LocationType.GenericNode ||
        locationType === LocationType.BoardingArea)
    ) {
      sink.error(
        STOP_RULES.parentRequired,
        `stop "${stopId}" of location_type ${locationType} needs a parent_station`,
        row.positionOf("parent_station"),
      );
    }

    if (point !== undefined && point.latitude === 0 && point.longitude === 0) {
      sink.warn(
        STOP_RULES.nullIsland,
        `stop "${stopId}" sits at 0,0, which is almost always a missing coordinate`,
        row.positionOf("stop_lat"),
      );
    }

    stops.push({
      stopId,
      stopCode: reader.optionalText("stop_code"),
      stopName,
      stopDesc: reader.optionalText("stop_desc"),
      coordinate: point,
      zoneId: reader.optionalId("zone_id"),
      stopUrl: reader.url("stop_url"),
      locationType,
      parentStation,
      stopTimezone: reader.timezone("stop_timezone"),
      wheelchairBoarding: reader.enumerationOr(
        "wheelchair_boarding",
        ALL_WHEELCHAIR_VALUES,
        WheelchairBoarding.Unknown,
      ) as WheelchairBoarding,
      platformCode: reader.optionalText("platform_code"),
      levelId: reader.optionalId("level_id"),
      line: row.line,
    });
  }
  return stops;
}

/** True when the stop can be boarded, and so participates in routing. */
export function isBoardable(stop: Stop): boolean {
  return stop.locationType === LocationType.Stop;
}

/**
 * The identifier a stop should be grouped under for transfer purposes: its
 * parent station when it has one, otherwise itself.
 *
 * Two platforms of one station are usually a step apart, and treating them as
 * a single place avoids generating a footpath for every pair.
 */
export function groupingIdOf(stop: Stop): string {
  return stop.parentStation ?? stop.stopId;
}

/**
 * A stop's most useful display label: its name, falling back to its code and
 * then its id, so a report never shows a blank.
 */
export function stopLabel(stop: Stop): string {
  return stop.stopName ?? stop.stopCode ?? stop.stopId;
}
