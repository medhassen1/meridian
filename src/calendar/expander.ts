/**
 * Summarising a service calendar over a date range.
 *
 * Answers the questions an operator asks when a timetable looks wrong: on
 * which days does this service actually run, which days have no service at
 * all, and where does the published calendar stop.
 */

import { ServiceDate, Weekday, datesBetween } from "../time/date.js";
import type { ServiceCalendar } from "./service-calendar.js";

/** A contiguous run of dates on which a service runs. */
export interface DateRun {
  readonly start: ServiceDate;
  readonly end: ServiceDate;
  /** Number of dates in the run; always at least one. */
  readonly days: number;
}

/** What a service does across a date range. */
export interface ServiceProfile {
  readonly serviceId: string;
  /** Total active dates inside the range. */
  readonly activeDays: number;
  /** Contiguous active runs, ascending. */
  readonly runs: readonly DateRun[];
  /** Count of active dates per weekday, indexed Monday first. */
  readonly byWeekday: readonly number[];
  readonly firstActive: ServiceDate | undefined;
  readonly lastActive: ServiceDate | undefined;
}

/**
 * Collapses a service's active dates into contiguous runs.
 *
 * A weekday-only service across a month produces one run per week rather than
 * one span, which is exactly the shape that makes an unexpected gap visible.
 */
export function activeRuns(
  calendar: ServiceCalendar,
  serviceId: string,
  from: ServiceDate,
  to: ServiceDate,
): DateRun[] {
  const dates = calendar.activeDates(serviceId, from, to);
  const runs: DateRun[] = [];
  let runStart: ServiceDate | undefined;
  let previous: ServiceDate | undefined;

  for (const date of dates) {
    if (runStart === undefined || previous === undefined) {
      runStart = date;
      previous = date;
      continue;
    }
    if (previous.daysUntil(date) === 1) {
      previous = date;
      continue;
    }
    runs.push({ start: runStart, end: previous, days: runStart.daysUntil(previous) + 1 });
    runStart = date;
    previous = date;
  }

  if (runStart !== undefined && previous !== undefined) {
    runs.push({ start: runStart, end: previous, days: runStart.daysUntil(previous) + 1 });
  }
  return runs;
}

/** Builds a full profile of one service across a range. */
export function profileService(
  calendar: ServiceCalendar,
  serviceId: string,
  from: ServiceDate,
  to: ServiceDate,
): ServiceProfile {
  const dates = calendar.activeDates(serviceId, from, to);
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const date of dates) {
    byWeekday[date.weekday()] = (byWeekday[date.weekday()] as number) + 1;
  }

  return {
    serviceId,
    activeDays: dates.length,
    runs: activeRuns(calendar, serviceId, from, to),
    byWeekday,
    firstActive: dates[0],
    lastActive: dates[dates.length - 1],
  };
}

/** Profiles every service the calendar defines, in service-id order. */
export function profileAllServices(
  calendar: ServiceCalendar,
  from: ServiceDate,
  to: ServiceDate,
): ServiceProfile[] {
  return calendar.serviceIds().map((serviceId) => profileService(calendar, serviceId, from, to));
}

/**
 * Dates in the range on which no service at all runs.
 *
 * A handful of these are normal — public holidays with no service, or the gap
 * between two timetable seasons. A long unbroken stretch means the feed has
 * expired.
 */
export function blankDates(
  calendar: ServiceCalendar,
  from: ServiceDate,
  to: ServiceDate,
): ServiceDate[] {
  return datesBetween(from, to).filter((date) => calendar.isBlankDate(date));
}

/**
 * The longest run of consecutive dates with no service at all.
 *
 * Returned as a run so a report can name both ends.
 */
export function longestBlankRun(
  calendar: ServiceCalendar,
  from: ServiceDate,
  to: ServiceDate,
): DateRun | undefined {
  let longest: DateRun | undefined;
  let runStart: ServiceDate | undefined;
  let previous: ServiceDate | undefined;

  const close = (): void => {
    if (runStart === undefined || previous === undefined) {
      return;
    }
    const days = runStart.daysUntil(previous) + 1;
    if (longest === undefined || days > longest.days) {
      longest = { start: runStart, end: previous, days };
    }
  };

  for (const date of datesBetween(from, to)) {
    if (!calendar.isBlankDate(date)) {
      close();
      runStart = undefined;
      previous = undefined;
      continue;
    }
    if (runStart === undefined) {
      runStart = date;
    }
    previous = date;
  }
  close();
  return longest;
}

/**
 * The number of distinct services active on each date in the range.
 *
 * A sudden drop marks the boundary between two timetable seasons, which is
 * where a feed most often turns out to be truncated.
 */
export function serviceCountByDate(
  calendar: ServiceCalendar,
  from: ServiceDate,
  to: ServiceDate,
): Array<{ date: ServiceDate; services: number }> {
  return datesBetween(from, to).map((date) => ({
    date,
    services: calendar.activeServiceIds(date).length,
  }));
}

/** A short human readable description of which weekdays a profile covers. */
export function describeWeekdays(profile: ServiceProfile): string {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const active = names.filter((_, index) => (profile.byWeekday[index] as number) > 0);
  if (active.length === 0) {
    return "never";
  }
  if (active.length === 7) {
    return "daily";
  }
  if (
    (profile.byWeekday[Weekday.Saturday] as number) === 0 &&
    (profile.byWeekday[Weekday.Sunday] as number) === 0 &&
    active.length === 5
  ) {
    return "weekdays";
  }
  return active.join(" ");
}
