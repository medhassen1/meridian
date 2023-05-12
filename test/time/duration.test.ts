import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import {
  MAX_DURATION,
  ZERO_DURATION,
  addDurations,
  duration,
  formatDuration,
  formatDurationClock,
  hours,
  maxDuration,
  minDuration,
  minutes,
  parseDuration,
  scaleDuration,
  subtractDurations,
} from "../../src/time/duration.js";

describe("duration", () => {
  it("wraps a valid second count", () => {
    expect(duration(0)).toBe(ZERO_DURATION);
    expect(duration(MAX_DURATION)).toBe(MAX_DURATION);
  });

  it("rejects a non-integer", () => {
    expect(() => duration(1.5)).toThrow(/integer/);
  });

  it("rejects a negative value", () => {
    expect(() => duration(-1)).toThrow(/negative/);
  });

  it("rejects a value past the 30 day limit", () => {
    expect(() => duration(MAX_DURATION + 1)).toThrow(/30 day/);
  });
});

describe("unit constructors", () => {
  it("builds from minutes", () => {
    expect(minutes(90)).toBe(5400);
  });

  it("builds from hours", () => {
    expect(hours(2)).toBe(7200);
  });

  it("rejects non-integer units", () => {
    expect(() => minutes(1.5)).toThrow(/integer/);
    expect(() => hours(1.5)).toThrow(/integer/);
  });
});

describe("arithmetic", () => {
  it("adds", () => {
    expect(addDurations(duration(60), duration(30))).toBe(90);
  });

  it("subtracts, saturating at zero", () => {
    expect(subtractDurations(duration(90), duration(30))).toBe(60);
    expect(subtractDurations(duration(30), duration(90))).toBe(0);
  });

  it("scales, rounding to the nearest second", () => {
    expect(scaleDuration(duration(100), 1.5)).toBe(150);
    expect(scaleDuration(duration(100), 0)).toBe(0);
    expect(scaleDuration(duration(10), 0.25)).toBe(3);
  });

  it("rejects a negative or non-finite scale factor", () => {
    expect(() => scaleDuration(duration(10), -1)).toThrow(/non-negative/);
    expect(() => scaleDuration(duration(10), Number.NaN)).toThrow(/finite/);
  });

  it("rejects an addition that overflows the limit", () => {
    expect(() => addDurations(duration(MAX_DURATION), duration(1))).toThrow(TimeRangeError);
  });

  it("selects the shorter and longer of a pair", () => {
    const short = duration(60);
    const long = duration(120);
    expect(minDuration(short, long)).toBe(short);
    expect(minDuration(long, short)).toBe(short);
    expect(maxDuration(short, long)).toBe(long);
    expect(maxDuration(long, short)).toBe(long);
  });
});

describe("formatDuration", () => {
  it("renders zero explicitly", () => {
    expect(formatDuration(ZERO_DURATION)).toBe("0s");
  });

  it("drops leading units that are zero", () => {
    expect(formatDuration(duration(45))).toBe("45s");
    expect(formatDuration(duration(600))).toBe("10m");
    expect(formatDuration(duration(3600))).toBe("1h");
  });

  it("pads a minor unit that follows a major one", () => {
    expect(formatDuration(duration(3660))).toBe("1h 01m");
    expect(formatDuration(duration(3661))).toBe("1h 01m 01s");
    expect(formatDuration(duration(90))).toBe("1m 30s");
  });

  it("keeps hours past 24", () => {
    expect(formatDuration(duration(25 * 3600))).toBe("25h");
  });
});

describe("formatDurationClock", () => {
  it("renders a fixed width form", () => {
    expect(formatDurationClock(duration(0))).toBe("00:00:00");
    expect(formatDurationClock(duration(3661))).toBe("01:01:01");
  });

  it("does not cap hours at 24", () => {
    expect(formatDurationClock(duration(30 * 3600))).toBe("30:00:00");
  });
});

describe("parseDuration", () => {
  it("reads a bare integer as seconds", () => {
    expect(parseDuration("900")).toBe(900);
  });

  it("reads the compact unit form", () => {
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("1h 30m")).toBe(5400);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h 2m 3s")).toBe(3723);
  });

  it("round-trips the formatter's output", () => {
    for (const seconds of [0, 45, 90, 600, 3600, 3661]) {
      expect(parseDuration(formatDuration(duration(seconds)))).toBe(seconds);
    }
  });

  it("rejects empty text", () => {
    expect(() => parseDuration("")).toThrow(/empty/);
    expect(() => parseDuration("   ")).toThrow(/empty/);
  });

  it("rejects an unrecognised form", () => {
    for (const text of ["1d", "h", "1x", "-5", "1:30"]) {
      expect(() => parseDuration(text)).toThrow(TimeRangeError);
    }
  });
});
