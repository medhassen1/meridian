import { describe, expect, it } from "vitest";

import { DiagnosticSink } from "../../src/csv/sink.js";
import { ServiceDate, Weekday } from "../../src/time/date.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { readTable } from "../../src/feed/table.js";
import {
  ExceptionType,
  declaredServiceIds,
  matchesWeeklyPattern,
  readCalendarExceptions,
  readCalendars,
  reportRedundantExceptions,
  runsOnWeekday,
  type CalendarEntry,
} from "../../src/feed/calendar.js";
import { table } from "../support/csv.js";

const CALENDAR_HEADER = [
  "service_id",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "start_date",
  "end_date",
];

function readCalendarTable(rows: string[][]) {
  const sink = new DiagnosticSink();
  const loaded = readTable(
    new MemoryFeedSource({ "calendar.txt": table(CALENDAR_HEADER, rows) }),
    "calendar.txt",
    sink,
  );
  return { entries: readCalendars(loaded as never, sink), sink };
}

function readExceptionTable(rows: string[][]) {
  const sink = new DiagnosticSink();
  const loaded = readTable(
    new MemoryFeedSource({
      "calendar_dates.txt": table(["service_id", "date", "exception_type"], rows),
    }),
    "calendar_dates.txt",
    sink,
  );
  return { exceptions: readCalendarExceptions(loaded as never, sink), sink };
}

describe("readCalendars", () => {
  it("reads a weekday pattern", () => {
    const { entries, sink } = readCalendarTable([
      ["WEEKDAY", "1", "1", "1", "1", "1", "0", "0", "20230601", "20230831"],
    ]);
    const entry = entries[0] as CalendarEntry;
    expect(entry.serviceId).toBe("WEEKDAY");
    expect(entry.days).toEqual([true, true, true, true, true, false, false]);
    expect(entry.startDate.toCompact()).toBe("20230601");
    expect(sink.hasErrors()).toBe(false);
  });

  it("drops a row with an inverted date range", () => {
    const { entries, sink } = readCalendarTable([
      ["S", "1", "1", "1", "1", "1", "0", "0", "20230831", "20230601"],
    ]);
    expect(entries).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "calendar.range_inverted")).toBe(true);
  });

  it("drops a row missing a required field", () => {
    const { entries } = readCalendarTable([
      ["", "1", "1", "1", "1", "1", "0", "0", "20230601", "20230831"],
      ["S", "1", "1", "1", "1", "1", "0", "0", "", "20230831"],
      ["S", "1", "1", "1", "1", "1", "0", "0", "20230601", ""],
    ]);
    expect(entries).toEqual([]);
  });

  it("drops a row with a malformed weekday flag", () => {
    const { entries } = readCalendarTable([
      ["S", "1", "1", "1", "1", "yes", "0", "0", "20230601", "20230831"],
    ]);
    expect(entries).toEqual([]);
  });

  it("notes a pattern that runs on no weekday", () => {
    const { entries, sink } = readCalendarTable([
      ["S", "0", "0", "0", "0", "0", "0", "0", "20230601", "20230831"],
    ]);
    expect(entries).toHaveLength(1);
    expect(sink.bySeverity("info").some((entry) => entry.rule === "calendar.never_runs")).toBe(true);
  });

  it("accepts a single-day range", () => {
    const { entries, sink } = readCalendarTable([
      ["S", "1", "1", "1", "1", "1", "1", "1", "20230601", "20230601"],
    ]);
    expect(entries).toHaveLength(1);
    expect(sink.hasErrors()).toBe(false);
  });
});

describe("weekly pattern matching", () => {
  const { entries } = readCalendarTable([
    ["WEEKDAY", "1", "1", "1", "1", "1", "0", "0", "20230601", "20230831"],
  ]);
  const entry = entries[0] as CalendarEntry;

  it("matches a weekday inside the range", () => {
    expect(matchesWeeklyPattern(entry, ServiceDate.parse("20230605"))).toBe(true);
  });

  it("does not match a weekend day", () => {
    expect(matchesWeeklyPattern(entry, ServiceDate.parse("20230610"))).toBe(false);
  });

  it("does not match a date outside the range", () => {
    expect(matchesWeeklyPattern(entry, ServiceDate.parse("20230501"))).toBe(false);
    expect(matchesWeeklyPattern(entry, ServiceDate.parse("20230901"))).toBe(false);
  });

  it("answers per weekday", () => {
    expect(runsOnWeekday(entry, Weekday.Monday)).toBe(true);
    expect(runsOnWeekday(entry, Weekday.Sunday)).toBe(false);
  });
});

