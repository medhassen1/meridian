/**
 * `agency.txt` — the transit agencies whose services the feed describes.
 *
 * The table is small but load-bearing: it supplies the time zone every other
 * table's times are implicitly expressed in, and its id is what makes a route
 * attributable in a multi-operator feed.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { requireColumns, warnIfEmpty, type LoadedTable } from "./table.js";

/** One row of `agency.txt`. */
export interface Agency {
  /**
   * The agency identifier.
   *
   * GTFS allows this column to be omitted entirely when a feed describes a
   * single agency. Rather than propagate `undefined` through every route, the
   * loader substitutes the empty string, which is a value no real feed uses
   * and which routes with a blank `agency_id` resolve against naturally.
   */
  readonly agencyId: string;
  readonly agencyName: string;
  readonly agencyUrl: string | undefined;
  /** IANA time zone name, carried verbatim. */
  readonly agencyTimezone: string;
  readonly agencyLang: string | undefined;
  readonly agencyPhone: string | undefined;
  readonly agencyFareUrl: string | undefined;
  readonly agencyEmail: string | undefined;
  /** Source line, retained for diagnostics. */
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const AGENCY_REQUIRED_COLUMNS: readonly string[] = [
  "agency_name",
  "agency_url",
  "agency_timezone",
];

/** Rule identifiers emitted by this module. */
export const AGENCY_RULES = {
  idRequired: "agency.id_required",
  timezoneMismatch: "agency.timezone_mismatch",
} as const;

/**
 * Reads every agency from a loaded table.
 *
 * Rows missing a name or time zone are dropped with an error; the rest are
 * kept even if optional fields fail validation, because a bad `agency_url`
 * does not stop a network from being built.
 */
export function readAgencies(table: LoadedTable, sink: DiagnosticSink): Agency[] {
  requireColumns(table, AGENCY_REQUIRED_COLUMNS, sink);
  warnIfEmpty(table, sink);

  const declaresId = table.columns.includes("agency_id");
  const agencies: Agency[] = [];

  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const agencyName = reader.requiredText("agency_name");
    const agencyTimezone = reader.timezone("agency_timezone");

    if (agencyName === undefined || agencyTimezone === undefined) {
      continue;
    }

    // A feed with several agencies must identify them; one without the column
    // at all is the documented single-agency shorthand.
    const rawId = declaresId ? reader.optionalId("agency_id") : undefined;
    if (declaresId && rawId === undefined && table.rows.length > 1) {
      sink.error(
        AGENCY_RULES.idRequired,
        "agency_id is required when the feed declares more than one agency",
        row.positionOf("agency_id"),
      );
      continue;
    }

    agencies.push({
      agencyId: rawId ?? "",
      agencyName,
      agencyUrl: reader.url("agency_url"),
      agencyTimezone,
      agencyLang: reader.language("agency_lang"),
      agencyPhone: reader.optionalText("agency_phone"),
      agencyFareUrl: reader.url("agency_fare_url"),
      agencyEmail: reader.email("agency_email"),
      line: row.line,
    });
  }

  reportTimezoneDisagreement(table, agencies, sink);
  return agencies;
}

/**
 * The time zone shared by every agency, or `undefined` when they disagree.
 *
 * Callers converting service-day times to instants need a single zone for the
 * feed; when agencies disagree there is no correct answer and the caller must
 * supply one.
 */
export function commonTimezone(agencies: readonly Agency[]): string | undefined {
  const first = agencies[0];
  if (first === undefined) {
    return undefined;
  }
  return agencies.every((agency) => agency.agencyTimezone === first.agencyTimezone)
    ? first.agencyTimezone
    : undefined;
}

/**
 * Records a warning when agencies declare different time zones.
 *
 * This is legal GTFS and meridian handles it, but it changes what a wall clock
 * time means from one route to the next, and a reader should know.
 */
function reportTimezoneDisagreement(
  table: LoadedTable,
  agencies: readonly Agency[],
  sink: DiagnosticSink,
): void {
  if (agencies.length < 2 || commonTimezone(agencies) !== undefined) {
    return;
  }
  const zones = Array.from(new Set(agencies.map((agency) => agency.agencyTimezone))).sort();
  sink.warn(
    AGENCY_RULES.timezoneMismatch,
    `agencies declare ${zones.length} different time zones (${zones.join(", ")})`,
    position(table.file, 1, 1),
  );
}
