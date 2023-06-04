/**
 * Shared plumbing for reading one GTFS table.
 *
 * Each table module declares its columns and how to turn a row into an entity;
 * this module owns everything they have in common — locating the table,
 * turning a hard parse failure into a diagnostic rather than an exception,
 * checking that required columns exist, and rejecting duplicate primary keys.
 */

import { isMeridianError } from "../errors.js";
import { parseTableRows, type RaggedRowPolicy, type TableRow } from "../csv/parser.js";
import { position } from "../csv/position.js";
import type { DiagnosticSink } from "../csv/sink.js";
import type { FeedSource } from "./source.js";

/** Rule identifiers emitted by this module. */
export const TABLE_RULES = {
  unreadable: "table.unreadable",
  missingColumn: "table.missing_column",
  duplicateKey: "table.duplicate_key",
  empty: "table.empty",
} as const;

/** A table that was located and tokenised successfully. */
export interface LoadedTable {
  readonly file: string;
  readonly columns: readonly string[];
  readonly rows: readonly TableRow[];
}

/** Options shared by every table read. */
export interface TableReadOptions {
  /** What to do with rows whose width differs from the header's. */
  readonly raggedRows?: RaggedRowPolicy;
  /** Whether to strip surrounding whitespace from every cell. */
  readonly trimCells?: boolean;
}

/**
 * Reads and tokenises one table.
 *
 * Returns `undefined` when the table is absent — that is not itself an error,
 * because most GTFS tables are optional — or when tokenising failed, in which
 * case a `table.unreadable` diagnostic is recorded. A caller that requires the
 * table checks for `undefined` and reports the absence itself, so the message
 * can say why the table was needed.
 */
export function readTable(
  source: FeedSource,
  file: string,
  sink: DiagnosticSink,
  options: TableReadOptions = {},
): LoadedTable | undefined {
  const contents = source.read(file);
  if (contents === undefined) {
    return undefined;
  }
  try {
    const rows = parseTableRows(contents, {
      file,
      ...(options.raggedRows === undefined ? {} : { raggedRows: options.raggedRows }),
      ...(options.trimCells === undefined ? {} : { trimCells: options.trimCells }),
    });
    const columns = rows.length > 0 ? (rows[0] as TableRow).columnNames() : readHeaderOnly(contents);
    return { file, columns, rows };
  } catch (error) {
    const message = isMeridianError(error) ? error.message : String(error);
    const details = isMeridianError(error) ? error.details : {};
    const line = typeof details["line"] === "number" ? details["line"] : 1;
    const column = typeof details["column"] === "number" ? details["column"] : 1;
    sink.error(TABLE_RULES.unreadable, message, position(file, line, column));
    return undefined;
  }
}

/**
 * Records a `table.missing_column` error for each declared column the table
 * lacks, and reports whether every one was present.
 */
export function requireColumns(
  table: LoadedTable,
  columns: readonly string[],
  sink: DiagnosticSink,
): boolean {
  let complete = true;
  for (const column of columns) {
    if (!table.columns.includes(column)) {
      sink.error(
        TABLE_RULES.missingColumn,
        `${table.file} is missing the required column ${column}`,
        position(table.file, 1, 1),
      );
      complete = false;
    }
  }
  return complete;
}

/** Records a warning when a table that should carry data is empty. */
export function warnIfEmpty(table: LoadedTable, sink: DiagnosticSink): void {
  if (table.rows.length === 0) {
    sink.warn(TABLE_RULES.empty, `${table.file} contains no data rows`, position(table.file, 1, 1));
  }
}

/**
 * Indexes entities by a key, reporting duplicates.
 *
 * The *first* entity wins. Keeping the first, rather than the last, means a
 * feed whose exporter appends corrected rows without removing the originals
 * produces a stable result across runs and a diagnostic pointing at the
 * duplicate — rather than silently changing behaviour depending on row order.
 */
export function indexByKey<T>(
  entities: readonly T[],
  keyOf: (entity: T) => string,
  file: string,
  entityLabel: string,
  sink: DiagnosticSink,
  lineOf?: (entity: T) => number,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const entity of entities) {
    const key = keyOf(entity);
    if (index.has(key)) {
      sink.error(
        TABLE_RULES.duplicateKey,
        `duplicate ${entityLabel} "${key}"; the first occurrence is kept`,
        position(file, lineOf === undefined ? 1 : lineOf(entity), 1),
      );
      continue;
    }
    index.set(key, entity);
  }
  return index;
}

/**
 * Groups entities by a key, preserving input order inside each group.
 *
 * Order preservation matters: `stop_times.txt` rows are grouped by trip and
 * then sorted by sequence, and a stable group order makes the sort's tie
 * breaking reproducible.
 */
export function groupByKey<T>(entities: readonly T[], keyOf: (entity: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entity of entities) {
    const key = keyOf(entity);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [entity]);
    } else {
      existing.push(entity);
    }
  }
  return groups;
}

/**
 * Recovers the column names of a table with a header but no data rows.
 *
 * `parseTableRows` yields nothing in that case, so the header is re-read here
 * rather than complicating the parser's return shape for a rare input.
 */
function readHeaderOnly(contents: string): readonly string[] {
  const firstLine = contents.split(/\r?\n/, 1)[0] ?? "";
  const withoutBom = firstLine.startsWith("﻿") ? firstLine.slice(1) : firstLine;
  if (withoutBom.length === 0) {
    return [];
  }
  return withoutBom.split(",").map((name) => name.trim().replace(/^"|"$/g, ""));
}
