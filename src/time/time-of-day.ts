/**
 * GTFS times of day.
 *
 * A GTFS `stop_times.txt` time is measured from "noon minus twelve hours" of
 * the trip's service date, which is midnight on every day that has no daylight
 * saving transition. Crucially the value is allowed to exceed 24 hours: a trip
 * departing at 23:50 and arriving at 00:40 the next calendar day is written as
 * `23:50:00` and `24:40:00`, both anchored to the *same* service date.
 *
 * Representing those times as seconds since service-day start — rather than as
 * wall clock times that wrap — is what lets the routing engine compare arrival
 * times across midnight with plain integer arithmetic.
 */

import { TimeRangeError } from "../errors.js";
import { SECONDS_PER_DAY } from "./date.js";

declare const timeOfDayBrand: unique symbol;

/**
 * Seconds elapsed since the start of a service day. May be greater than or
 * equal to {@link SECONDS_PER_DAY} for trips running past midnight.
 *
 * Branded so a raw second count cannot be passed where a validated time of day
 * is expected.
 */
export type TimeOfDay = number & { readonly [timeOfDayBrand]: true };

/**
 * Largest accepted time of day, seven days past the service-day start.
 *
 * No real schedule spans a week from its anchor; the bound exists to reject
 * corrupt input such as a mis-parsed epoch timestamp before it reaches the
 * timetable index, where it would silently widen every search.
 */
export const MAX_TIME_OF_DAY = 7 * SECONDS_PER_DAY;

/** The service-day start, `00:00:00`. */
export const START_OF_SERVICE_DAY = 0 as TimeOfDay;

const TIME_PATTERN = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;

/**
 * Parses the GTFS `H:MM:SS` or `HH:MM:SS` form.
 *
 * Hours may exceed 23. Minutes and seconds must be two digits in 00-59; a
 * value of 60 is rejected rather than normalised, because a feed writing
 * `10:59:60` more often indicates a broken exporter than a leap second.
 *
 * @throws {TimeRangeError} if the text is not a well formed time, or the
 * resulting value exceeds {@link MAX_TIME_OF_DAY}.
 */
export function parseTimeOfDay(text: string): TimeOfDay {
  const match = TIME_PATTERN.exec(text);
  if (!match) {
    throw new TimeRangeError(`"${text}" is not a HH:MM:SS time of day`, { text });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (total > MAX_TIME_OF_DAY) {
    throw new TimeRangeError(`time of day "${text}" exceeds the 7 day limit`, { text, seconds: total });
  }
  return total as TimeOfDay;
}

/**
 * Wraps a raw second count as a {@link TimeOfDay}.
 *
 * @throws {TimeRangeError} if the value is not a non-negative integer within
 * {@link MAX_TIME_OF_DAY}.
 */
export function timeOfDay(seconds: number): TimeOfDay {
  if (!Number.isInteger(seconds)) {
    throw new TimeRangeError("time of day must be an integer number of seconds", { seconds });
  }
  if (seconds < 0) {
    throw new TimeRangeError("time of day must not be negative", { seconds });
  }
  if (seconds > MAX_TIME_OF_DAY) {
    throw new TimeRangeError("time of day exceeds the 7 day limit", { seconds });
  }
  return seconds as TimeOfDay;
}

/**
 * Renders the GTFS `HH:MM:SS` form, keeping hours past 24 rather than wrapping
 * them. Hours are zero padded to at least two digits.
 */
export function formatTimeOfDay(value: TimeOfDay): string {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
}

/**
 * Renders a human facing clock time, wrapping past-midnight hours back into
 * 00-23 and appending the number of days rolled over.
 *
 * `25:30:00` renders as `01:30 (+1d)`, which is what an itinerary should show
 * a passenger.
 */
export function formatClockTime(value: TimeOfDay): string {
  const dayOffset = Math.floor(value / SECONDS_PER_DAY);
  const withinDay = value % SECONDS_PER_DAY;
  const hours = Math.floor(withinDay / 3600);
  const minutes = Math.floor((withinDay % 3600) / 60);
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return dayOffset === 0 ? clock : `${clock} (+${dayOffset}d)`;
}

/** Number of whole service days a time of day rolls past its anchor date. */
export function dayOffsetOf(value: TimeOfDay): number {
  return Math.floor(value / SECONDS_PER_DAY);
}

/** The time of day reduced into 00:00:00-23:59:59. */
export function withinDay(value: TimeOfDay): TimeOfDay {
  return (value % SECONDS_PER_DAY) as TimeOfDay;
}

/**
 * Shifts a time of day by a signed number of seconds.
 *
 * @throws {TimeRangeError} if the result would leave the representable range.
 */
export function shiftTimeOfDay(value: TimeOfDay, seconds: number): TimeOfDay {
  if (!Number.isInteger(seconds)) {
    throw new TimeRangeError("shift must be an integer number of seconds", { seconds });
  }
  return timeOfDay(value + seconds);
}

/**
 * Re-anchors a time of day from one service date to another.
 *
 * A trip departing at `24:10:00` on Monday is the same instant as `00:10:00`
 * on Tuesday. When the routing engine scans a later service day it needs the
 * earlier day's times expressed on the later day's anchor, which shifts them
 * by whole days. The result may be negative in principle, so callers pass the
 * shift as a day count and receive `undefined` when re-anchoring would move
 * the time before its new anchor.
 */
export function reanchorTimeOfDay(value: TimeOfDay, dayShift: number): TimeOfDay | undefined {
  const shifted = value + dayShift * SECONDS_PER_DAY;
  if (shifted < 0 || shifted > MAX_TIME_OF_DAY) {
    return undefined;
  }
  return shifted as TimeOfDay;
}

/** Total ordering on times of day. */
export function compareTimeOfDay(a: TimeOfDay, b: TimeOfDay): number {
  return a - b;
}

/** The earlier of two times of day; ties return `a`. */
export function minTimeOfDay(a: TimeOfDay, b: TimeOfDay): TimeOfDay {
  return b < a ? b : a;
}

/** The later of two times of day; ties return `a`. */
export function maxTimeOfDay(a: TimeOfDay, b: TimeOfDay): TimeOfDay {
  return b > a ? b : a;
}
