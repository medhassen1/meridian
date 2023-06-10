/**
 * `frequencies.txt` — trips published as a headway rather than a timetable.
 *
 * A frequency row says "this trip pattern repeats every N seconds between
 * these two times". The single trip in `stop_times.txt` acts as a template
 * giving the relative offsets between stops; the actual departures are
 * generated from it.
 *
 * Two modes exist and they differ in a way that matters to a passenger.
 * With `exact_times = 1` the generated departures are real published times a
 * rider can turn up for. With `exact_times = 0` only the headway is promised,
 * so a rider arriving at random waits, on average, half a headway.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { formatTimeOfDay, timeOfDay, type TimeOfDay } from "../time/time-of-day.js";
import { interval, type TimeInterval } from "../time/interval.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** The `exact_times` enumeration. */
export enum ExactTimes {
  /** Only the headway is promised. */
  Headway = 0,
  /** The generated departures are exact published times. */
  Exact = 1,
}

/** One row of `frequencies.txt`. */
export interface Frequency {
  readonly tripId: string;
  readonly startTime: TimeOfDay;
  /** Exclusive: a departure exactly at `endTime` is not generated. */
  readonly endTime: TimeOfDay;
  readonly headwaySecs: number;
  readonly exactTimes: ExactTimes;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const FREQUENCY_REQUIRED_COLUMNS: readonly string[] = [
  "trip_id",
  "start_time",
  "end_time",
  "headway_secs",
];

/** Rule identifiers emitted by this module. */
export const FREQUENCY_RULES = {
  windowInverted: "frequency.window_inverted",
  headwayTooLong: "frequency.headway_too_long",
  overlappingWindows: "frequency.overlapping_windows",
} as const;

/**
 * Largest number of departures one frequency row may generate.
 *
 * A row with a one second headway across a whole day would otherwise expand to
 * 86,400 departures for a single trip, exhausting memory during network
 * construction. The cap turns that into a diagnostic.
 */
export const MAX_GENERATED_DEPARTURES = 2_000;

const EXACT_TIMES_VALUES = [0, 1];

/**
 * Reads every frequency row.
 *
 * A row whose window is inverted, or whose headway does not divide the window
 * into a usable number of departures, is dropped with an error.
 */
export function readFrequencies(table: LoadedTable, sink: DiagnosticSink): Frequency[] {
  requireColumns(table, FREQUENCY_REQUIRED_COLUMNS, sink);

  const frequencies: Frequency[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const tripId = reader.requiredId("trip_id");
    const startTime = reader.time("start_time");
    const endTime = reader.time("end_time");
    const headwaySecs = reader.requiredInteger("headway_secs", { min: 1 });
    if (
      tripId === undefined ||
      startTime === undefined ||
      endTime === undefined ||
      headwaySecs === undefined
    ) {
      continue;
    }

    if (endTime < startTime) {
      sink.error(
        FREQUENCY_RULES.windowInverted,
        `frequency for trip "${tripId}" ends at ${formatTimeOfDay(
          endTime,
        )} before it starts at ${formatTimeOfDay(startTime)}`,
        row.positionOf("end_time"),
      );
      continue;
    }

    const departures = Math.ceil((endTime - startTime) / headwaySecs);
    if (departures > MAX_GENERATED_DEPARTURES) {
      sink.error(
        FREQUENCY_RULES.headwayTooLong,
        `frequency for trip "${tripId}" would generate ${departures} departures, above the limit of ${MAX_GENERATED_DEPARTURES}`,
        row.positionOf("headway_secs"),
      );
      continue;
    }

    frequencies.push({
      tripId,
      startTime,
      endTime,
      headwaySecs,
      exactTimes: reader.enumerationOr(
        "exact_times",
        EXACT_TIMES_VALUES,
        ExactTimes.Headway,
      ) as ExactTimes,
      line: row.line,
    });
  }

  reportOverlaps(table.file, frequencies, sink);
  return frequencies;
}

/** The half-open window a frequency row covers. */
export function frequencyWindow(frequency: Frequency): TimeInterval {
  return interval(frequency.startTime, frequency.endTime);
}

/**
 * The departure times a frequency row generates, in ascending order.
 *
 * Departures start at `start_time` and step by the headway while strictly
 * below `end_time`. A window shorter than one headway still yields the single
 * departure at its start, which is how agencies express a last service of the
 * evening.
 */
export function generateDepartures(frequency: Frequency): TimeOfDay[] {
  const departures: TimeOfDay[] = [];
  if (frequency.startTime === frequency.endTime) {
    return [frequency.startTime];
  }
  for (let at: number = frequency.startTime; at < frequency.endTime; at += frequency.headwaySecs) {
    departures.push(timeOfDay(at));
  }
  return departures;
}

/**
 * Average seconds a passenger arriving at a uniformly random moment waits.
 *
 * Half the headway for headway-based service; zero for exact times, where the
 * passenger consults the timetable and the routing engine models the real
 * departures instead.
 */
export function expectedWaitSeconds(frequency: Frequency): number {
  return frequency.exactTimes === ExactTimes.Exact ? 0 : Math.ceil(frequency.headwaySecs / 2);
}

/**
 * Reports frequency windows that overlap for the same trip.
 *
 * Overlapping windows make the headway at a given moment ambiguous. meridian
 * still generates departures from both, which is the tolerant reading, but the
 * feed should be fixed.
 */
function reportOverlaps(
  file: string,
  frequencies: readonly Frequency[],
  sink: DiagnosticSink,
): void {
  const byTrip = new Map<string, Frequency[]>();
  for (const frequency of frequencies) {
    const existing = byTrip.get(frequency.tripId);
    if (existing === undefined) {
      byTrip.set(frequency.tripId, [frequency]);
    } else {
      existing.push(frequency);
    }
  }

  for (const [tripId, group] of byTrip) {
    const sorted = group.slice().sort((a, b) => a.startTime - b.startTime || a.line - b.line);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1] as Frequency;
      const current = sorted[index] as Frequency;
      if (current.startTime < previous.endTime) {
        sink.warn(
          FREQUENCY_RULES.overlappingWindows,
          `trip "${tripId}" has overlapping frequency windows ${formatTimeOfDay(
            previous.startTime,
          )}-${formatTimeOfDay(previous.endTime)} and ${formatTimeOfDay(
            current.startTime,
          )}-${formatTimeOfDay(current.endTime)}`,
          position(file, current.line, 1),
        );
      }
    }
  }
}
