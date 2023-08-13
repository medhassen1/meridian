/**
 * Column-aligned text tables.
 *
 * Reports are read in a terminal and diffed in a test, which pulls in two
 * directions: alignment has to be computed from the content, and the result
 * has to be byte-stable. Both are satisfied by measuring every cell first,
 * padding to the widest, and never trimming trailing content differently
 * between runs.
 */

/** How a column's cells are aligned. */
export type Alignment = "left" | "right";

/** A column definition. */
export interface Column {
  readonly header: string;
  readonly align?: Alignment;
  /** Truncate cells longer than this, with an ellipsis. */
  readonly maxWidth?: number;
}

/** Options controlling table rendering. */
export interface TableOptions {
  /** String between columns. Defaults to two spaces. */
  readonly gap?: string;
  /** When true, a dashed rule is drawn under the header. Defaults to true. */
  readonly rule?: boolean;
  /** Text used for an empty table body. */
  readonly emptyText?: string;
}

/** Character appended to a truncated cell. */
export const ELLIPSIS = "…";

/**
 * Renders a table.
 *
 * Rows shorter than the column list are padded with empty cells; longer rows
 * are truncated. Neither is an error: a report assembling rows from
 * heterogeneous sources should not have to pad them itself.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string {
  const gap = options.gap ?? "  ";
  const drawRule = options.rule ?? true;

  if (columns.length === 0) {
    return "";
  }
  if (rows.length === 0 && options.emptyText !== undefined) {
    return options.emptyText;
  }

  const normalised = rows.map((row) =>
    columns.map((column, index) => truncate(row[index] ?? "", column.maxWidth)),
  );

  const widths = columns.map((column, index) => {
    let widest = displayWidth(column.header);
    for (const row of normalised) {
      const width = displayWidth(row[index] as string);
      if (width > widest) {
        widest = width;
      }
    }
    return widest;
  });

  const lines: string[] = [];
  lines.push(joinRow(columns.map((column) => column.header), columns, widths, gap));
  if (drawRule) {
    lines.push(widths.map((width) => "-".repeat(width)).join(gap));
  }
  for (const row of normalised) {
    lines.push(joinRow(row, columns, widths, gap));
  }
  return lines.join("\n");
}

/**
 * Renders a two-column key/value block.
 *
 * Used for the summary sections of reports, where a table's header would be
 * noise.
 */
export function renderPairs(
  pairs: readonly (readonly [string, string])[],
  gap = "  ",
): string {
  if (pairs.length === 0) {
    return "";
  }
  const keyWidth = pairs.reduce((widest, [key]) => Math.max(widest, displayWidth(key)), 0);
  return pairs
    .map(([key, value]) => `${pad(key, keyWidth, "left")}${gap}${value}`)
    .join("\n");
}

/**
 * Indents every line of a block by `spaces`.
 *
 * Blank lines are left blank rather than filled with whitespace, so that a
 * rendered report has no trailing spaces to trip a linter or a diff.
 */
export function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

/** Wraps text to a width, breaking on spaces where possible. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

/**
 * The display width of a string.
 *
 * Counts code points rather than UTF-16 code units, so a stop name containing
 * an emoji or an astral-plane character does not shift a column. Full width
 * East Asian characters are not accounted for; doing so properly needs a
 * character width table, which is more machinery than a text report justifies.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const _ of text) {
    width += 1;
  }
  return width;
}

function joinRow(
  cells: readonly string[],
  columns: readonly Column[],
  widths: readonly number[],
  gap: string,
): string {
  return cells
    .map((cell, index) =>
      pad(cell, widths[index] as number, columns[index]?.align ?? "left"),
    )
    .join(gap)
    .replace(/\s+$/, "");
}

function pad(text: string, width: number, align: Alignment): string {
  const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}

function truncate(text: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || maxWidth <= 0 || displayWidth(text) <= maxWidth) {
    return text;
  }
  const characters = Array.from(text);
  return `${characters.slice(0, Math.max(0, maxWidth - 1)).join("")}${ELLIPSIS}`;
}