describe("readCalendarExceptions", () => {
  it("reads an addition and a removal", () => {
    const { exceptions, sink } = readExceptionTable([
      ["S", "20230612", "1"],
      ["S", "20230613", "2"],
    ]);
    expect(exceptions[0]?.exceptionType).toBe(ExceptionType.Added);
    expect(exceptions[1]?.exceptionType).toBe(ExceptionType.Removed);
    expect(sink.hasErrors()).toBe(false);
  });

  it("drops a row missing a required field", () => {
    const { exceptions } = readExceptionTable([
      ["", "20230612", "1"],
      ["S", "", "1"],
      ["S", "20230612", ""],
    ]);
    expect(exceptions).toEqual([]);
  });

  it("rejects an unrecognised exception type", () => {
    const { exceptions, sink } = readExceptionTable([["S", "20230612", "3"]]);
    expect(exceptions).toEqual([]);
    expect(sink.hasErrors()).toBe(true);
  });

  it("keeps the first of two exceptions for the same service and date", () => {
    const { exceptions, sink } = readExceptionTable([
      ["S", "20230612", "1"],
      ["S", "20230612", "2"],
    ]);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.exceptionType).toBe(ExceptionType.Added);
    expect(
      sink.bySeverity("error").some((entry) => entry.rule === "calendar.duplicate_exception"),
    ).toBe(true);
  });

  it("allows the same date for different services", () => {
    const { exceptions, sink } = readExceptionTable([
      ["A", "20230612", "1"],
      ["B", "20230612", "1"],
    ]);
    expect(exceptions).toHaveLength(2);
    expect(sink.hasErrors()).toBe(false);
  });
});

describe("reportRedundantExceptions", () => {
  const { entries } = readCalendarTable([
    ["WEEKDAY", "1", "1", "1", "1", "1", "0", "0", "20230601", "20230831"],
  ]);

  const check = (rows: string[][]) => {
    const { exceptions } = readExceptionTable(rows);
    const sink = new DiagnosticSink();
    reportRedundantExceptions(entries, exceptions, "calendar_dates.txt", sink);
    return sink;
  };

  it("warns about adding a date the pattern already covers", () => {
    const sink = check([["WEEKDAY", "20230605", "1"]]);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "calendar.redundant_exception")).toBe(
      true,
    );
  });

  it("warns about removing a date the pattern does not cover", () => {
    const sink = check([["WEEKDAY", "20230610", "2"]]);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "calendar.redundant_exception")).toBe(
      true,
    );
  });

  it("accepts adding a weekend date", () => {
    expect(check([["WEEKDAY", "20230610", "1"]]).count("warning")).toBe(0);
  });

  it("accepts removing a weekday date", () => {
    expect(check([["WEEKDAY", "20230605", "2"]]).count("warning")).toBe(0);
  });

  it("warns about a removal outside the pattern's range", () => {
    const sink = check([["WEEKDAY", "20230501", "2"]]);
    expect(
      sink.bySeverity("warning").some((entry) => entry.rule === "calendar.exception_outside_range"),
    ).toBe(true);
  });

  it("says nothing about an addition outside the range", () => {
    expect(check([["WEEKDAY", "20230501", "1"]]).count("warning")).toBe(0);
  });

  it("ignores exceptions for a service with no weekly pattern", () => {
    expect(check([["OTHER", "20230605", "1"]]).total()).toBe(0);
  });
});

describe("declaredServiceIds", () => {
  it("unions both tables and sorts", () => {
    const { entries } = readCalendarTable([
      ["B", "1", "1", "1", "1", "1", "0", "0", "20230601", "20230831"],
    ]);
    const { exceptions } = readExceptionTable([
      ["A", "20230612", "1"],
      ["B", "20230613", "2"],
    ]);
    expect(declaredServiceIds(entries, exceptions)).toEqual(["A", "B"]);
  });

  it("returns nothing when both tables are empty", () => {
    expect(declaredServiceIds([], [])).toEqual([]);
  });
});
