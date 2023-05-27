/**
 * Typed reads over a parsed CSV row.
 *
 * Every GTFS field maps to one of a small set of value shapes: identifiers,
 * bounded integers, enumerations, dates, times, coordinates, colours, URLs.
 * Centralising the coercion rules here means a malformed value produces the
 * same diagnostic wherever it appears, and each table's loader reads as a
 * declaration of its columns rather than a wall of validation.
 *
 * A reader never throws for bad data. It records a diagnostic and returns
 * `undefined`, letting the table loader decide whether the row is salvageable.
 * It throws only for programmer error, such as an enum with no members.
 */

import { ServiceDate } from "../time/date.js";
import { parseTimeOfDay, type TimeOfDay } from "../time/time-of-day.js";
import { MeridianError } from "../errors.js";
import type { TableRow } from "./parser.js";
import type { DiagnosticSink } from "./sink.js";

/** Bounds applied to a numeric read. */
export interface NumericBounds {
  readonly min?: number;
  readonly max?: number;
}

/** Rule identifiers used by this module, exposed so tests can assert on them. */
export const SCHEMA_RULES = {
  required: "field.required",
  integer: "field.integer",
  number: "field.number",
  range: "field.range",
  enumeration: "field.enum",
  date: "field.date",
  time: "field.time",
  colour: "field.colour",
  url: "field.url",
  email: "field.email",
  latitude: "field.latitude",
  longitude: "field.longitude",
  currency: "field.currency",
  language: "field.language",
  timezone: "field.timezone",
} as const;

/**
 * Reads typed values out of one row, appending problems to a sink.
 *
 * A reader is cheap and single-row: table loaders construct one per row.
 */
export class RowReader {
  private readonly row: TableRow;
  private readonly sink: DiagnosticSink;

  constructor(row: TableRow, sink: DiagnosticSink) {
    this.row = row;
    this.sink = sink;
  }

  /** The underlying row, for loaders needing an unmediated read. */
  get source(): TableRow {
    return this.row;
  }

