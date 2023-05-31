import { describe, expect, it } from "vitest";

import { CsvFormatError } from "../../src/errors.js";
import { escapeField, formatRow, tokeniseAll } from "../../src/csv/lexer.js";
import { withBom, withCrlf } from "../support/csv.js";

const lex = (text: string, options: Record<string, unknown> = {}) =>
  tokeniseAll(text, { file: "test.txt", ...options });

const values = (text: string, options: Record<string, unknown> = {}): string[][] =>
  lex(text, options).map((row) => row.fields.map((field) => field.value));

describe("basic tokenising", () => {
  it("splits a simple row", () => {
    expect(values("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("splits several rows", () => {
    expect(values("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a trailing empty field", () => {
    expect(values("a,b,")).toEqual([["a", "b", ""]]);
  });

  it("keeps a leading empty field", () => {
    expect(values(",b,c")).toEqual([["", "b", "c"]]);
  });

  it("keeps interior empty fields", () => {
    expect(values("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("keeps a trailing empty field on the last row without a newline", () => {
    expect(values("a,b\nc,")).toEqual([
      ["a", "b"],
      ["c", ""],
    ]);
  });

  it("reads a single field with no delimiter at all", () => {
    expect(values("only")).toEqual([["only"]]);
  });

  it("produces nothing for empty input", () => {
    expect(values("")).toEqual([]);
  });
});

describe("line endings", () => {
  it("reads LF", () => {
    expect(values("a\nb")).toEqual([["a"], ["b"]]);
  });

  it("reads CRLF without producing blank rows", () => {
    expect(values(withCrlf("a,b\nc,d"))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("reads a lone CR", () => {
    expect(values("a\rb")).toEqual([["a"], ["b"]]);
  });

  it("ignores a trailing newline", () => {
    expect(values("a,b\n")).toEqual([["a", "b"]]);
  });

  it("numbers lines correctly across CRLF", () => {
    const rows = lex(withCrlf("a\nb\nc"));
    expect(rows.map((row) => row.line)).toEqual([1, 2, 3]);
  });
});

describe("byte order mark", () => {
  it("strips a leading BOM", () => {
    expect(values(withBom("a,b"))).toEqual([["a", "b"]]);
  });

  it("leaves a BOM elsewhere alone", () => {
    const rows = values("a,﻿b");
    expect(rows[0]?.[1]).toBe("﻿b");
  });
});

describe("quoted fields", () => {
  it("reads a quoted value", () => {
    expect(values('"a","b"')).toEqual([["a", "b"]]);
  });

  it("keeps a comma inside quotes", () => {
    expect(values('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  it("keeps a newline inside quotes", () => {
    expect(values('"a\nb",c')).toEqual([["a\nb", "c"]]);
  });

  it("counts embedded newlines when numbering lines", () => {
    // The quoted field spans physical lines 1 and 2, so the next row starts
    // on line 3 even though it is only the second record.
    const rows = lex('"a\nb",c\nd,e');
    expect(rows[0]?.line).toBe(1);
    expect(rows[1]?.line).toBe(3);
  });

  it("unescapes a doubled quote", () => {
    expect(values('"say ""hi""",b')).toEqual([['say "hi"', "b"]]);
  });

  it("reads an empty quoted field", () => {
    expect(values('"",b')).toEqual([["", "b"]]);
  });

  it("records that a field was quoted", () => {
    const rows = lex('"a",b');
    expect(rows[0]?.fields[0]?.quoted).toBe(true);
    expect(rows[0]?.fields[1]?.quoted).toBe(false);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => lex('"abc')).toThrow(CsvFormatError);
    expect(() => lex('a,"abc')).toThrow(/unterminated/);
  });

  it("rejects text following a closing quote in strict mode", () => {
    expect(() => lex('"a"b')).toThrow(/after a closing quote/);
  });

  it("appends text following a closing quote in lenient mode", () => {
    expect(values('"a"b,c', { strictQuotes: false })).toEqual([["ab", "c"]]);
  });
});

describe("blank rows", () => {
  it("skips them by default", () => {
    expect(values("a,b\n\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("skips a row of only whitespace", () => {
    expect(values("a,b\n   \nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps them when asked", () => {
    expect(values("a,b\n\nc,d", { skipBlankRows: false })).toEqual([["a", "b"], [""], ["c", "d"]]);
  });

  it("skips a trailing blank row without a newline", () => {
    expect(values("a,b\n  ")).toEqual([["a", "b"]]);
  });
});

describe("positions", () => {
  it("numbers columns from one", () => {
    const rows = lex("a,b,c");
    expect(rows[0]?.fields.map((field) => field.position.column)).toEqual([1, 2, 3]);
  });

  it("numbers lines from one", () => {
    const rows = lex("a\nb\nc");
    expect(rows.map((row) => row.fields[0]?.position.line)).toEqual([1, 2, 3]);
  });

  it("carries the file name into every position", () => {
    const rows = tokeniseAll("a,b", { file: "stops.txt" });
    expect(rows[0]?.fields[0]?.position.file).toBe("stops.txt");
  });

  it("names the offending position in an error", () => {
    try {
      lex('a,b\nc,"unterminated');
      expect.unreachable("expected a CsvFormatError");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvFormatError);
      expect((error as CsvFormatError).details["line"]).toBe(2);
      expect((error as CsvFormatError).details["column"]).toBe(2);
    }
  });
});

describe("escapeField", () => {
  it("leaves a plain value alone", () => {
    expect(escapeField("plain")).toBe("plain");
    expect(escapeField("")).toBe("");
  });

  it("quotes values containing a delimiter", () => {
    expect(escapeField("a,b")).toBe('"a,b"');
    expect(escapeField("a\nb")).toBe('"a\nb"');
    expect(escapeField("a\rb")).toBe('"a\rb"');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(escapeField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes values with surrounding whitespace", () => {
    expect(escapeField(" padded")).toBe('" padded"');
    expect(escapeField("padded ")).toBe('"padded "');
  });
});

describe("formatRow", () => {
  it("joins escaped values with commas", () => {
    expect(formatRow(["a", "b,c", 'd"e'])).toBe('a,"b,c","d""e"');
  });

  it("round-trips through the tokeniser", () => {
    const original = ["plain", "with,comma", 'with"quote', "", " padded "];
    expect(values(formatRow(original))).toEqual([original]);
  });
});
