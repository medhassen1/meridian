import { describe, expect, it } from "vitest";

import { CsvFormatError } from "../../src/errors.js";
import { parseTable, parseTableRows, TableRow } from "../../src/csv/parser.js";

const parse = (text: string, options: Record<string, unknown> = {}) =>
  parseTableRows(text, { file: "test.txt", ...options });

describe("headers", () => {
  it("keys rows by column name", () => {
    const rows = parse("a,b\n1,2");
    expect(rows[0]?.get("a")).toBe("1");
    expect(rows[0]?.get("b")).toBe("2");
  });

  it("exposes the declared column order", () => {
    expect(parseTable("b,a\n1,2", { file: "t.txt" }).columns).toEqual(["b", "a"]);
  });

  it("recovers the header of a table with no data rows", () => {
    expect(parseTable("a,b\n", { file: "t.txt" }).columns).toEqual(["a", "b"]);
  });

  it("recovers a quoted header of a table with no data rows", () => {
    expect(parseTable('"a","b"', { file: "t.txt" }).columns).toEqual(["a", "b"]);
  });

  it("rejects an empty file", () => {
    expect(() => parse("")).toThrow(/no header row/);
  });

  it("rejects a blank column name", () => {
    expect(() => parse("a,,c\n1,2,3")).toThrow(/blank column name/);
  });

  it("rejects a repeated column name", () => {
    expect(() => parse("a,a\n1,2")).toThrow(/more than once/);
  });

  it("trims header names", () => {
    expect(parse(" a , b \n1,2")[0]?.get("a")).toBe("1");
  });
});

describe("cell trimming", () => {
  it("trims by default", () => {
    expect(parse("a\n  padded  ")[0]?.get("a")).toBe("padded");
  });

  it("can be disabled", () => {
    expect(parse("a\n  padded  ", { trimCells: false })[0]?.get("a")).toBe("  padded  ");
  });
});

describe("ragged rows", () => {
  it("rejects a short row by default", () => {
    expect(() => parse("a,b\n1")).toThrow(CsvFormatError);
  });

  it("rejects a long row by default", () => {
    expect(() => parse("a,b\n1,2,3")).toThrow(/3 fields, expected 2/);
  });

  it("pads a short row when asked", () => {
    const rows = parse("a,b\n1", { raggedRows: "pad" });
    expect(rows[0]?.get("a")).toBe("1");
    expect(rows[0]?.get("b")).toBe("");
  });

  it("drops surplus cells when padding", () => {
    const rows = parse("a,b\n1,2,3", { raggedRows: "pad" });
    expect(rows[0]?.toObject()).toEqual({ a: "1", b: "2" });
  });

  it("skips a ragged row when asked", () => {
    const rows = parse("a,b\n1\n2,3", { raggedRows: "skip" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.get("a")).toBe("2");
  });

  it("names the offending line in the error", () => {
    try {
      parse("a,b\n1,2\n3");
      expect.unreachable("expected a CsvFormatError");
    } catch (error) {
      expect((error as CsvFormatError).details["line"]).toBe(3);
    }
  });
});

describe("TableRow", () => {
  const rows = parse("a,b,c\n1,,3");
  const row = rows[0] as TableRow;

  it("distinguishes an absent column from an empty cell", () => {
    expect(row.has("b")).toBe(true);
    expect(row.has("z")).toBe(false);
    expect(row.get("b")).toBe("");
    expect(row.get("z")).toBeUndefined();
  });

  it("collapses empty and absent in getNonEmpty", () => {
    expect(row.getNonEmpty("a")).toBe("1");
    expect(row.getNonEmpty("b")).toBeUndefined();
    expect(row.getNonEmpty("z")).toBeUndefined();
  });

  it("reports a cell's position", () => {
    expect(row.positionOf("c")).toEqual({ file: "test.txt", line: 2, column: 3 });
  });

  it("falls back to the row start for an absent column", () => {
    expect(row.positionOf("z")).toEqual({ file: "test.txt", line: 2, column: 1 });
  });

  it("reports its own file and line", () => {
    expect(row.file).toBe("test.txt");
    expect(row.line).toBe(2);
  });

  it("lists its column names", () => {
    expect(row.columnNames()).toEqual(["a", "b", "c"]);
  });

  it("converts to a plain object", () => {
    expect(row.toObject()).toEqual({ a: "1", b: "", c: "3" });
  });
});

describe("streaming", () => {
  it("yields rows lazily", () => {
    const parsed = parseTable("a\n1\n2\n3", { file: "t.txt" });
    const iterator = parsed.rows[Symbol.iterator]();
    expect(iterator.next().value?.get("a")).toBe("1");
    expect(iterator.next().value?.get("a")).toBe("2");
  });

  it("can be drained more than once when materialised", () => {
    const rows = parseTableRows("a\n1\n2", { file: "t.txt" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.get("a"))).toEqual(["1", "2"]);
  });

  it("reports a ragged row lazily, at the point of iteration", () => {
    const parsed = parseTable("a,b\n1,2\n3", { file: "t.txt" });
    expect(() => Array.from(parsed.rows)).toThrow(CsvFormatError);
  });
});
