import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import {
  MAX_YEAR,
  MIN_YEAR,
  ServiceDate,
  WEEKDAY_FIELDS,
  Weekday,
  datesBetween,
  daysInMonth,
  isLeapYear,
  maxDate,
  minDate,
} from "../../src/time/date.js";

describe("ServiceDate.fromParts", () => {
  it("builds a date from valid parts", () => {
    const date = ServiceDate.fromParts(2023, 6, 5);
    expect(date.year).toBe(2023);
    expect(date.month).toBe(6);
    expect(date.day).toBe(5);
  });

  it("accepts 29 February in a leap year", () => {
    expect(ServiceDate.fromParts(2024, 2, 29).toCompact()).toBe("20240229");
  });

  it("rejects 29 February in a common year", () => {
    expect(() => ServiceDate.fromParts(2023, 2, 29)).toThrow(TimeRangeError);
  });

  it("rejects non-integer parts", () => {
    expect(() => ServiceDate.fromParts(2023.5, 1, 1)).toThrow(/integers/);
  });

  it("rejects a year outside the representable range", () => {
    expect(() => ServiceDate.fromParts(MIN_YEAR - 1, 1, 1)).toThrow(/outside/);
    expect(() => ServiceDate.fromParts(MAX_YEAR + 1, 1, 1)).toThrow(/outside/);
  });

  it("rejects a month outside 1-12", () => {
    expect(() => ServiceDate.fromParts(2023, 0, 1)).toThrow(/month/);
    expect(() => ServiceDate.fromParts(2023, 13, 1)).toThrow(/month/);
  });

  it("rejects a day outside the month's length", () => {
    expect(() => ServiceDate.fromParts(2023, 4, 31)).toThrow(/day/);
    expect(() => ServiceDate.fromParts(2023, 4, 0)).toThrow(/day/);
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(ServiceDate.fromParts(2023, 1, 1))).toBe(true);
  });
});

describe("ServiceDate.parse", () => {
  it("reads the compact GTFS form", () => {
    expect(ServiceDate.parse("20230605").toISO()).toBe("2023-06-05");
  });

  it("rejects anything that is not eight digits", () => {
    for (const text of ["2023-06-05", "202306", "2023060X", " 20230605", ""]) {
      expect(() => ServiceDate.parse(text)).toThrow(TimeRangeError);
    }
  });

  it("rejects eight digits that do not name a real date", () => {
    expect(() => ServiceDate.parse("20230230")).toThrow(TimeRangeError);
  });
});

describe("ServiceDate.parseFlexible", () => {
  it("reads the hyphenated form", () => {
    expect(ServiceDate.parseFlexible("2023-06-05").toCompact()).toBe("20230605");
  });

  it("falls back to the compact form", () => {
    expect(ServiceDate.parseFlexible("20230605").toCompact()).toBe("20230605");
  });

  it("rejects a hyphenated form naming an impossible date", () => {
    expect(() => ServiceDate.parseFlexible("2023-02-30")).toThrow(TimeRangeError);
  });
});

describe("epoch day conversion", () => {
  it("maps the epoch itself to zero", () => {
    expect(ServiceDate.parse("19700101").toEpochDay()).toBe(0);
  });

  it("round-trips across a wide range", () => {
    for (const compact of ["19000101", "19701231", "20000229", "20230605", "21991231"]) {
      const date = ServiceDate.parse(compact);
      expect(ServiceDate.fromEpochDay(date.toEpochDay()).toCompact()).toBe(compact);
    }
  });

  it("handles dates before the epoch", () => {
    expect(ServiceDate.parse("19691231").toEpochDay()).toBe(-1);
  });

  it("rejects a non-integer epoch day", () => {
    expect(() => ServiceDate.fromEpochDay(1.5)).toThrow(/integer/);
  });

  it("rejects an epoch day outside the representable range", () => {
    expect(() => ServiceDate.fromEpochDay(-1_000_000)).toThrow(/representable/);
    expect(() => ServiceDate.fromEpochDay(1_000_000)).toThrow(/representable/);
  });
});

describe("weekday", () => {
  it("puts Monday first, matching the calendar.txt column order", () => {
    // 2023-06-05 was a Monday.
    expect(ServiceDate.parse("20230605").weekday()).toBe(Weekday.Monday);
    expect(ServiceDate.parse("20230611").weekday()).toBe(Weekday.Sunday);
  });

  it("agrees with the declared column names", () => {
    expect(WEEKDAY_FIELDS).toHaveLength(7);
    expect(WEEKDAY_FIELDS[Weekday.Monday]).toBe("monday");
    expect(WEEKDAY_FIELDS[Weekday.Sunday]).toBe("sunday");
  });

  it("stays correct before the epoch", () => {
    // 1969-12-31 was a Wednesday.
    expect(ServiceDate.parse("19691231").weekday()).toBe(Weekday.Wednesday);
  });
});

