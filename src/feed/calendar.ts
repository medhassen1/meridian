/**
 * `calendar.txt` and `calendar_dates.txt` — which days each service runs.
 *
 * The two tables are complementary rather than alternative. `calendar.txt`
 * states a weekly pattern inside a date range; `calendar_dates.txt` adds and
 * removes individual dates. A feed may use either, both, or — for a service
 * defined entirely by explicit dates — only the second.
 */

import { ServiceDate, WEEKDAY_FIELDS, type Weekday } from "../time/date.js";
import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** The `exception_type` enumeration. */
export enum ExceptionType {
  /** The service runs on this date, overriding the weekly pattern. */
  Added = 1,
  /** The service does not run on this date. */
  Removed = 2,
}

/** One row of `calendar.txt`: a weekly pattern bounded by a date range. */
export interface CalendarEntry {
  readonly serviceId: string;
  /** Indexed by {@link Weekday}, Monday first. */
  readonly days: readonly boolean[];
  readonly startDate: ServiceDate;
  readonly endDate: ServiceDate;
  readonly line: number;
}

/** One row of `calendar_dates.txt`: a single-date override. */
export interface CalendarException {
  readonly serviceId: string;
  readonly date: ServiceDate;
  readonly exceptionType: ExceptionType;
  readonly line: number;
}

/** Columns without which `calendar.txt` cannot be read. */
export const CALENDAR_REQUIRED_COLUMNS: readonly string[] = [
  "service_id",
  ...WEEKDAY_FIELDS,
  "start_date",
  "end_date",
];

/** Columns without which `calendar_dates.txt` cannot be read. */
export const CALENDAR_DATE_REQUIRED_COLUMNS: readonly string[] = [
  "service_id",
  "date",
  "exception_type",
];

/** Rule identifiers emitted by this module. */
export const CALENDAR_RULES = {
  rangeInverted: "calendar.range_inverted",
  neverRuns: "calendar.never_runs",
  duplicateException: "calendar.duplicate_exception",
  redundantException: "calendar.redundant_exception",
  exceptionOutsideRange: "calendar.exception_outside_range",
} as const;

const EXCEPTION_VALUES = [1, 2];

/**
 * Reads every weekly service pattern.
 *
 * A row whose range is inverted is dropped: keeping it would make the service
 * active on no date at all while looking like a real definition, and the
 * resulting "no journeys found" is far harder to diagnose than an explicit
 * error here.
 */
export function readCalendars(table: LoadedTable, sink: DiagnosticSink): CalendarEntry[] {
  requireColumns(table, CALENDAR_REQUIRED_COLUMNS, sink);

  const entries: CalendarEntry[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const serviceId = reader.requiredId("service_id");
    const startDate = reader.requiredDate("start_date");
    const endDate = reader.requiredDate("end_date");
    if (serviceId === undefined || startDate === undefined || endDate === undefined) {
      continue;
    }

    if (endDate.isBefore(startDate)) {
      sink.error(
        CALENDAR_RULES.rangeInverted,
        `service "${serviceId}" ends on ${endDate.toISO()} before it starts on ${startDate.toISO()}`,
        row.positionOf("end_date"),
      );
      continue;
    }

    const days: boolean[] = [];
    let anyDay = false;
    let complete = true;
    for (const field of WEEKDAY_FIELDS) {
      const flag = reader.flag(field);
      if (flag === undefined) {
        complete = false;
        break;
      }
      days.push(flag);
      anyDay = anyDay || flag;
    }
    if (!complete) {
      continue;
    }

    if (!anyDay) {
      // Legal, and used by feeds that define a service purely through
      // exceptions, so it is only worth a note.
      sink.info(
        CALENDAR_RULES.neverRuns,
        `service "${serviceId}" runs on no weekday; it depends entirely on calendar_dates.txt`,
        row.positionOf("monday"),
      );
    }

    entries.push({ serviceId, days, startDate, endDate, line: row.line });
  }
  return entries;
}

/**
 * Reads every single-date service override.
 *
 * Two exceptions for the same service and date contradict each other; the
 * first is kept and the second reported, matching the duplicate-key policy
 * used elsewhere in the loader.
 */
