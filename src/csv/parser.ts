/**
 * Turns tokenised CSV rows into header-keyed records.
 *
 * The parser is where "this file is syntactically CSV" becomes "this file is a
 * table with these columns". It owns header validation, row width policy, and
 * cell trimming — decisions that must be uniform across every GTFS table, and
 * which the per-table schemas then build typed values on top of.
 */

import { CsvFormatError } from "../errors.js";
import { tokenise, type LexerOptions, type Row } from "./lexer.js";
import { position, type SourcePosition } from "./position.js";

/** How to handle a row whose field count differs from the header's. */
export type RaggedRowPolicy = "error" | "pad" | "skip";

/** Options controlling record construction. */
export interface ParserOptions extends LexerOptions {
  /**
   * What to do with a row that is too short or too long. Defaults to `"error"`.
   *
   * `"pad"` fills missing trailing cells with the empty string and drops
   * surplus ones, which is what a tolerant importer does; `"skip"` discards
   * the row entirely.
   */
  readonly raggedRows?: RaggedRowPolicy;
  /**
   * When true, leading and trailing whitespace is stripped from every cell.
   * Defaults to true. GTFS values are never meaningfully padded, and exporters
   * that align columns for readability are common.
   */
  readonly trimCells?: boolean;
}

/**
 * One parsed row, addressed by column name.
 *
 * Absent columns and empty cells are deliberately distinguishable:
 * {@link TableRow.has} reports whether the *table* declares a column, while
 * {@link TableRow.get} returns the empty string for a declared-but-blank cell.
 * GTFS gives the two different meanings — an absent `stop_times.timepoint`
 * column means "every stop is a timepoint", whereas a blank cell means "not a
 * timepoint".
 */
export class TableRow {
  /** Table name, for diagnostics. */
  readonly file: string;

  /** One-based physical line the row started on. */
  readonly line: number;

  private readonly columns: readonly string[];
  private readonly values: readonly string[];
  private readonly positions: readonly SourcePosition[];

  constructor(
    file: string,
    line: number,
    columns: readonly string[],
    values: readonly string[],
    positions: readonly SourcePosition[],
  ) {
    this.file = file;
    this.line = line;
    this.columns = columns;
    this.values = values;
    this.positions = positions;
  }

  /** True when the table declares `column`, regardless of this row's value. */
  has(column: string): boolean {
    return this.columns.includes(column);
  }

  /** The cell value, or `undefined` when the table has no such column. */
  get(column: string): string | undefined {
    const index = this.columns.indexOf(column);
    return index === -1 ? undefined : this.values[index];
  }

  /**
   * The cell value, or `undefined` when the column is absent *or* the cell is
   * empty. This is the common case for optional GTFS fields.
   */
  getNonEmpty(column: string): string | undefined {
    const value = this.get(column);
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /** Position of a cell, falling back to the row start for absent columns. */
  positionOf(column: string): SourcePosition {
    const index = this.columns.indexOf(column);
    if (index === -1) {
      return position(this.file, this.line, 1);
    }
    return this.positions[index] as SourcePosition;
  }

  /** The column names declared by the table, in file order. */
  columnNames(): readonly string[] {
    return this.columns;
  }

  /** A plain object copy, useful in test assertions and debug output. */
  toObject(): Record<string, string> {
    const object: Record<string, string> = {};
    for (let index = 0; index < this.columns.length; index += 1) {
      object[this.columns[index] as string] = this.values[index] as string;
    }
    return object;
  }
}

/** A parsed table: its header plus a lazily produced sequence of rows. */
export interface ParsedTable {
  readonly file: string;
  readonly columns: readonly string[];
  readonly rows: Iterable<TableRow>;
}

/**
 * Parses CSV text into header-keyed rows.
 *
 * @throws {CsvFormatError} if the input is empty, the header repeats a column
 * name, the header contains a blank name, or a ragged row is found under the
 * `"error"` policy.
 */
export function parseTable(text: string, options: ParserOptions): ParsedTable {
  const trimCells = options.trimCells ?? true;
  const raggedRows = options.raggedRows ?? "error";

  const iterator = tokenise(text, options)[Symbol.iterator]();
  const headerResult = iterator.next();
  if (headerResult.done === true) {
    throw new CsvFormatError(`${options.file} contains no header row`, { file: options.file });
  }

  const columns = readHeader(headerResult.value, options.file, trimCells);

  const rows: Iterable<TableRow> = {
    *[Symbol.iterator](): Generator<TableRow> {
      let current = iterator.next();
      while (current.done !== true) {
        const row = buildRow(current.value, columns, options.file, trimCells, raggedRows);
        if (row !== undefined) {
          yield row;
        }
        current = iterator.next();
      }
    },
  };

  return { file: options.file, columns, rows };
}

/**
 * Parses the whole table into an array.
 *
 * Callers that need to iterate twice — the validator does — should use this
 * rather than draining the streaming form, which is single-pass.
 */
export function parseTableRows(text: string, options: ParserOptions): TableRow[] {
  return Array.from(parseTable(text, options).rows);
}

function readHeader(row: Row, file: string, trimCells: boolean): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const field of row.fields) {
    const name = trimCells ? field.value.trim() : field.value;
    if (name.length === 0) {
      throw new CsvFormatError(`${file} has a blank column name`, {
        file,
        line: field.position.line,
        column: field.position.column,
      });
    }
    if (seen.has(name)) {
      throw new CsvFormatError(`${file} declares column "${name}" more than once`, {
        file,
        line: field.position.line,
        column: field.position.column,
        columnName: name,
      });
    }
    seen.add(name);
    columns.push(name);
  }
  if (columns.length === 0) {
    throw new CsvFormatError(`${file} has an empty header row`, { file });
  }
  return columns;
}

function buildRow(
  row: Row,
  columns: readonly string[],
  file: string,
  trimCells: boolean,
  policy: RaggedRowPolicy,
): TableRow | undefined {
  if (row.fields.length !== columns.length) {
    if (policy === "error") {
      throw new CsvFormatError(
        `${file} line ${row.line} has ${row.fields.length} fields, expected ${columns.length}`,
        { file, line: row.line, found: row.fields.length, expected: columns.length },
      );
    }
    if (policy === "skip") {
      return undefined;
    }
  }

  const values: string[] = [];
  const positions: SourcePosition[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const field = row.fields[index];
    if (field === undefined) {
      values.push("");
      positions.push(position(file, row.line, index + 1));
      continue;
    }
    values.push(trimCells ? field.value.trim() : field.value);
    positions.push(field.position);
  }

  return new TableRow(file, row.line, columns, values, positions);
}
