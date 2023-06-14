/**
 * `feed_info.txt` — provenance and the window the feed claims to cover.
 *
 * The declared window is worth reading even though nothing enforces it. A
 * query outside it is not an error, but it is the single most common reason a
 * journey search returns nothing, and saying so turns a baffling empty result
 * into an obvious one.
 */

import { ServiceDate } from "../time/date.js";
import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** One row of `feed_info.txt`. */
export interface FeedInfo {
  readonly publisherName: string;
  readonly publisherUrl: string | undefined;
  readonly lang: string | undefined;
  readonly defaultLang: string | undefined;
  readonly startDate: ServiceDate | undefined;
  readonly endDate: ServiceDate | undefined;
  readonly version: string | undefined;
  readonly contactEmail: string | undefined;
  readonly contactUrl: string | undefined;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const FEED_INFO_REQUIRED_COLUMNS: readonly string[] = [
  "feed_publisher_name",
  "feed_publisher_url",
  "feed_lang",
];

/** Rule identifiers emitted by this module. */
export const FEED_INFO_RULES = {
  multipleRows: "feed_info.multiple_rows",
  rangeInverted: "feed_info.range_inverted",
  partialRange: "feed_info.partial_range",
} as const;

/**
 * Reads the feed's own metadata.
 *
 * The table is defined to hold exactly one row. Extra rows are ignored with a
 * warning rather than merged, because there is no sensible way to combine two
 * publishers.
 */
export function readFeedInfo(table: LoadedTable, sink: DiagnosticSink): FeedInfo | undefined {
  requireColumns(table, FEED_INFO_REQUIRED_COLUMNS, sink);

  const row = table.rows[0];
  if (row === undefined) {
    return undefined;
  }
  if (table.rows.length > 1) {
    sink.warn(
      FEED_INFO_RULES.multipleRows,
      `feed_info.txt has ${table.rows.length} rows; only the first is read`,
      row.positionOf("feed_publisher_name"),
    );
  }

  const reader = new RowReader(row, sink);
  const publisherName = reader.requiredText("feed_publisher_name");
  if (publisherName === undefined) {
    return undefined;
  }

  const startDate = reader.date("feed_start_date");
  const endDate = reader.date("feed_end_date");
  if (startDate !== undefined && endDate !== undefined && endDate.isBefore(startDate)) {
    sink.error(
      FEED_INFO_RULES.rangeInverted,
      `feed_end_date ${endDate.toISO()} precedes feed_start_date ${startDate.toISO()}`,
      row.positionOf("feed_end_date"),
    );
    return undefined;
  }
  if ((startDate === undefined) !== (endDate === undefined)) {
    sink.warn(
      FEED_INFO_RULES.partialRange,
      "feed_info.txt states only one end of its date range, so the range is ignored",
      row.positionOf("feed_start_date"),
    );
  }

  return {
    publisherName,
    publisherUrl: reader.url("feed_publisher_url"),
    lang: reader.language("feed_lang"),
    defaultLang: reader.language("default_lang"),
    startDate,
    endDate,
    version: reader.optionalText("feed_version"),
    contactEmail: reader.email("feed_contact_email"),
    contactUrl: reader.url("feed_contact_url"),
    line: row.line,
  };
}

/**
 * True when the feed declares a complete date range and the date falls inside
 * it. A feed with no declared range covers every date.
 */
export function coversDate(info: FeedInfo | undefined, date: ServiceDate): boolean {
  if (info?.startDate === undefined || info.endDate === undefined) {
    return true;
  }
  return date.isWithin(info.startDate, info.endDate);
}

/** The declared range as text, or `undefined` when the feed states none. */
export function describeRange(info: FeedInfo | undefined): string | undefined {
  if (info?.startDate === undefined || info.endDate === undefined) {
    return undefined;
  }
  return `${info.startDate.toISO()}..${info.endDate.toISO()}`;
}
