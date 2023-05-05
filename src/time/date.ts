/**
 * Proleptic Gregorian calendar dates, independent of any runtime clock.
 *
 * GTFS identifies a *service date* — the calendar day a trip's schedule is
 * anchored to — as an eight digit `YYYYMMDD` string. A service date is not an
 * instant: it names a day in the agency's local calendar, and the trips
 * anchored to it may run past midnight into the following calendar day.
 *
 * {@link ServiceDate} therefore models a civil date only. It never consults
 * `Date`, `Date.now`, or the host time zone, which keeps every date
 * computation in the library reproducible on any machine.
 */

import { TimeRangeError } from "../errors.js";

/** Day of the week, matching the column order of GTFS `calendar.txt`. */
export enum Weekday {
  Monday = 0,
  Tuesday = 1,
  Wednesday = 2,
  Thursday = 3,
  Friday = 4,
  Saturday = 5,
  Sunday = 6,
}

/** The GTFS `calendar.txt` column name for each weekday, in column order. */
export const WEEKDAY_FIELDS: readonly string[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Earliest representable year. Feeds predating this are rejected outright. */
export const MIN_YEAR = 1900;

/** Latest representable year. */
export const MAX_YEAR = 2200;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Number of seconds in one calendar day, ignoring leap seconds. */
export const SECONDS_PER_DAY = 86_400;

/**
 * A civil date in the proleptic Gregorian calendar.
 *
 * Instances are immutable and compare by value. The canonical internal
 * representation is the *epoch day*: a signed day count relative to
 * 1970-01-01, which makes arithmetic and ordering exact integer operations.
 */
export class ServiceDate {
  /** Four digit year. */
  readonly year: number;

  /** Month, 1-12. */
  readonly month: number;

  /** Day of month, 1-31. */
  readonly day: number;

  private readonly epochDay: number;

  private constructor(year: number, month: number, day: number, epochDay: number) {
    this.year = year;
    this.month = month;
    this.day = day;
    this.epochDay = epochDay;
    Object.freeze(this);
  }

  /**
   * Builds a date from calendar parts.
   *
   * @throws {TimeRangeError} if the parts do not name a real date, including
   * 29 February in a common year.
   */
  static fromParts(year: number, month: number, day: number): ServiceDate {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      throw new TimeRangeError("date parts must be integers", { year, month, day });
    }
    if (year < MIN_YEAR || year > MAX_YEAR) {
      throw new TimeRangeError(`year ${year} is outside ${MIN_YEAR}-${MAX_YEAR}`, { year });
    }
    if (month < 1 || month > 12) {
      throw new TimeRangeError(`month ${month} is outside 1-12`, { year, month });
    }
    const limit = daysInMonth(year, month);
    if (day < 1 || day > limit) {
      throw new TimeRangeError(`day ${day} is outside 1-${limit} for ${year}-${month}`, {
        year,
        month,
        day,
      });
    }
    return new ServiceDate(year, month, day, epochDayFromCivil(year, month, day));
  }

  /**
   * Parses the GTFS compact form `YYYYMMDD`.
   *
   * Surrounding whitespace is rejected rather than trimmed: feed cells are
   * trimmed by the CSV schema layer, so whitespace reaching here indicates a
   * caller bug.
   *
   * @throws {TimeRangeError} if the text is not eight digits naming a real
   * date.
   */
  static parse(text: string): ServiceDate {
    if (!/^\d{8}$/.test(text)) {
      throw new TimeRangeError(`"${text}" is not an 8 digit YYYYMMDD date`, { text });
    }
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = Number(text.slice(6, 8));
    return ServiceDate.fromParts(year, month, day);
  }

  /**
   * Parses either the compact `YYYYMMDD` form or the extended `YYYY-MM-DD`
   * form. Provided for command line input, where the hyphenated form is what
   * people type.
   */
  static parseFlexible(text: string): ServiceDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) {
      return ServiceDate.fromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    return ServiceDate.parse(text);
  }

  /**
   * Rebuilds a date from its epoch day.
   *
   * @throws {TimeRangeError} if the resulting year falls outside the
   * representable range.
   */
  static fromEpochDay(epochDay: number): ServiceDate {
    if (!Number.isInteger(epochDay)) {
      throw new TimeRangeError("epoch day must be an integer", { epochDay });
    }
    const civil = civilFromEpochDay(epochDay);
    if (civil.year < MIN_YEAR || civil.year > MAX_YEAR) {
      throw new TimeRangeError(`epoch day ${epochDay} is outside the representable range`, {
        epochDay,
        year: civil.year,
      });
    }
    return new ServiceDate(civil.year, civil.month, civil.day, epochDay);
  }

  /** Signed day count relative to 1970-01-01. */
  toEpochDay(): number {
    return this.epochDay;
  }

  /** Renders the GTFS compact form, for example `20230401`. */
  toCompact(): string {
    return `${pad(this.year, 4)}${pad(this.month, 2)}${pad(this.day, 2)}`;
  }

  /** Renders the extended form, for example `2023-04-01`. */
  toISO(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  /** Alias of {@link ServiceDate.toISO}, so template literals read well. */
  toString(): string {
    return this.toISO();
  }

  /** Serialises to the compact form when embedded in JSON reports. */
  toJSON(): string {
    return this.toCompact();
  }

  /** Day of the week, using the GTFS column ordering (Monday first). */
  weekday(): Weekday {
    // 1970-01-01 was a Thursday, which is index 3 in a Monday-first week.
    return (((this.epochDay + 3) % 7) + 7) % 7;
  }

  /** Returns the date `days` days after this one; negative values go back. */
  addDays(days: number): ServiceDate {
    if (!Number.isInteger(days)) {
      throw new TimeRangeError("day offset must be an integer", { days });
    }
    return ServiceDate.fromEpochDay(this.epochDay + days);
  }

  /**
   * Returns the date `months` months after this one, clamping the day of month
   * to the length of the target month.
   *
   * Clamping, rather than overflowing into the next month, keeps "the same day
   * next month" stable for schedule windows anchored to month ends.
   */
  addMonths(months: number): ServiceDate {
    if (!Number.isInteger(months)) {
      throw new TimeRangeError("month offset must be an integer", { months });
    }
    const total = this.year * 12 + (this.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = (((total % 12) + 12) % 12) + 1;
    const day = Math.min(this.day, daysInMonth(year, month));
    return ServiceDate.fromParts(year, month, day);
  }

  /** Signed number of days from this date to `other`. */
  daysUntil(other: ServiceDate): number {
    return other.epochDay - this.epochDay;
  }

  /** Total ordering: negative, zero, or positive. */
  compare(other: ServiceDate): number {
    return this.epochDay - other.epochDay;
  }

  /** Value equality. */
  equals(other: ServiceDate): boolean {
    return this.epochDay === other.epochDay;
  }

  /** True when this date is strictly before `other`. */
  isBefore(other: ServiceDate): boolean {
    return this.epochDay < other.epochDay;
  }

  /** True when this date is strictly after `other`. */
  isAfter(other: ServiceDate): boolean {
    return this.epochDay > other.epochDay;
  }

  /** True when `start <= this <= end`, treating both bounds as inclusive. */
  isWithin(start: ServiceDate, end: ServiceDate): boolean {
    return this.epochDay >= start.epochDay && this.epochDay <= end.epochDay;
  }
}

/** True when `year` is a Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Number of days in `month` of `year`.
 *
 * @throws {TimeRangeError} if the month is outside 1-12.
 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new TimeRangeError(`month ${month} is outside 1-12`, { year, month });
  }
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] as number;
}

/**
 * Returns every date from `start` to `end`, both inclusive, in ascending
 * order.
 *
 * @throws {TimeRangeError} if `end` precedes `start`.
 */
export function datesBetween(start: ServiceDate, end: ServiceDate): ServiceDate[] {
  const span = start.daysUntil(end);
  if (span < 0) {
    throw new TimeRangeError("range end precedes range start", {
      start: start.toCompact(),
      end: end.toCompact(),
    });
  }
  const dates: ServiceDate[] = [];
  for (let offset = 0; offset <= span; offset += 1) {
    dates.push(start.addDays(offset));
  }
  return dates;
}

/** Returns the earlier of two dates; ties return `a`. */
export function minDate(a: ServiceDate, b: ServiceDate): ServiceDate {
  return b.isBefore(a) ? b : a;
}

/** Returns the later of two dates; ties return `a`. */
export function maxDate(a: ServiceDate, b: ServiceDate): ServiceDate {
  return b.isAfter(a) ? b : a;
}

/**
 * Days elapsed from 1970-01-01 to the given civil date.
 *
 * Uses the shift-to-March algorithm so that leap days land at the end of the
 * internal year, which removes every special case from the arithmetic.
 */
function epochDayFromCivil(year: number, month: number, day: number): number {
  const shifted = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of {@link epochDayFromCivil}. */
function civilFromEpochDay(epochDay: number): { year: number; month: number; day: number } {
  const shifted = epochDay + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const internalMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * internalMonth + 2) / 5) + 1;
  const month = internalMonth + (internalMonth < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
