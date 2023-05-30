/**
 * Helpers for writing GTFS tables inline in tests.
 *
 * Tests build feeds from string literals rather than from files on disk, which
 * keeps them free of temporary directories and makes the input to a failing
 * assertion visible in the same screen as the assertion.
 */

import { formatRow } from "../../src/csv/lexer.js";

/** Builds a CSV table from a header and rows of values. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [formatRow(header), ...rows.map((row) => formatRow(row))].join("\n");
}

/**
 * Builds a CSV table from objects, using the given column order.
 *
 * Missing keys become empty cells, which is how an optional GTFS field is
 * expressed.
 */
export function tableOf(
  columns: readonly string[],
  records: readonly Readonly<Record<string, string | number | undefined>>[],
): string {
  const rows = records.map((record) =>
    columns.map((column) => {
      const value = record[column];
      return value === undefined ? "" : String(value);
    }),
  );
  return table(columns, rows);
}

/** Builds a table with a header but no data rows. */
export function emptyTable(header: readonly string[]): string {
  return formatRow(header);
}

/** Joins lines with CRLF, for tests that exercise Windows line endings. */
export function withCrlf(text: string): string {
  return text.split("\n").join("\r\n");
}

/** Prefixes text with a UTF-8 byte order mark. */
export function withBom(text: string): string {
  return `﻿${text}`;
}
