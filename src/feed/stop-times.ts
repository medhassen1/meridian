/**
 * `stop_times.txt` — where and when each trip calls.
 *
 * This is the largest table in any feed by an order of magnitude, and the one
 * whose invariants routing depends on most directly: times must not go
 * backwards along a trip, and every intermediate stop must end up with a
 * concrete time even though the specification lets a feed omit them.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import {
  formatTimeOfDay,
  timeOfDay,
  type TimeOfDay,
} from "../time/time-of-day.js";
import { requireColumns, warnIfEmpty, type LoadedTable } from "./table.js";

/** The `pickup_type` and `drop_off_type` enumeration. */
export enum BoardingRule {
  /** Regularly scheduled boarding or alighting. */
  Regular = 0,
  /** Not available at this stop. */
  None = 1,
  /** Must be arranged by phoning the agency. */
  PhoneAgency = 2,
  /** Must be coordinated with the driver. */
  CoordinateWithDriver = 3,
}

/** The `timepoint` enumeration. */
export enum Timepoint {
  /** Times are approximate. */
  Approximate = 0,
  /** Times are held to exactly. */
  Exact = 1,
}

/** One row of `stop_times.txt`, before interpolation. */
export interface RawStopTime {
  readonly tripId: string;
  readonly arrivalTime: TimeOfDay | undefined;
  readonly departureTime: TimeOfDay | undefined;
  readonly stopId: string;
  readonly stopSequence: number;
  readonly stopHeadsign: string | undefined;
  readonly pickupType: BoardingRule;
  readonly dropOffType: BoardingRule;
  readonly shapeDistTraveled: number | undefined;
  readonly timepoint: Timepoint;
  readonly line: number;
}

/** A stop time whose arrival and departure are both known. */
export interface StopTime extends RawStopTime {
  readonly arrivalTime: TimeOfDay;
  readonly departureTime: TimeOfDay;
  /** True when the time was filled in by interpolation rather than published. */
  readonly interpolated: boolean;
}

/** Columns without which the table cannot be read. */
export const STOP_TIME_REQUIRED_COLUMNS: readonly string[] = [
  "trip_id",
  "stop_id",
  "stop_sequence",
];

/** Rule identifiers emitted by this module. */
export const STOP_TIME_RULES = {
  duplicateSequence: "stop_time.duplicate_sequence",
  timeTravel: "stop_time.time_travel",
  departureBeforeArrival: "stop_time.departure_before_arrival",
  unanchored: "stop_time.unanchored",
  tooFewStops: "stop_time.too_few_stops",
  distanceNotIncreasing: "stop_time.distance_not_increasing",
} as const;

const BOARDING_VALUES = [0, 1, 2, 3];
const TIMEPOINT_VALUES = [0, 1];

/**
 * Reads every stop time from a loaded table, without ordering or interpolating
 * them.
 *
 * Rows are returned in file order. {@link groupStopTimes} turns them into
 * per-trip sequences.
 */