describe("date arithmetic", () => {
  it("adds days across a month boundary", () => {
    expect(ServiceDate.parse("20230630").addDays(1).toCompact()).toBe("20230701");
  });

  it("subtracts days across a year boundary", () => {
    expect(ServiceDate.parse("20230101").addDays(-1).toCompact()).toBe("20221231");
  });

  it("rejects a non-integer day offset", () => {
    expect(() => ServiceDate.parse("20230101").addDays(0.5)).toThrow(/integer/);
  });

  it("adds months, clamping the day to the target month's length", () => {
    expect(ServiceDate.parse("20230131").addMonths(1).toCompact()).toBe("20230228");
    expect(ServiceDate.parse("20240131").addMonths(1).toCompact()).toBe("20240229");
  });

  it("adds months backwards across a year boundary", () => {
    expect(ServiceDate.parse("20230115").addMonths(-2).toCompact()).toBe("20221115");
  });

  it("rejects a non-integer month offset", () => {
    expect(() => ServiceDate.parse("20230101").addMonths(1.5)).toThrow(/integer/);
  });

  it("measures the signed gap between two dates", () => {
    const start = ServiceDate.parse("20230601");
    const end = ServiceDate.parse("20230611");
    expect(start.daysUntil(end)).toBe(10);
    expect(end.daysUntil(start)).toBe(-10);
  });
});

describe("date comparison", () => {
  const early = ServiceDate.parse("20230601");
  const late = ServiceDate.parse("20230701");

  it("orders by calendar position", () => {
    expect(early.compare(late)).toBeLessThan(0);
    expect(late.compare(early)).toBeGreaterThan(0);
    expect(early.compare(ServiceDate.parse("20230601"))).toBe(0);
  });

  it("compares by value, not identity", () => {
    expect(early.equals(ServiceDate.parse("20230601"))).toBe(true);
    expect(early.equals(late)).toBe(false);
  });

  it("answers before and after", () => {
    expect(early.isBefore(late)).toBe(true);
    expect(early.isAfter(late)).toBe(false);
    expect(late.isAfter(early)).toBe(true);
  });

  it("treats range bounds as inclusive", () => {
    expect(early.isWithin(early, late)).toBe(true);
    expect(late.isWithin(early, late)).toBe(true);
    expect(ServiceDate.parse("20230501").isWithin(early, late)).toBe(false);
    expect(ServiceDate.parse("20230801").isWithin(early, late)).toBe(false);
  });

  it("selects the earlier and later of a pair", () => {
    expect(minDate(early, late)).toBe(early);
    expect(minDate(late, early)).toBe(early);
    expect(maxDate(early, late)).toBe(late);
    expect(maxDate(late, early)).toBe(late);
  });

  it("returns the first argument on a tie", () => {
    const other = ServiceDate.parse("20230601");
    expect(minDate(early, other)).toBe(early);
    expect(maxDate(early, other)).toBe(early);
  });
});

describe("rendering", () => {
  it("pads every component", () => {
    const date = ServiceDate.fromParts(2023, 1, 2);
    expect(date.toCompact()).toBe("20230102");
    expect(date.toISO()).toBe("2023-01-02");
    expect(String(date)).toBe("2023-01-02");
    expect(date.toJSON()).toBe("20230102");
  });

  it("serialises to the compact form inside JSON", () => {
    expect(JSON.stringify({ at: ServiceDate.parse("20230605") })).toBe('{"at":"20230605"}');
  });
});

describe("calendar helpers", () => {
  it("identifies leap years by the Gregorian rule", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("reports each month's length", () => {
    expect(daysInMonth(2023, 1)).toBe(31);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 4)).toBe(30);
  });

  it("rejects an out of range month", () => {
    expect(() => daysInMonth(2023, 0)).toThrow(TimeRangeError);
    expect(() => daysInMonth(2023, 13)).toThrow(TimeRangeError);
  });
});

describe("datesBetween", () => {
  it("includes both endpoints", () => {
    const dates = datesBetween(ServiceDate.parse("20230601"), ServiceDate.parse("20230603"));
    expect(dates.map((date) => date.toCompact())).toEqual(["20230601", "20230602", "20230603"]);
  });

  it("returns a single date when the endpoints coincide", () => {
    const only = ServiceDate.parse("20230601");
    expect(datesBetween(only, only)).toHaveLength(1);
  });

  it("rejects an inverted range", () => {
    expect(() =>
      datesBetween(ServiceDate.parse("20230603"), ServiceDate.parse("20230601")),
    ).toThrow(/precedes/);
  });
});
