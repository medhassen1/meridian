/**
 * Where feed tables come from.
 *
 * The loader reads through a {@link FeedSource} rather than touching the
 * filesystem directly. That keeps the entire parse and validation pipeline
 * pure and synchronous, lets tests build feeds inline as strings, and leaves
 * the choice of container — a directory, a zip archive, an HTTP response
 * already in memory — to the caller.
 */

import { MissingTableError } from "../errors.js";

/** The GTFS table file names meridian knows about. */
export const TABLES = {
  agency: "agency.txt",
  stops: "stops.txt",
  routes: "routes.txt",
  trips: "trips.txt",
  stopTimes: "stop_times.txt",
  calendar: "calendar.txt",
  calendarDates: "calendar_dates.txt",
  frequencies: "frequencies.txt",
  transfers: "transfers.txt",
  shapes: "shapes.txt",
  fareAttributes: "fare_attributes.txt",
  fareRules: "fare_rules.txt",
  pathways: "pathways.txt",
  levels: "levels.txt",
  feedInfo: "feed_info.txt",
} as const;

/** A table name known to meridian. */
export type TableName = (typeof TABLES)[keyof typeof TABLES];

/**
 * Tables without which no useful network can be built.
 *
 * `calendar.txt` is deliberately absent: a feed may express its entire service
 * calendar through `calendar_dates.txt` alone, and many production feeds do.
 * The loader checks that at least one of the two is present.
 */
export const REQUIRED_TABLES: readonly TableName[] = [
  TABLES.agency,
  TABLES.stops,
  TABLES.routes,
  TABLES.trips,
  TABLES.stopTimes,
];

/** A readable collection of GTFS tables. */
export interface FeedSource {
  /** True when the source can supply the named table. */
  has(table: string): boolean;
  /** The table's contents, or `undefined` when it is absent. */
  read(table: string): string | undefined;
  /** Every table the source can supply, in a stable order. */
  tableNames(): readonly string[];
}

/**
 * A feed held entirely in memory.
 *
 * Table names are matched exactly. Sources that need to be forgiving about
 * casing or directory prefixes should normalise before constructing.
 */
export class MemoryFeedSource implements FeedSource {
  private readonly tables: Map<string, string>;

  constructor(tables: Readonly<Record<string, string>> = {}) {
    this.tables = new Map(Object.entries(tables));
  }

  /** Adds or replaces a table. Returns `this` so calls can be chained. */
  set(table: string, contents: string): this {
    this.tables.set(table, contents);
    return this;
  }

  /** Removes a table. Returns true when something was removed. */
  delete(table: string): boolean {
    return this.tables.delete(table);
  }

  has(table: string): boolean {
    return this.tables.has(table);
  }

  read(table: string): string | undefined {
    return this.tables.get(table);
  }

  /**
   * The table's contents.
   *
   * @throws {MissingTableError} when the table is absent.
   */
  readRequired(table: string): string {
    const contents = this.tables.get(table);
    if (contents === undefined) {
      throw new MissingTableError(table);
    }
    return contents;
  }

  /** Table names in ascending lexicographic order. */
  tableNames(): readonly string[] {
    return Array.from(this.tables.keys()).sort();
  }
}

/**
 * Wraps another source, exposing only the named tables.
 *
 * Used by the validator to check how a feed behaves when an optional table is
 * absent, without building a second copy of it.
 */
export class FilteredFeedSource implements FeedSource {
  private readonly inner: FeedSource;
  private readonly allowed: ReadonlySet<string>;

  constructor(inner: FeedSource, allowed: Iterable<string>) {
    this.inner = inner;
    this.allowed = new Set(allowed);
  }

  has(table: string): boolean {
    return this.allowed.has(table) && this.inner.has(table);
  }

  read(table: string): string | undefined {
    return this.allowed.has(table) ? this.inner.read(table) : undefined;
  }

  tableNames(): readonly string[] {
    return this.inner.tableNames().filter((name) => this.allowed.has(name));
  }
}

/** Names of the required tables the source cannot supply. */
export function missingRequiredTables(source: FeedSource): TableName[] {
  return REQUIRED_TABLES.filter((table) => !source.has(table));
}

/**
 * True when the source can supply at least one of `calendar.txt` and
 * `calendar_dates.txt`.
 */
export function hasAnyCalendarTable(source: FeedSource): boolean {
  return source.has(TABLES.calendar) || source.has(TABLES.calendarDates);
}
