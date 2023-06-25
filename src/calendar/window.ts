/**
 * Turning a query date and time into the service days that must be scanned.
 *
 * This is the piece of GTFS handling most often got wrong. A trip that departs
 * at 23:50 and arrives at 00:40 is anchored to the *previous* service date and
 * written with a time past 24:00:00. A search starting at 00:10 on Tuesday
 * that ignores Monday's service day will not find it, and will confidently
 * report that no service exists.
 *
 * The rule is mechanical: to search at time `T` on date `D`, also scan date
 * `D - k` at time `T + k × 86400`, for every `k` up to the longest past-midnight
 * overhang the feed actually contains.
 */

import { SECONDS_PER_DAY, ServiceDate } from "../time/date.js";
import { MAX_TIME_OF_DAY, type TimeOfDay } from "../time/time-of-day.js";
import { TimeRangeError } from "../errors.js";

/** One service day to scan, and the time offset that applies to it. */
export interface ServiceDayScan {
  /** The service date whose trips are being scanned. */
  readonly date: ServiceDate;
  /**
   * Seconds to add to a query time expressed on the *query* date to obtain the
   * equivalent time on this scan's anchor date.
   */
  readonly offsetSeconds: number;
  /** Whole days between this anchor and the query date; zero for the query date. */
  readonly dayShift: number;
}

/**
 * Largest past-midnight overhang meridian will consider by default.
 *
 * Two days covers every real schedule: an overnight coach anchored to Friday
 * that arrives on Sunday morning is already extraordinary. Feeds with longer
 * overhangs may raise it, at the cost of scanning more service days per query.
 */
export const DEFAULT_MAX_OVERHANG_DAYS = 2;

/**
 * The service days that could contain a trip running at the query time.
 *
 * Days are returned from the query date backwards, so a caller that stops
 * early sees the most likely candidates first.
 *
 * @throws {TimeRangeError} if `overhangDays` is negative or not an integer.
 */
export function scanServiceDays(
  date: ServiceDate,
  overhangDays: number = DEFAULT_MAX_OVERHANG_DAYS,
): ServiceDayScan[] {
  if (!Number.isInteger(overhangDays) || overhangDays < 0) {
    throw new TimeRangeError("overhang days must be a non-negative integer", { overhangDays });
  }
  const scans: ServiceDayScan[] = [];
  for (let dayShift = 0; dayShift <= overhangDays; dayShift += 1) {
    scans.push({
      date: date.addDays(-dayShift),
      offsetSeconds: dayShift * SECONDS_PER_DAY,
      dayShift,
    });
  }
  return scans;
}

/**
 * The service days that could contain a trip running anywhere in a search
 * window that itself may cross midnight.
 *
 * A window starting at 23:00 and lasting three hours ends at 02:00 the next
 * calendar day; both that day and the days before the start must be scanned.
 */
export function scanServiceDaysForWindow(
  date: ServiceDate,
  windowStart: TimeOfDay,
  windowSeconds: number,
  overhangDays: number = DEFAULT_MAX_OVERHANG_DAYS,
): ServiceDayScan[] {
  if (!Number.isInteger(windowSeconds) || windowSeconds < 0) {
    throw new TimeRangeError("window length must be a non-negative integer", { windowSeconds });
  }
  const forwardDays = Math.floor((windowStart + windowSeconds) / SECONDS_PER_DAY);
  const scans: ServiceDayScan[] = [];
  // Indexed from zero and offset, rather than counted from a negative bound, so
  // that a window inside one day yields a day shift of positive zero. A -0
  // leaks into every derived offset and compares unequal under `Object.is`.
  for (let index = 0; index <= forwardDays + overhangDays; index += 1) {
    const dayShift = index - forwardDays;
    scans.push({
      date: date.addDays(-dayShift),
      offsetSeconds: dayShift * SECONDS_PER_DAY,
      dayShift,
    });
  }
  return scans;
}

/**
 * Translates a query time onto a scan's anchor date, or `undefined` when the
 * result would leave the representable range.
 */
export function timeOnScan(scan: ServiceDayScan, time: TimeOfDay): TimeOfDay | undefined {
  const shifted = time + scan.offsetSeconds;
  if (shifted < 0 || shifted > MAX_TIME_OF_DAY) {
    return undefined;
  }
  return shifted as TimeOfDay;
}

/**
 * Translates a time expressed on a scan's anchor date back onto the query
 * date's clock.
 *
 * A trip found at 25:10 on yesterday's anchor is reported as 01:10 today; the
 * caller keeps the anchor date separately when it needs to say which vehicle
 * run it was.
 */
export function timeOnQueryDate(scan: ServiceDayScan, time: TimeOfDay): number {
  return time - scan.offsetSeconds;
}

/**
 * The longest past-midnight overhang present in a set of trips, in whole days.
 *
 * Sizing the scan from the feed rather than from a constant means a feed with
 * no overnight service pays for exactly one service day per query.
 */
export function measureOverhangDays(latestTimes: Iterable<TimeOfDay>): number {
  let longest = 0;
  for (const time of latestTimes) {
    const days = Math.floor(time / SECONDS_PER_DAY);
    if (days > longest) {
      longest = days;
    }
  }
  return longest;
}
