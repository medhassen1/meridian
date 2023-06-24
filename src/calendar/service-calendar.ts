/**
 * Which services run on which dates.
 *
 * The two GTFS calendar tables answer the same question from opposite
 * directions, and the routing engine needs the answer both ways: "is service
 * S active on date D" when checking a trip, and "which services are active on
 * date D" when narrowing a search. This class precomputes neither — a feed can
 * span decades — but caches the per-date answer, because a single query asks
 * for the same handful of dates thousands of times.
 */

import { ServiceDate, datesBetween, maxDate, minDate } from "../time/date.js";
import { ExceptionType, type CalendarEntry, type CalendarException } from "../feed/calendar.js";
import { matchesWeeklyPattern } from "../feed/calendar.js";

/** The span of dates a calendar says anything about. */
export interface CalendarCoverage {
  readonly start: ServiceDate;
  readonly end: ServiceDate;
}

/**
 * Resolves service activity from weekly patterns and single-date overrides.
 *
 * Instances are immutable once built and safe to share across queries.
 */
export class ServiceCalendar {
  private readonly patterns: ReadonlyMap<string, CalendarEntry>;
  /** Keyed `serviceId` then epoch day. */
  private readonly overrides: ReadonlyMap<string, ReadonlyMap<number, ExceptionType>>;
  private readonly serviceIdList: readonly string[];
  private readonly coverageSpan: CalendarCoverage | undefined;
  private readonly activeCache = new Map<number, readonly string[]>();

  private constructor(
    patterns: ReadonlyMap<string, CalendarEntry>,
    overrides: ReadonlyMap<string, ReadonlyMap<number, ExceptionType>>,
    serviceIds: readonly string[],
    coverage: CalendarCoverage | undefined,
  ) {
    this.patterns = patterns;
    this.overrides = overrides;
    this.serviceIdList = serviceIds;
    this.coverageSpan = coverage;
  }

  /**
   * Builds a calendar.
   *
   * A repeated `service_id` in `calendar.txt` keeps the first entry, matching
   * the loader's duplicate-key policy; the loader has already reported it.
   */
  static build(
    calendars: readonly CalendarEntry[],
    exceptions: readonly CalendarException[],
  ): ServiceCalendar {
    const patterns = new Map<string, CalendarEntry>();
    for (const entry of calendars) {
      if (!patterns.has(entry.serviceId)) {
        patterns.set(entry.serviceId, entry);
      }
    }

    const overrides = new Map<string, Map<number, ExceptionType>>();
    for (const exception of exceptions) {
      let forService = overrides.get(exception.serviceId);
      if (forService === undefined) {
        forService = new Map();
        overrides.set(exception.serviceId, forService);
      }
      const epochDay = exception.date.toEpochDay();
      if (!forService.has(epochDay)) {
        forService.set(epochDay, exception.exceptionType);
      }
    }

    const serviceIds = new Set<string>([...patterns.keys(), ...overrides.keys()]);
    return new ServiceCalendar(
      patterns,
      overrides,
      Array.from(serviceIds).sort(),
      computeCoverage(calendars, exceptions),
    );
  }

  /** An empty calendar, under which no service is ever active. */
  static empty(): ServiceCalendar {
    return new ServiceCalendar(new Map(), new Map(), [], undefined);
  }

  /** Every service id the calendar defines, sorted. */
  serviceIds(): readonly string[] {
    return this.serviceIdList;
  }

  /** True when the calendar defines the service at all. */
  has(serviceId: string): boolean {
    return this.patterns.has(serviceId) || this.overrides.has(serviceId);
  }

  /**
   * The first and last date the calendar says anything about, or `undefined`
   * for an empty calendar.
   */
  coverage(): CalendarCoverage | undefined {
    return this.coverageSpan;
  }

  /**
   * True when the service runs on the date.
   *
   * An exception always wins over the weekly pattern, including when it falls
   * outside the pattern's own date range — that is how feeds express a special
   * service running once, months after its regular season ended.
   */
  isActive(serviceId: string, date: ServiceDate): boolean {
    const override = this.overrides.get(serviceId)?.get(date.toEpochDay());
    if (override !== undefined) {
      return override === ExceptionType.Added;
    }
    const pattern = this.patterns.get(serviceId);
    return pattern === undefined ? false : matchesWeeklyPattern(pattern, date);
  }

  /**
   * Every service active on the date, sorted.
   *
   * Results are cached per date; the cache is keyed by epoch day and never
   * evicted, which is bounded by the number of distinct dates a process
   * queries.
   */
  activeServiceIds(date: ServiceDate): readonly string[] {
    const epochDay = date.toEpochDay();
    const cached = this.activeCache.get(epochDay);
    if (cached !== undefined) {
      return cached;
    }
    const active = this.serviceIdList.filter((serviceId) => this.isActive(serviceId, date));
    this.activeCache.set(epochDay, active);
    return active;
  }

  /** Every date in `[from, to]` on which the service runs, ascending. */
  activeDates(serviceId: string, from: ServiceDate, to: ServiceDate): ServiceDate[] {
    if (!this.has(serviceId)) {
      return [];
    }
    return datesBetween(from, to).filter((date) => this.isActive(serviceId, date));
  }

  /** Number of dates in `[from, to]` on which the service runs. */
  countActiveDates(serviceId: string, from: ServiceDate, to: ServiceDate): number {
    return this.activeDates(serviceId, from, to).length;
  }

  /**
   * The earliest date on which the service runs, searching only inside the
   * calendar's own coverage.
   */
  firstActiveDate(serviceId: string): ServiceDate | undefined {
    const span = this.coverageSpan;
    if (span === undefined) {
      return undefined;
    }
    return this.activeDates(serviceId, span.start, span.end)[0];
  }

  /** The latest date on which the service runs. */
  lastActiveDate(serviceId: string): ServiceDate | undefined {
    const span = this.coverageSpan;
    if (span === undefined) {
      return undefined;
    }
    const dates = this.activeDates(serviceId, span.start, span.end);
    return dates[dates.length - 1];
  }

  /** True when no service at all runs on the date. */
  isBlankDate(date: ServiceDate): boolean {
    return this.activeServiceIds(date).length === 0;
  }

  /**
   * Services that run on no date inside the calendar's coverage.
   *
   * These are usually the residue of a timetable change: the service is still
   * declared and still referenced by trips, but every date it covered has been
   * removed by exceptions.
   */
  neverActiveServiceIds(): string[] {
    return this.serviceIdList.filter((serviceId) => this.firstActiveDate(serviceId) === undefined);
  }
}

/** The union of every date range and exception date the two tables mention. */
function computeCoverage(
  calendars: readonly CalendarEntry[],
  exceptions: readonly CalendarException[],
): CalendarCoverage | undefined {
  let start: ServiceDate | undefined;
  let end: ServiceDate | undefined;

  for (const entry of calendars) {
    start = start === undefined ? entry.startDate : minDate(start, entry.startDate);
    end = end === undefined ? entry.endDate : maxDate(end, entry.endDate);
  }
  for (const exception of exceptions) {
    start = start === undefined ? exception.date : minDate(start, exception.date);
    end = end === undefined ? exception.date : maxDate(end, exception.date);
  }

  if (start === undefined || end === undefined) {
    return undefined;
  }
  return { start, end };
}
