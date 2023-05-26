/**
 * An RFC 4180 CSV tokeniser.
 *
 * Written by hand rather than pulled from a dependency for two reasons. GTFS
 * feeds in the wild break RFC 4180 in specific, well known ways — a UTF-8 BOM
 * on the header, mixed CRLF and LF line endings, stray whitespace around
 * quoted fields — and the parser needs to decide case by case which of those
 * to tolerate and which to reject. It also needs a source position for every
 * field, which general purpose parsers rarely expose.
 *
 * The lexer streams: it holds one row at a time, so a 400 MB `stop_times.txt`
 * does not have to be materialised as an array of arrays.
 */

import { CsvFormatError } from "../errors.js";
import { position, type SourcePosition } from "./position.js";

/** One tokenised field, with the position it started at. */
export interface Field {
  readonly value: string;
  readonly position: SourcePosition;
  /** True when the field was written in quotes in the source. */
  readonly quoted: boolean;
}

/** One tokenised row. */
export interface Row {
  readonly fields: readonly Field[];
  /** One-based physical line on which the row started. */
  readonly line: number;
}

/** Options controlling how strictly the tokeniser reads its input. */
export interface LexerOptions {
  /** Table name used in positions and errors. */
  readonly file: string;
  /**
   * When true, a quoted field followed by trailing text (`"a"b`) is an error.
   * When false the trailing text is appended. Defaults to true.
   */
  readonly strictQuotes?: boolean;
  /**
   * When true, rows containing only empty fields are skipped. Defaults to
   * true: exporters routinely leave a trailing blank line, and treating it as
   * a data row produces a spurious schema error on every feed.
   */
  readonly skipBlankRows?: boolean;
}

/** The UTF-8 byte order mark, as a decoded code point. */
export const BYTE_ORDER_MARK = "﻿";

/**
 * Tokenises CSV text into rows.
 *
 * Yields lazily, so a caller may stop early without paying for the rest of the
 * input.
 *
 * @throws {CsvFormatError} on an unterminated quoted field, or on text
 * following a closing quote when `strictQuotes` is set.
 */
export function* tokenise(text: string, options: LexerOptions): Generator<Row> {
  const file = options.file;
  const strictQuotes = options.strictQuotes ?? true;
  const skipBlankRows = options.skipBlankRows ?? true;

  // The BOM is stripped rather than rejected: it is legal UTF-8, and a feed
  // exported from a spreadsheet almost always carries one.
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;

  let index = 0;
  let line = 1;
  let column = 1;
  let fields: Field[] = [];
  let rowLine = 1;

  const flushRow = (): Row | undefined => {
    const row: Row = { fields, line: rowLine };
    fields = [];
    column = 1;
    if (skipBlankRows && isBlankRow(row)) {
      return undefined;
    }
    return row;
  };

  while (index < source.length) {
    if (fields.length === 0) {
      rowLine = line;
    }

    const fieldStart = position(file, line, column);
    let value = "";
    let quoted = false;

    if (source[index] === '"') {
      quoted = true;
      index += 1;
      let closed = false;
      while (index < source.length) {
        const char = source[index] as string;
        if (char === '"') {
          if (source[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (char === "\n") {
          line += 1;
        }
        value += char;
        index += 1;
      }
      if (!closed) {
        throw new CsvFormatError(`unterminated quoted field in ${file}`, {
          file,
          line: fieldStart.line,
          column: fieldStart.column,
        });
      }
      // Anything between the closing quote and the next delimiter is either an
      // error or, in lenient mode, appended to the value.
      while (index < source.length && !isDelimiter(source[index] as string)) {
        if (strictQuotes) {
          throw new CsvFormatError(`unexpected text after a closing quote in ${file}`, {
            file,
            line: fieldStart.line,
            column: fieldStart.column,
          });
        }
        value += source[index] as string;
        index += 1;
      }
    } else {
      while (index < source.length && !isDelimiter(source[index] as string)) {
        value += source[index] as string;
        index += 1;
      }
    }

    fields.push({ value, position: fieldStart, quoted });
    column += 1;

    const terminator = source[index];
    if (terminator === ",") {
      index += 1;
      continue;
    }
    if (terminator === "\r" || terminator === "\n") {
      // Consume CRLF as a single terminator so a CRLF file does not produce an
      // empty row between every pair of real rows.
      if (terminator === "\r" && source[index + 1] === "\n") {
        index += 2;
      } else {
        index += 1;
      }
      line += 1;
      const row = flushRow();
      if (row !== undefined) {
        yield row;
      }
      continue;
    }
    // End of input with no trailing newline.
    break;
  }

  if (fields.length > 0) {
    const row = flushRow();
    if (row !== undefined) {
      yield row;
    }
  }
}

/**
 * Tokenises the whole input into an array.
 *
 * Convenient for the small tables — `agency.txt`, `calendar.txt` — where the
 * streaming interface buys nothing.
 */
export function tokeniseAll(text: string, options: LexerOptions): Row[] {
  return Array.from(tokenise(text, options));
}

/**
 * Escapes a value for CSV output, quoting only when required.
 *
 * Minimal quoting keeps generated fixtures readable and diffs small.
 */
export function escapeField(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const needsQuoting =
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith(" ") ||
    value.endsWith(" ");
  if (!needsQuoting) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** Renders a row of values as one CSV line, without a trailing newline. */
export function formatRow(values: readonly string[]): string {
  return values.map(escapeField).join(",");
}

function isDelimiter(char: string): boolean {
  return char === "," || char === "\n" || char === "\r";
}

function isBlankRow(row: Row): boolean {
  return row.fields.every((field) => field.value.trim().length === 0);
}
