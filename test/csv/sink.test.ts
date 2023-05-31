import { describe, expect, it } from "vitest";

import {
  compareDiagnostics,
  diagnostic,
  formatDiagnostic,
  formatPosition,
  position,
} from "../../src/csv/position.js";
import { DEFAULT_DIAGNOSTIC_LIMIT, DiagnosticSink } from "../../src/csv/sink.js";

describe("positions", () => {
  it("renders file, line, and column", () => {
    expect(formatPosition(position("stops.txt", 12, 3))).toBe("stops.txt:12:3");
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(position("a.txt", 1, 1))).toBe(true);
  });
});

describe("diagnostics", () => {
  it("renders severity, position, rule, and message", () => {
    const entry = diagnostic("error", "rule.id", "something went wrong", position("a.txt", 2, 1));
    expect(formatDiagnostic(entry)).toBe("error a.txt:2:1 rule.id: something went wrong");
  });

  it("omits an absent position", () => {
    const entry = diagnostic("warning", "rule.id", "no position");
    expect(formatDiagnostic(entry)).toBe("warning rule.id: no position");
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(diagnostic("info", "r", "m"))).toBe(true);
  });
});

describe("compareDiagnostics", () => {
  const at = (file: string, line: number, column = 1) => position(file, line, column);

  it("orders errors before warnings before notes", () => {
    const entries = [
      diagnostic("info", "r", "m"),
      diagnostic("error", "r", "m"),
      diagnostic("warning", "r", "m"),
    ];
    expect(entries.slice().sort(compareDiagnostics).map((entry) => entry.severity)).toEqual([
      "error",
      "warning",
      "info",
    ]);
  });

  it("orders by file, then line, then column", () => {
    const entries = [
      diagnostic("error", "r", "m", at("b.txt", 1)),
      diagnostic("error", "r", "m", at("a.txt", 5, 2)),
      diagnostic("error", "r", "m", at("a.txt", 5, 1)),
      diagnostic("error", "r", "m", at("a.txt", 2)),
    ];
    expect(
      entries
        .slice()
        .sort(compareDiagnostics)
        .map((entry) => formatPosition(entry.position as ReturnType<typeof position>)),
    ).toEqual(["a.txt:2:1", "a.txt:5:1", "a.txt:5:2", "b.txt:1:1"]);
  });

  it("falls back to rule then message", () => {
    const entries = [
      diagnostic("error", "b.rule", "m"),
      diagnostic("error", "a.rule", "z"),
      diagnostic("error", "a.rule", "a"),
    ];
    expect(
      entries.slice().sort(compareDiagnostics).map((entry) => `${entry.rule}/${entry.message}`),
    ).toEqual(["a.rule/a", "a.rule/z", "b.rule/m"]);
  });

  it("sorts entries without a position before those with one", () => {
    const entries = [
      diagnostic("error", "r", "m", at("a.txt", 1)),
      diagnostic("error", "r", "m"),
    ];
    expect(entries.slice().sort(compareDiagnostics)[0]?.position).toBeUndefined();
  });
});

describe("DiagnosticSink", () => {
  it("records each severity separately", () => {
    const sink = new DiagnosticSink();
    sink.error("a", "one");
    sink.warn("b", "two");
    sink.info("c", "three");

    expect(sink.count("error")).toBe(1);
    expect(sink.count("warning")).toBe(1);
    expect(sink.count("info")).toBe(1);
    expect(sink.total()).toBe(3);
    expect(sink.hasErrors()).toBe(true);
  });

  it("reports no errors when only warnings were recorded", () => {
    const sink = new DiagnosticSink();
    sink.warn("a", "one");
    expect(sink.hasErrors()).toBe(false);
  });

  it("keeps insertion order in all()", () => {
    const sink = new DiagnosticSink();
    sink.info("z", "last");
    sink.error("a", "first");
    expect(sink.all().map((entry) => entry.rule)).toEqual(["z", "a"]);
  });

  it("returns canonical order from sorted()", () => {
    const sink = new DiagnosticSink();
    sink.info("z", "note");
    sink.error("a", "problem");
    expect(sink.sorted().map((entry) => entry.severity)).toEqual(["error", "info"]);
  });

  it("filters by severity", () => {
    const sink = new DiagnosticSink();
    sink.error("a", "one");
    sink.warn("b", "two");
    expect(sink.bySeverity("error").map((entry) => entry.rule)).toEqual(["a"]);
    expect(sink.bySeverity("info")).toEqual([]);
  });

  it("absorbs another sink", () => {
    const source = new DiagnosticSink();
    source.error("a", "one", position("t.txt", 1, 1));
    const target = new DiagnosticSink();
    target.warn("b", "two");
    target.absorb(source);

    expect(target.total()).toBe(2);
    expect(target.hasErrors()).toBe(true);
    expect(target.all()[1]?.position).toEqual(position("t.txt", 1, 1));
  });

  it("stops retaining past its limit but keeps counting", () => {
    const sink = new DiagnosticSink(2);
    for (let index = 0; index < 5; index += 1) {
      sink.error("rule", `problem ${index}`);
    }
    expect(sink.all()).toHaveLength(2);
    expect(sink.count("error")).toBe(5);
    expect(sink.truncated()).toBe(true);
  });

  it("reports no truncation below the limit", () => {
    const sink = new DiagnosticSink(10);
    sink.error("a", "one");
    expect(sink.truncated()).toBe(false);
  });

  it("retains nothing with a limit of zero", () => {
    const sink = new DiagnosticSink(0);
    sink.error("a", "one");
    expect(sink.all()).toEqual([]);
    expect(sink.count("error")).toBe(1);
  });

  it("clamps a negative limit to zero", () => {
    const sink = new DiagnosticSink(-5);
    sink.error("a", "one");
    expect(sink.all()).toEqual([]);
  });

  it("uses a documented default limit", () => {
    const sink = new DiagnosticSink();
    for (let index = 0; index <= DEFAULT_DIAGNOSTIC_LIMIT; index += 1) {
      sink.info("rule", "note");
    }
    expect(sink.all()).toHaveLength(DEFAULT_DIAGNOSTIC_LIMIT);
  });

  it("clears everything", () => {
    const sink = new DiagnosticSink();
    sink.error("a", "one");
    sink.clear();
    expect(sink.total()).toBe(0);
    expect(sink.all()).toEqual([]);
    expect(sink.hasErrors()).toBe(false);
  });
});
