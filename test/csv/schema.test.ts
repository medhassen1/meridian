import { describe, expect, it } from "vitest";

import { MeridianError } from "../../src/errors.js";
import { formatRow } from "../../src/csv/lexer.js";
import { parseTableRows, type TableRow } from "../../src/csv/parser.js";
import { RowReader, SCHEMA_RULES } from "../../src/csv/schema.js";
import { DiagnosticSink } from "../../src/csv/sink.js";

/**
 * Builds a reader over a single-row table with the given cells.
 *
 * A sentinel column with a non-blank value is always present: a row whose
 * every cell is empty is a blank row, which the tokeniser skips, and several
 * tests here deliberately supply nothing but empty cells.
 */
function reader(cells: Record<string, string>): { reader: RowReader; sink: DiagnosticSink } {
  const columns = ["__row", ...Object.keys(cells)];
  const values = ["x", ...Object.keys(cells).map((column) => cells[column] ?? "")];
  // Values are escaped, so a test can supply a cell containing a delimiter.
  const text = `${formatRow(columns)}\n${formatRow(values)}`;
  const row = parseTableRows(text, { file: "t.txt" })[0] as TableRow;
  const sink = new DiagnosticSink();
  return { reader: new RowReader(row, sink), sink };
}

/** Builds a reader over a table declaring no columns at all. */
function emptyReader(): { reader: RowReader; sink: DiagnosticSink } {
  const row = parseTableRows("other\nvalue", { file: "t.txt" })[0] as TableRow;
  const sink = new DiagnosticSink();
  return { reader: new RowReader(row, sink), sink };
}