export function readStopTimes(table: LoadedTable, sink: DiagnosticSink): RawStopTime[] {
  requireColumns(table, STOP_TIME_REQUIRED_COLUMNS, sink);
  warnIfEmpty(table, sink);

  // An absent `timepoint` column means every published time is exact, which is
  // the specification's backward compatible reading.
  const declaresTimepoint = table.columns.includes("timepoint");

  const stopTimes: RawStopTime[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const tripId = reader.requiredId("trip_id");
    const stopId = reader.requiredId("stop_id");
    const stopSequence = reader.requiredInteger("stop_sequence", { min: 0 });
    if (tripId === undefined || stopId === undefined || stopSequence === undefined) {
      continue;
    }

    const arrivalTime = reader.time("arrival_time");
    const departureTime = reader.time("departure_time");
    if (arrivalTime !== undefined && departureTime !== undefined && departureTime < arrivalTime) {
      sink.error(
        STOP_TIME_RULES.departureBeforeArrival,
        `trip "${tripId}" departs stop "${stopId}" at ${formatTimeOfDay(
          departureTime,
        )} before arriving at ${formatTimeOfDay(arrivalTime)}`,
        row.positionOf("departure_time"),
      );
      continue;
    }

    stopTimes.push({
      tripId,
      arrivalTime,
      departureTime,
      stopId,
      stopSequence,
      stopHeadsign: reader.optionalText("stop_headsign"),
      pickupType: reader.enumerationOr(
        "pickup_type",
        BOARDING_VALUES,
        BoardingRule.Regular,
      ) as BoardingRule,
      dropOffType: reader.enumerationOr(
        "drop_off_type",
        BOARDING_VALUES,
        BoardingRule.Regular,
      ) as BoardingRule,
      shapeDistTraveled: reader.number("shape_dist_traveled", { min: 0 }),
      timepoint: declaresTimepoint
        ? (reader.enumerationOr("timepoint", TIMEPOINT_VALUES, Timepoint.Exact) as Timepoint)
        : Timepoint.Exact,
      line: row.line,
    });
  }
  return stopTimes;
}

/**
 * Groups raw stop times by trip and sorts each group by `stop_sequence`.
 *
 * Sequence numbers need only increase, not be contiguous, so the sort is by
 * value rather than by index. Duplicate sequence numbers within one trip make
 * the ordering ambiguous and are reported; the later row is dropped.
 */
export function groupStopTimes(
  stopTimes: readonly RawStopTime[],
  file: string,
  sink: DiagnosticSink,
): Map<string, RawStopTime[]> {
  const grouped = new Map<string, RawStopTime[]>();
  for (const stopTime of stopTimes) {
    const existing = grouped.get(stopTime.tripId);
    if (existing === undefined) {
      grouped.set(stopTime.tripId, [stopTime]);
    } else {
      existing.push(stopTime);
    }
  }

  for (const [tripId, group] of grouped) {
    group.sort((a, b) => a.stopSequence - b.stopSequence || a.line - b.line);
    const deduplicated: RawStopTime[] = [];
    for (const stopTime of group) {
      const previous = deduplicated[deduplicated.length - 1];
      if (previous !== undefined && previous.stopSequence === stopTime.stopSequence) {
        sink.error(
          STOP_TIME_RULES.duplicateSequence,
          `trip "${tripId}" repeats stop_sequence ${stopTime.stopSequence}`,
          position(file, stopTime.line, 1),
        );
        continue;
      }
      deduplicated.push(stopTime);
    }
    grouped.set(tripId, deduplicated);
  }
  return grouped;
}

/**
 * Fills in missing times and validates the ordering of one trip's calls.
 *
 * GTFS requires a published time only at the first and last stop and at any
 * stop flagged as a timepoint; intermediate times may be blank. The
 * specification's stated remedy is linear interpolation between the
 * surrounding known times, which is what this does — distributing the elapsed
 * time evenly across the intervening stops.
 *
 * Interpolating by `shape_dist_traveled` where available would be more
 * faithful to the road, but the measure is optional, frequently wrong, and
 * mixing two interpolation strategies inside one feed would make results
 * depend on which trips happen to carry it. Even distribution is uniform and
 * predictable.
 *
 * Returns `undefined` when the trip cannot be made usable: fewer than two
 * calls, or no published time to anchor the interpolation to.
 */
