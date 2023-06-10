/**
 * `transfers.txt` — how a passenger moves between two stops, when the agency
 * has said something more specific than "walk".
 *
 * Published transfers override anything meridian would infer from geometry.
 * An agency knows that its two platforms are connected by a 90 second
 * underground passage, or that a particular interchange is not permitted at
 * all, and neither fact is derivable from coordinates.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** The `transfer_type` enumeration. */
export enum TransferType {
  /** A recommended interchange point; timing is not guaranteed. */
  Recommended = 0,
  /** The departing vehicle waits for the arriving one. */
  Timed = 1,
  /** A minimum time is needed, given in `min_transfer_time`. */
  MinimumTime = 2,
  /** The interchange is not possible. */
  NotPossible = 3,
  /** Riders stay aboard; the vehicle continues as the other trip. */
  InSeat = 4,
  /** Riders must alight and reboard, despite a shared vehicle. */
  NoInSeat = 5,
}

/** One row of `transfers.txt`. */
export interface Transfer {
  readonly fromStopId: string | undefined;
  readonly toStopId: string | undefined;
  readonly transferType: TransferType;
  readonly minTransferTime: number | undefined;
  readonly fromRouteId: string | undefined;
  readonly toRouteId: string | undefined;
  readonly fromTripId: string | undefined;
  readonly toTripId: string | undefined;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const TRANSFER_REQUIRED_COLUMNS: readonly string[] = ["transfer_type"];

/** Rule identifiers emitted by this module. */
export const TRANSFER_RULES = {
  endpointsRequired: "transfer.endpoints_required",
  minTimeRequired: "transfer.min_time_required",
  minTimeIgnored: "transfer.min_time_ignored",
  tripRequired: "transfer.trip_required",
  duplicate: "transfer.duplicate",
} as const;

const TRANSFER_VALUES = [0, 1, 2, 3, 4, 5];

/**
 * Reads every transfer rule.
 *
 * Stop endpoints are optional in the modern specification — a trip-to-trip
 * in-seat transfer identifies itself by trip alone — so the row is validated
 * against the requirements of its own transfer type rather than a single
 * blanket rule.
 */
export function readTransfers(table: LoadedTable, sink: DiagnosticSink): Transfer[] {
  requireColumns(table, TRANSFER_REQUIRED_COLUMNS, sink);

  const transfers: Transfer[] = [];
  const seen = new Set<string>();

  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const transferTypeRaw = reader.enumeration("transfer_type", TRANSFER_VALUES);
    if (transferTypeRaw === undefined) {
      continue;
    }
    const transferType = transferTypeRaw as TransferType;

    const fromStopId = reader.optionalId("from_stop_id");
    const toStopId = reader.optionalId("to_stop_id");
    const fromTripId = reader.optionalId("from_trip_id");
    const toTripId = reader.optionalId("to_trip_id");

    const isSeatRule =
      transferType === TransferType.InSeat || transferType === TransferType.NoInSeat;

    if (isSeatRule) {
      if (fromTripId === undefined || toTripId === undefined) {
        sink.error(
          TRANSFER_RULES.tripRequired,
          `transfer_type ${transferType} requires both from_trip_id and to_trip_id`,
          row.positionOf("from_trip_id"),
        );
        continue;
      }
    } else if (fromStopId === undefined || toStopId === undefined) {
      sink.error(
        TRANSFER_RULES.endpointsRequired,
        `transfer_type ${transferType} requires both from_stop_id and to_stop_id`,
        row.positionOf("from_stop_id"),
      );
      continue;
    }

    const minTransferTime = reader.integer("min_transfer_time", { min: 0 });
    if (transferType === TransferType.MinimumTime && minTransferTime === undefined) {
      sink.error(
        TRANSFER_RULES.minTimeRequired,
        "transfer_type 2 requires a min_transfer_time",
        row.positionOf("min_transfer_time"),
      );
      continue;
    }
    if (transferType === TransferType.NotPossible && minTransferTime !== undefined) {
      sink.warn(
        TRANSFER_RULES.minTimeIgnored,
        "min_transfer_time is ignored for transfer_type 3",
        row.positionOf("min_transfer_time"),
      );
    }

    // A comma separates the parts because `optionalId` rejects ids containing
    // one, so no two distinct rules can produce the same key.
    const key = [
      fromStopId,
      toStopId,
      fromRouteKey(reader),
      toRouteKey(reader),
      fromTripId,
      toTripId,
    ].join(",");
    if (seen.has(key)) {
      sink.error(
        TRANSFER_RULES.duplicate,
        "duplicate transfer rule; the first occurrence is kept",
        position(table.file, row.line, 1),
      );
      continue;
    }
    seen.add(key);

    transfers.push({
      fromStopId,
      toStopId,
      transferType,
      minTransferTime,
      fromRouteId: reader.optionalId("from_route_id"),
      toRouteId: reader.optionalId("to_route_id"),
      fromTripId,
      toTripId,
      line: row.line,
    });
  }
  return transfers;
}

/** True when the rule forbids the interchange entirely. */
export function forbidsTransfer(transfer: Transfer): boolean {
  return transfer.transferType === TransferType.NotPossible;
}

/** True when the departing vehicle is held for the arriving one. */
export function isTimedTransfer(transfer: Transfer): boolean {
  return transfer.transferType === TransferType.Timed;
}

/** True when riders remain aboard through the interchange. */
export function isInSeatTransfer(transfer: Transfer): boolean {
  return transfer.transferType === TransferType.InSeat;
}

/**
 * Seconds a rider needs for this interchange, or `undefined` when the rule
 * does not constrain the time.
 *
 * A timed transfer resolves to zero: the connection is guaranteed, so no slack
 * is required beyond the vehicle waiting.
 */
export function requiredTransferSeconds(transfer: Transfer): number | undefined {
  switch (transfer.transferType) {
    case TransferType.Timed:
      return 0;
    case TransferType.MinimumTime:
      return transfer.minTransferTime;
    case TransferType.Recommended:
    case TransferType.NotPossible:
    case TransferType.InSeat:
    case TransferType.NoInSeat:
      return undefined;
  }
}

/**
 * How specific a rule is, used to pick a winner when several apply to one
 * interchange.
 *
 * Trip-level rules beat route-level rules, which beat stop-level rules. That
 * ordering is what the specification prescribes and what an agency expects:
 * the narrower statement is the more deliberate one.
 */
export function transferSpecificity(transfer: Transfer): number {
  let score = 0;
  if (transfer.fromTripId !== undefined) {
    score += 8;
  }
  if (transfer.toTripId !== undefined) {
    score += 8;
  }
  if (transfer.fromRouteId !== undefined) {
    score += 2;
  }
  if (transfer.toRouteId !== undefined) {
    score += 2;
  }
  return score;
}

function fromRouteKey(reader: RowReader): string {
  return reader.source.getNonEmpty("from_route_id") ?? "";
}

function toRouteKey(reader: RowReader): string {
  return reader.source.getNonEmpty("to_route_id") ?? "";
}