export function readCalendarExceptions(
  table: LoadedTable,
  sink: DiagnosticSink,
): CalendarException[] {
  requireColumns(table, CALENDAR_DATE_REQUIRED_COLUMNS, sink);

  const seen = new Set<string>();
  const exceptions: CalendarException[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const serviceId = reader.requiredId("service_id");
    const date = reader.requiredDate("date");
    const exceptionType = reader.enumeration("exception_type", EXCEPTION_VALUES);
    if (serviceId === undefined || date === undefined || exceptionType === undefined) {
      continue;
    }

    // A comma separates the parts because `optionalId` rejects ids containing
    // one, so no two distinct pairs can produce the same key.
    const key = `${serviceId},${date.toCompact()}`;
    if (seen.has(key)) {
      sink.error(
        CALENDAR_RULES.duplicateException,
        `service "${serviceId}" has more than one exception on ${date.toISO()}; the first is kept`,
        row.positionOf("date"),
      );
      continue;
    }
    seen.add(key);

    exceptions.push({
      serviceId,
      date,
      exceptionType: exceptionType as ExceptionType,
      line: row.line,
    });
  }
  return exceptions;
}

/** True when the weekly pattern includes the given weekday. */
export function runsOnWeekday(entry: CalendarEntry, weekday: Weekday): boolean {
  return entry.days[weekday] === true;
}

/**
 * True when the weekly pattern alone — ignoring exceptions — makes the service
 * active on a date.
 */
export function matchesWeeklyPattern(entry: CalendarEntry, date: ServiceDate): boolean {
  if (!date.isWithin(entry.startDate, entry.endDate)) {
    return false;
  }
  return runsOnWeekday(entry, date.weekday());
}

/**
 * Reports exceptions that cannot change anything: an addition on a date the
 * weekly pattern already covers, a removal on a date it does not, or either
 * outside the pattern's range.
 *
 * These are warnings. They usually mean a feed's generator has drifted from
 * its source data, and they are the cheapest available signal of that.
 */
export function reportRedundantExceptions(
  calendars: readonly CalendarEntry[],
  exceptions: readonly CalendarException[],
  file: string,
  sink: DiagnosticSink,
): void {
  const byService = new Map<string, CalendarEntry>();
  for (const entry of calendars) {
    if (!byService.has(entry.serviceId)) {
      byService.set(entry.serviceId, entry);
    }
  }

  for (const exception of exceptions) {
    const entry = byService.get(exception.serviceId);
    if (entry === undefined) {
      continue;
    }
    const at = { file, line: exception.line, column: 1 };
    if (!exception.date.isWithin(entry.startDate, entry.endDate)) {
      if (exception.exceptionType === ExceptionType.Removed) {
        sink.warn(
          CALENDAR_RULES.exceptionOutsideRange,
          `service "${exception.serviceId}" removes ${exception.date.toISO()}, which is outside its calendar range`,
          at,
        );
      }
      continue;
    }
    const covered = runsOnWeekday(entry, exception.date.weekday());
    if (covered && exception.exceptionType === ExceptionType.Added) {
      sink.warn(
        CALENDAR_RULES.redundantException,
        `service "${exception.serviceId}" adds ${exception.date.toISO()}, which its weekly pattern already covers`,
        at,
      );
    }
    if (!covered && exception.exceptionType === ExceptionType.Removed) {
      sink.warn(
        CALENDAR_RULES.redundantException,
        `service "${exception.serviceId}" removes ${exception.date.toISO()}, which its weekly pattern does not cover`,
        at,
      );
    }
  }
}

/**
 * Every service id defined by either table.
 *
 * Returned sorted so that downstream indexes built from it are deterministic.
 */
export function declaredServiceIds(
  calendars: readonly CalendarEntry[],
  exceptions: readonly CalendarException[],
): string[] {
  const ids = new Set<string>();
  for (const entry of calendars) {
    ids.add(entry.serviceId);
  }
  for (const exception of exceptions) {
    ids.add(exception.serviceId);
  }
  return Array.from(ids).sort();
}