describe("text fields", () => {
  it("reads a required value", () => {
    const { reader: read, sink } = reader({ name: "Central" });
    expect(read.requiredText("name")).toBe("Central");
    expect(sink.total()).toBe(0);
  });

  it("reports a missing required value", () => {
    const { reader: read, sink } = reader({ name: "" });
    expect(read.requiredText("name")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.required);
  });

  it("reports an absent required column", () => {
    const { reader: read, sink } = emptyReader();
    expect(read.requiredText("name")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("reads an optional value", () => {
    const { reader: read, sink } = reader({ name: "" });
    expect(read.optionalText("name")).toBeUndefined();
    expect(sink.total()).toBe(0);
  });

  it("applies a fallback", () => {
    const { reader: read } = reader({ name: "" });
    expect(read.textOr("name", "fallback")).toBe("fallback");
    expect(read.textOr("missing", "fallback")).toBe("fallback");
  });

  it("exposes the underlying row", () => {
    const { reader: read } = reader({ name: "Central" });
    expect(read.source.get("name")).toBe("Central");
  });
});

describe("identifiers", () => {
  it("accepts an ordinary id", () => {
    const { reader: read, sink } = reader({ stop_id: "STOP_1" });
    expect(read.requiredId("stop_id")).toBe("STOP_1");
    expect(sink.total()).toBe(0);
  });

  it("rejects an id containing a delimiter", () => {
    const { reader: read, sink } = reader({ stop_id: "a,b" });
    expect(read.requiredId("stop_id")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("reports a missing required id", () => {
    const { reader: read, sink } = reader({ stop_id: "" });
    expect(read.requiredId("stop_id")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("allows an absent optional id without complaint", () => {
    const { reader: read, sink } = reader({ parent: "" });
    expect(read.optionalId("parent")).toBeUndefined();
    expect(sink.total()).toBe(0);
  });

  it("still validates a present optional id", () => {
    const { reader: read, sink } = reader({ parent: "a\nb" });
    expect(read.optionalId("parent")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });
});

describe("integers", () => {
  it("reads a signed integer", () => {
    const { reader: read } = reader({ n: "-42" });
    expect(read.integer("n")).toBe(-42);
  });

  it("reads a leading plus", () => {
    const { reader: read } = reader({ n: "+7" });
    expect(read.integer("n")).toBe(7);
  });

  it("returns undefined for a blank cell without complaint", () => {
    const { reader: read, sink } = reader({ n: "" });
    expect(read.integer("n")).toBeUndefined();
    expect(sink.total()).toBe(0);
  });

  it("rejects a decimal", () => {
    const { reader: read, sink } = reader({ n: "1.5" });
    expect(read.integer("n")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.integer);
  });

  it("rejects non-numeric text", () => {
    const { reader: read, sink } = reader({ n: "twelve" });
    expect(read.integer("n")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("enforces a minimum", () => {
    const { reader: read, sink } = reader({ n: "-1" });
    expect(read.integer("n", { min: 0 })).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.range);
  });

  it("enforces a maximum", () => {
    const { reader: read, sink } = reader({ n: "11" });
    expect(read.integer("n", { max: 10 })).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.range);
  });

  it("accepts a value on the bounds", () => {
    const { reader: read, sink } = reader({ n: "10" });
    expect(read.integer("n", { min: 10, max: 10 })).toBe(10);
    expect(sink.total()).toBe(0);
  });

  it("reports a missing required integer", () => {
    const { reader: read, sink } = reader({ n: "" });
    expect(read.requiredInteger("n")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.required);
  });

  it("reads a present required integer", () => {
    const { reader: read } = reader({ n: "5" });
    expect(read.requiredInteger("n")).toBe(5);
  });

  it("falls back when absent", () => {
    const { reader: read } = reader({ n: "" });
    expect(read.integerOr("n", 3)).toBe(3);
  });
});

describe("numbers", () => {
  it("reads decimals in several forms", () => {
    for (const [text, value] of [
      ["1.5", 1.5],
      ["-0.25", -0.25],
      [".5", 0.5],
      ["3.", 3],
      ["1e3", 1000],
      ["1.5E-2", 0.015],
    ] as const) {
      const { reader: read } = reader({ n: text });
      expect(read.number("n")).toBe(value);
    }
  });

  it("rejects non-numeric text", () => {
    const { reader: read, sink } = reader({ n: "one point five" });
    expect(read.number("n")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.number);
  });

  it("rejects an infinite value", () => {
    const { reader: read, sink } = reader({ n: "1e999" });
    expect(read.number("n")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("enforces bounds", () => {
    const { reader: read, sink } = reader({ n: "-0.5" });
    expect(read.number("n", { min: 0 })).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("reports a missing required number", () => {
    const { reader: read, sink } = reader({ n: "" });
    expect(read.requiredNumber("n")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.required);
  });

  it("reads a present required number", () => {
    const { reader: read } = reader({ n: "2.5" });
    expect(read.requiredNumber("n")).toBe(2.5);
  });
});

describe("enumerations", () => {
  it("accepts a declared member", () => {
    const { reader: read } = reader({ kind: "2" });
    expect(read.enumeration("kind", [0, 1, 2])).toBe(2);
  });

  it("rejects a value outside the set", () => {
    const { reader: read, sink } = reader({ kind: "5" });
    expect(read.enumeration("kind", [0, 1, 2])).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.enumeration);
  });

  it("returns undefined for a blank cell", () => {
    const { reader: read } = reader({ kind: "" });
    expect(read.enumeration("kind", [0, 1])).toBeUndefined();
  });

  it("falls back for a blank cell", () => {
    const { reader: read } = reader({ kind: "" });
    expect(read.enumerationOr("kind", [0, 1], 1)).toBe(1);
  });

  it("falls back for an invalid value", () => {
    const { reader: read, sink } = reader({ kind: "9" });
    expect(read.enumerationOr("kind", [0, 1], 0)).toBe(0);
    expect(sink.hasErrors()).toBe(true);
  });

  it("throws for an enumeration with no members, which is a caller bug", () => {
    const { reader: read } = reader({ kind: "0" });
    expect(() => read.enumeration("kind", [])).toThrow(MeridianError);
  });
});

describe("flags", () => {
  it("reads 0 and 1", () => {
    expect(reader({ f: "1" }).reader.flag("f")).toBe(true);
    expect(reader({ f: "0" }).reader.flag("f")).toBe(false);
  });

  it("rejects anything else", () => {
    const { reader: read, sink } = reader({ f: "2" });
    expect(read.flag("f")).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("falls back for a blank cell", () => {
    expect(reader({ f: "" }).reader.flagOr("f", true)).toBe(true);
  });

  it("falls back for an invalid value", () => {
    const { reader: read, sink } = reader({ f: "7" });
    expect(read.flagOr("f", false)).toBe(false);
    expect(sink.hasErrors()).toBe(true);
  });
});

describe("dates and times", () => {
  it("reads a compact date", () => {
    expect(reader({ d: "20230605" }).reader.date("d")?.toISO()).toBe("2023-06-05");
  });

  it("rejects a malformed date", () => {
    const { reader: read, sink } = reader({ d: "2023-06-05" });
    expect(read.date("d")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.date);
  });

  it("returns undefined for a blank date", () => {
    expect(reader({ d: "" }).reader.date("d")).toBeUndefined();
  });

  it("reports a missing required date", () => {
    const { reader: read, sink } = reader({ d: "" });
    expect(read.requiredDate("d")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.required);
  });

  it("reads a present required date", () => {
    expect(reader({ d: "20230605" }).reader.requiredDate("d")?.toCompact()).toBe("20230605");
  });

  it("reads a time past 24 hours", () => {
    expect(reader({ t: "25:30:00" }).reader.time("t")).toBe(25 * 3600 + 30 * 60);
  });

  it("rejects a malformed time", () => {
    const { reader: read, sink } = reader({ t: "8:30" });
    expect(read.time("t")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.time);
  });

  it("returns undefined for a blank time", () => {
    expect(reader({ t: "" }).reader.time("t")).toBeUndefined();
  });
});

describe("coordinates", () => {
  it("reads a latitude and longitude", () => {
    expect(reader({ lat: "51.5" }).reader.latitude("lat")).toBe(51.5);
    expect(reader({ lon: "-0.1" }).reader.longitude("lon")).toBe(-0.1);
  });

  it("rejects an out of range latitude", () => {
    const { reader: read, sink } = reader({ lat: "91" });
    expect(read.latitude("lat")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.latitude);
  });

  it("rejects an out of range longitude", () => {
    const { reader: read, sink } = reader({ lon: "181" });
    expect(read.longitude("lon")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.longitude);
  });

  it("returns undefined for a blank or non-numeric coordinate", () => {
    expect(reader({ lat: "" }).reader.latitude("lat")).toBeUndefined();
    expect(reader({ lon: "north" }).reader.longitude("lon")).toBeUndefined();
  });
});

describe("formatted strings", () => {
  it("normalises a colour to upper case", () => {
    expect(reader({ c: "ff0000" }).reader.colour("c")).toBe("FF0000");
  });

  it("rejects a colour with a hash or the wrong length", () => {
    for (const text of ["#ff0000", "f00", "gg0000"]) {
      const { reader: read, sink } = reader({ c: text });
      expect(read.colour("c")).toBeUndefined();
      expect(sink.hasErrors()).toBe(true);
    }
  });

  it("returns undefined for a blank colour", () => {
    expect(reader({ c: "" }).reader.colour("c")).toBeUndefined();
  });

  it("accepts an http and https URL", () => {
    expect(reader({ u: "http://a.example" }).reader.url("u")).toBe("http://a.example");
    expect(reader({ u: "https://a.example/x" }).reader.url("u")).toBe("https://a.example/x");
  });

  it("warns rather than errors on a bad URL", () => {
    const { reader: read, sink } = reader({ u: "a.example" });
    expect(read.url("u")).toBeUndefined();
    expect(sink.count("warning")).toBe(1);
    expect(sink.count("error")).toBe(0);
  });

  it("accepts an email address", () => {
    expect(reader({ e: "a@b.example" }).reader.email("e")).toBe("a@b.example");
  });

  it("warns on a bad email address", () => {
    const { reader: read, sink } = reader({ e: "not-an-email" });
    expect(read.email("e")).toBeUndefined();
    expect(sink.count("warning")).toBe(1);
  });

  it("normalises a currency code to upper case", () => {
    expect(reader({ c: "gbp" }).reader.currency("c")).toBe("GBP");
  });

  it("rejects a currency code of the wrong length", () => {
    const { reader: read, sink } = reader({ c: "GB" });
    expect(read.currency("c")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.currency);
  });

  it("accepts a language tag", () => {
    expect(reader({ l: "en" }).reader.language("l")).toBe("en");
    expect(reader({ l: "en-GB" }).reader.language("l")).toBe("en-GB");
  });

  it("warns on a bad language tag", () => {
    const { reader: read, sink } = reader({ l: "e" });
    expect(read.language("l")).toBeUndefined();
    expect(sink.count("warning")).toBe(1);
  });

  it("accepts an IANA time zone name", () => {
    expect(reader({ z: "Europe/London" }).reader.timezone("z")).toBe("Europe/London");
    expect(reader({ z: "UTC" }).reader.timezone("z")).toBe("UTC");
  });

  it("rejects a malformed time zone name", () => {
    const { reader: read, sink } = reader({ z: "Europe London" });
    expect(read.timezone("z")).toBeUndefined();
    expect(sink.bySeverity("error")[0]?.rule).toBe(SCHEMA_RULES.timezone);
  });

  it("returns undefined for blank formatted strings", () => {
    const { reader: read, sink } = reader({ blank: "" });
    expect(read.url("blank")).toBeUndefined();
    expect(read.email("blank")).toBeUndefined();
    expect(read.currency("blank")).toBeUndefined();
    expect(read.language("blank")).toBeUndefined();
    expect(read.timezone("blank")).toBeUndefined();
    expect(sink.total()).toBe(0);
  });
});