  /**
   * A required non-empty string. Records `field.required` and returns
   * `undefined` when the column is absent or blank.
   */
  requiredText(column: string): string | undefined {
    const value = this.row.getNonEmpty(column);
    if (value === undefined) {
      this.sink.error(
        SCHEMA_RULES.required,
        `${column} is required and must not be empty`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return value;
  }

  /** An optional string; blank and absent both yield `undefined`. */
  optionalText(column: string): string | undefined {
    return this.row.getNonEmpty(column);
  }

  /** An optional string with a fallback for blank and absent cells. */
  textOr(column: string, fallback: string): string {
    return this.row.getNonEmpty(column) ?? fallback;
  }

  /**
   * A required identifier.
   *
   * GTFS ids are opaque, but an id containing a comma or a newline has almost
   * certainly lost a quote somewhere upstream, and letting it through
   * corrupts every table that references it.
   */
  requiredId(column: string): string | undefined {
    const value = this.requiredText(column);
    if (value === undefined) {
      return undefined;
    }
    if (/[\n\r,]/.test(value)) {
      this.sink.error(
        SCHEMA_RULES.required,
        `${column} contains a delimiter character and is not a usable id`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return value;
  }

  /** An optional identifier, subject to the same character restriction. */
  optionalId(column: string): string | undefined {
    if (this.row.getNonEmpty(column) === undefined) {
      return undefined;
    }
    return this.requiredId(column);
  }

  /** An integer, optionally bounded. Returns `undefined` on any violation. */
  integer(column: string, bounds: NumericBounds = {}): number | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[+-]?\d+$/.test(text)) {
      this.sink.error(
        SCHEMA_RULES.integer,
        `${column} must be an integer, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    const value = Number(text);
    return this.checkBounds(column, value, bounds) ? value : undefined;
  }

  /** A required integer; also records `field.required` when absent. */
  requiredInteger(column: string, bounds: NumericBounds = {}): number | undefined {
    if (this.row.getNonEmpty(column) === undefined) {
      this.sink.error(
        SCHEMA_RULES.required,
        `${column} is required and must not be empty`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return this.integer(column, bounds);
  }

  /** An integer with a fallback used when the cell is absent or blank. */
  integerOr(column: string, fallback: number, bounds: NumericBounds = {}): number {
    return this.integer(column, bounds) ?? fallback;
  }

  /** A finite decimal number, optionally bounded. */
  number(column: string, bounds: NumericBounds = {}): number | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      this.sink.error(
        SCHEMA_RULES.number,
        `${column} must be a number, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      this.sink.error(
        SCHEMA_RULES.number,
        `${column} is not a finite number`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return this.checkBounds(column, value, bounds) ? value : undefined;
  }

  /** A required decimal number. */
  requiredNumber(column: string, bounds: NumericBounds = {}): number | undefined {
    if (this.row.getNonEmpty(column) === undefined) {
      this.sink.error(
        SCHEMA_RULES.required,
        `${column} is required and must not be empty`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return this.number(column, bounds);
  }

  /**
   * One of a fixed set of integer codes.
   *
   * @throws {MeridianError} if `allowed` is empty, which is a caller bug.
   */
  enumeration(column: string, allowed: readonly number[]): number | undefined {
    if (allowed.length === 0) {
      throw new MeridianError("CSV_SCHEMA", `enumeration for ${column} declares no members`, {
        column,
      });
    }
    const value = this.integer(column);
    if (value === undefined) {
      return undefined;
    }
    if (!allowed.includes(value)) {
      this.sink.error(
        SCHEMA_RULES.enumeration,
        `${column} must be one of ${allowed.join(", ")}, found ${value}`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return value;
  }

  /** An enumeration with a fallback for absent or blank cells. */
  enumerationOr(column: string, allowed: readonly number[], fallback: number): number {
    if (this.row.getNonEmpty(column) === undefined) {
      return fallback;
    }
    return this.enumeration(column, allowed) ?? fallback;
  }

  /** A GTFS `0`/`1` flag. */
  flag(column: string): boolean | undefined {
    const value = this.enumeration(column, [0, 1]);
    return value === undefined ? undefined : value === 1;
  }

  /** A GTFS `0`/`1` flag with a fallback for absent or blank cells. */
  flagOr(column: string, fallback: boolean): boolean {
    if (this.row.getNonEmpty(column) === undefined) {
      return fallback;
    }
    return this.flag(column) ?? fallback;
  }

  /** A `YYYYMMDD` service date. */
  date(column: string): ServiceDate | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    try {
      return ServiceDate.parse(text);
    } catch {
      this.sink.error(
        SCHEMA_RULES.date,
        `${column} must be a YYYYMMDD date, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
  }

  /** A required `YYYYMMDD` service date. */
  requiredDate(column: string): ServiceDate | undefined {
    if (this.row.getNonEmpty(column) === undefined) {
      this.sink.error(
        SCHEMA_RULES.required,
        `${column} is required and must not be empty`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return this.date(column);
  }

  /** An `HH:MM:SS` time of day, which may exceed 24 hours. */
  time(column: string): TimeOfDay | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    try {
      return parseTimeOfDay(text);
    } catch {
      this.sink.error(
        SCHEMA_RULES.time,
        `${column} must be a HH:MM:SS time, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
  }

  /** A latitude in degrees. */
  latitude(column: string): number | undefined {
    const value = this.number(column);
    if (value === undefined) {
      return undefined;
    }
    if (Math.abs(value) > 90) {
      this.sink.error(
        SCHEMA_RULES.latitude,
        `${column} must be within ±90, found ${value}`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return value;
  }

  /** A longitude in degrees. */
  longitude(column: string): number | undefined {
    const value = this.number(column);
    if (value === undefined) {
      return undefined;
    }
    if (Math.abs(value) > 180) {
      this.sink.error(
        SCHEMA_RULES.longitude,
        `${column} must be within ±180, found ${value}`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return value;
  }

  /**
   * A six digit hexadecimal colour without a leading `#`.
   *
   * Returned in upper case so that `ff0000` and `FF0000` compare equal
   * downstream.
   */
  colour(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[0-9A-Fa-f]{6}$/.test(text)) {
      this.sink.error(
        SCHEMA_RULES.colour,
        `${column} must be a six digit hex colour, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text.toUpperCase();
  }

  /**
   * An HTTP or HTTPS URL.
   *
   * Only the scheme and overall shape are checked; meridian never dereferences
   * a URL, so anything beyond well-formedness would be false assurance.
   */
  url(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^https?:\/\/[^\s]+$/.test(text)) {
      this.sink.warn(
        SCHEMA_RULES.url,
        `${column} does not look like an http(s) URL: "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text;
  }

  /** An email address, checked only for overall shape. */
  email(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      this.sink.warn(
        SCHEMA_RULES.email,
        `${column} does not look like an email address: "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text;
  }

  /** An ISO 4217 currency code, normalised to upper case. */
  currency(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[A-Za-z]{3}$/.test(text)) {
      this.sink.error(
        SCHEMA_RULES.currency,
        `${column} must be a three letter currency code, found "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text.toUpperCase();
  }

  /** A BCP 47 language tag, checked for shape only. */
  language(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text)) {
      this.sink.warn(
        SCHEMA_RULES.language,
        `${column} does not look like a language tag: "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text;
  }

  /**
   * An IANA time zone name.
   *
   * The name is checked for shape and carried through verbatim; meridian does
   * not resolve it to an offset. See `src/time/zone.ts` for why.
   */
  timezone(column: string): string | undefined {
    const text = this.row.getNonEmpty(column);
    if (text === undefined) {
      return undefined;
    }
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(text)) {
      this.sink.error(
        SCHEMA_RULES.timezone,
        `${column} does not look like an IANA time zone: "${text}"`,
        this.row.positionOf(column),
      );
      return undefined;
    }
    return text;
  }

  private checkBounds(column: string, value: number, bounds: NumericBounds): boolean {
    if (bounds.min !== undefined && value < bounds.min) {
      this.sink.error(
        SCHEMA_RULES.range,
        `${column} must be at least ${bounds.min}, found ${value}`,
        this.row.positionOf(column),
      );
      return false;
    }
    if (bounds.max !== undefined && value > bounds.max) {
      this.sink.error(
        SCHEMA_RULES.range,
        `${column} must be at most ${bounds.max}, found ${value}`,
        this.row.positionOf(column),
      );
      return false;
    }
    return true;
  }
}
