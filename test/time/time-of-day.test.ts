import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import { SECONDS_PER_DAY } from "../../src/time/date.js";
import {
  MAX_TIME_OF_DAY,
  START_OF_SERVICE_DAY,
  compareTimeOfDay,
  dayOffsetOf,
  formatClockTime,
  formatTimeOfDay,
  maxTimeOfDay,
  minTimeOfDay,
  parseTimeOfDay,
  reanchorTimeOfDay,
  shiftTimeOfDay,
  timeOfDay,
  withinDay,
} from "../../src/time/time-of-day.js";

describe("parseTimeOfDay", () => {
  it("reads a two digit hour", () => {
    expect(parseTimeOfDay("08:30:00")).toBe(8 * 3600 + 30 * 60);
  });

  it("reads a one digit hour", () => {
    expect(parseTimeOfDay("8:30:00")).toBe(8 * 3600 + 30 * 60);
  });

  it("reads hours past 24, which GTFS uses for trips running past midnight", () => {
    expect(parseTimeOfDay("25:30:00")).toBe(25 * 3600 + 30 * 60);
  });

  it("reads the start of the service day", () => {
    expect(parseTimeOfDay("00:00:00")).toBe(START_OF_SERVICE_DAY);
  });

  it("rejects a malformed time", () => {
    for (const text of ["8:30", "08:30:00.5", "08-30-00", "", "abc", "08:5:00"]) {
      expect(() => parseTimeOfDay(text)).toThrow(TimeRangeError);
    }
  });

  it("rejects a minute or second of 60 rather than normalising it", () => {
    expect(() => parseTimeOfDay("08:60:00")).toThrow(TimeRangeError);
    expect(() => parseTimeOfDay("08:30:60")).toThrow(TimeRangeError);
  });

  it("rejects a time past the seven day limit", () => {
    expect(() => parseTimeOfDay("169:00:00")).toThrow(/7 day/);
  });
});

describe("timeOfDay", () => {
  it("wraps a valid second count", () => {
    expect(timeOfDay(0)).toBe(0);
    expect(timeOfDay(MAX_TIME_OF_DAY)).toBe(MAX_TIME_OF_DAY);
  });

  it("rejects a non-integer", () => {
    expect(() => timeOfDay(1.5)).toThrow(/integer/);
  });

  it("rejects a negative value", () => {
    expect(() => timeOfDay(-1)).toThrow(/negative/);
  });

  it("rejects a value past the limit", () => {
    expect(() => timeOfDay(MAX_TIME_OF_DAY + 1)).toThrow(/7 day/);
  });
});

describe("formatting", () => {
  it("renders the GTFS form without wrapping past 24", () => {
    expect(formatTimeOfDay(parseTimeOfDay("25:30:00"))).toBe("25:30:00");
    expect(formatTimeOfDay(parseTimeOfDay("8:05:09"))).toBe("08:05:09");
  });

  it("round-trips through the GTFS form", () => {
    for (const text of ["00:00:00", "08:30:15", "23:59:59", "24:00:00", "48:15:00"]) {
      expect(formatTimeOfDay(parseTimeOfDay(text))).toBe(text);
    }
  });

  it("renders a passenger-facing clock time with a day marker", () => {
    expect(formatClockTime(parseTimeOfDay("08:30:00"))).toBe("08:30");
    expect(formatClockTime(parseTimeOfDay("25:30:00"))).toBe("01:30 (+1d)");
    expect(formatClockTime(parseTimeOfDay("49:05:00"))).toBe("01:05 (+2d)");
  });
});

describe("day arithmetic", () => {
  it("reports how many days a time rolls past its anchor", () => {
    expect(dayOffsetOf(parseTimeOfDay("23:59:59"))).toBe(0);
    expect(dayOffsetOf(parseTimeOfDay("24:00:00"))).toBe(1);
    expect(dayOffsetOf(parseTimeOfDay("48:00:00"))).toBe(2);
  });

  it("reduces a time into a single day", () => {
    expect(withinDay(parseTimeOfDay("25:30:00"))).toBe(90 * 60);
    expect(withinDay(parseTimeOfDay("08:30:00"))).toBe(8 * 3600 + 30 * 60);
  });
});

describe("shiftTimeOfDay", () => {
  it("moves a time forwards and backwards", () => {
    const base = parseTimeOfDay("08:00:00");
    expect(shiftTimeOfDay(base, 600)).toBe(8 * 3600 + 600);
    expect(shiftTimeOfDay(base, -600)).toBe(8 * 3600 - 600);
  });

  it("rejects a non-integer shift", () => {
    expect(() => shiftTimeOfDay(parseTimeOfDay("08:00:00"), 1.5)).toThrow(/integer/);
  });

  it("rejects a shift that leaves the representable range", () => {
    expect(() => shiftTimeOfDay(parseTimeOfDay("00:00:00"), -1)).toThrow(TimeRangeError);
  });
});

describe("reanchorTimeOfDay", () => {
  it("re-expresses a time on a later anchor", () => {
    expect(reanchorTimeOfDay(parseTimeOfDay("24:10:00"), -1)).toBe(10 * 60);
  });

  it("re-expresses a time on an earlier anchor", () => {
    expect(reanchorTimeOfDay(parseTimeOfDay("00:10:00"), 1)).toBe(SECONDS_PER_DAY + 600);
  });

  it("returns undefined when the result would precede its new anchor", () => {
    expect(reanchorTimeOfDay(parseTimeOfDay("00:10:00"), -1)).toBeUndefined();
  });

  it("returns undefined when the result would exceed the limit", () => {
    expect(reanchorTimeOfDay(parseTimeOfDay("120:00:00"), 3)).toBeUndefined();
  });
});

describe("ordering", () => {
  const early = parseTimeOfDay("08:00:00");
  const late = parseTimeOfDay("09:00:00");

  it("compares numerically", () => {
    expect(compareTimeOfDay(early, late)).toBeLessThan(0);
    expect(compareTimeOfDay(late, early)).toBeGreaterThan(0);
    expect(compareTimeOfDay(early, early)).toBe(0);
  });

  it("selects the earlier and later of a pair", () => {
    expect(minTimeOfDay(early, late)).toBe(early);
    expect(minTimeOfDay(late, early)).toBe(early);
    expect(maxTimeOfDay(early, late)).toBe(late);
    expect(maxTimeOfDay(late, early)).toBe(late);
  });

  it("orders a past-midnight time after an evening one", () => {
    expect(compareTimeOfDay(parseTimeOfDay("23:50:00"), parseTimeOfDay("24:10:00"))).toBeLessThan(0);
  });
});