export function interpolateStopTimes(
  tripId: string,
  calls: readonly RawStopTime[],
  file: string,
  sink: DiagnosticSink,
): StopTime[] | undefined {
  if (calls.length < 2) {
    sink.error(
      STOP_TIME_RULES.tooFewStops,
      `trip "${tripId}" has ${calls.length} stop time(s); at least 2 are needed`,
      position(file, calls[0]?.line ?? 1, 1),
    );
    return undefined;
  }

  // Anchor points are calls with at least one published time. Every other call
  // sits between two of them.
  const anchors: number[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index] as RawStopTime;
    if (call.arrivalTime !== undefined || call.departureTime !== undefined) {
      anchors.push(index);
    }
  }

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined || first !== 0 || last !== calls.length - 1) {
    sink.error(
      STOP_TIME_RULES.unanchored,
      `trip "${tripId}" must publish a time at its first and last stop`,
      position(file, (calls[0] as RawStopTime).line, 1),
    );
    return undefined;
  }

  // Resolve each anchor's arrival and departure, defaulting one to the other.
  const arrivals = new Array<number | undefined>(calls.length).fill(undefined);
  const departures = new Array<number | undefined>(calls.length).fill(undefined);
  for (const index of anchors) {
    const call = calls[index] as RawStopTime;
    const arrival = call.arrivalTime ?? call.departureTime;
    const departure = call.departureTime ?? call.arrivalTime;
    arrivals[index] = arrival as number;
    departures[index] = departure as number;
  }

  // Distribute the elapsed time evenly across each unanchored run.
  for (let slot = 0; slot < anchors.length - 1; slot += 1) {
    const from = anchors[slot] as number;
    const to = anchors[slot + 1] as number;
    const gap = to - from;
    if (gap <= 1) {
      continue;
    }
    const startTime = departures[from] as number;
    const endTime = arrivals[to] as number;
    const span = endTime - startTime;
    for (let step = 1; step < gap; step += 1) {
      const at = from + step;
      const interpolated = startTime + Math.round((span * step) / gap);
      arrivals[at] = interpolated;
      departures[at] = interpolated;
    }
  }

  // Verify monotonicity across the whole trip before committing.
  const resolved: StopTime[] = [];
  let previousDeparture = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index] as RawStopTime;
    const arrival = arrivals[index] as number;
    const departure = departures[index] as number;

    if (arrival < previousDeparture) {
      sink.error(
        STOP_TIME_RULES.timeTravel,
        `trip "${tripId}" arrives at stop "${call.stopId}" at ${formatTimeOfDay(
          arrival as TimeOfDay,
        )}, before it left the previous stop`,
        position(file, call.line, 1),
      );
      return undefined;
    }
    previousDeparture = departure;

    resolved.push({
      ...call,
      arrivalTime: timeOfDay(arrival),
      departureTime: timeOfDay(departure),
      interpolated: call.arrivalTime === undefined && call.departureTime === undefined,
    });
  }

  checkDistanceMonotonicity(tripId, resolved, file, sink);
  return resolved;
}

/** True when passengers may board the vehicle at this call. */
export function allowsBoarding(stopTime: RawStopTime): boolean {
  return stopTime.pickupType !== BoardingRule.None;
}

/** True when passengers may leave the vehicle at this call. */
export function allowsAlighting(stopTime: RawStopTime): boolean {
  return stopTime.dropOffType !== BoardingRule.None;
}

/** Seconds the vehicle is held at a stop. */
export function dwellSeconds(stopTime: StopTime): number {
  return stopTime.departureTime - stopTime.arrivalTime;
}

/**
 * Reports a `shape_dist_traveled` measure that fails to increase along the
 * trip.
 *
 * This is a warning, not an error: the measure is presentational, so a broken
 * one degrades a rendered shape without affecting any routing result.
 */
function checkDistanceMonotonicity(
  tripId: string,
  calls: readonly StopTime[],
  file: string,
  sink: DiagnosticSink,
): void {
  let previous: number | undefined;
  for (const call of calls) {
    if (call.shapeDistTraveled === undefined) {
      continue;
    }
    if (previous !== undefined && call.shapeDistTraveled < previous) {
      sink.warn(
        STOP_TIME_RULES.distanceNotIncreasing,
        `trip "${tripId}" has a shape_dist_traveled that decreases at stop "${call.stopId}"`,
        position(file, call.line, 1),
      );
      return;
    }
    previous = call.shapeDistTraveled;
  }
}
