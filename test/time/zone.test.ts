import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import { SECONDS_PER_DAY, ServiceDate } from "../../src/time/date.js";
import { parseTimeOfDay } from "../../src/time/time-of-day.js";
import {
  MAX_UTC_OFFSET,
  UTC,
  fixedOffsetZone,
  formatUtcOffset,
  fromEpochSeconds,
  offsetTableZone,
  parseUtcOffset,
  toEpochSeconds,
} from "../../src/time/zone.js";

const date = (compact: string): ServiceDate => ServiceDate.parse(compact);

describe("fixedOffsetZone", () => {
  it("reports the same offset on every date", () => {
    const zone = fixedOffsetZone("Etc/GMT-2", 7200);
    expect(zone.id).toBe("Etc/GMT-2");
    expect(zone.offsetSecondsFor(date("20230101"))).toBe(7200);
    expect(zone.offsetSecondsFor(date("20230701"))).toBe(7200);
  });

  it("rejects a non-integer offset", () => {
    expect(() => fixedOffsetZone("bad", 1.5)).toThrow(/integer/);
  });

  it("rejects an offset beyond ±14 hours", () => {
    expect(() => fixedOffsetZone("bad", MAX_UTC_OFFSET + 1)).toThrow(/14 hours/);
    expect(() => fixedOffsetZone("bad", -MAX_UTC_OFFSET - 1)).toThrow(/14 hours/);
  });

  it("provides UTC itself", () => {
    expect(UTC.id).toBe("UTC");
    expect(UTC.offsetSecondsFor(date("20230605"))).toBe(0);
  });
});

describe("offsetTableZone", () => {
  const zone = offsetTableZone("Europe/Test", [
    { from: date("20231029"), offsetSeconds: 0 },
    { from: date("20230326"), offsetSeconds: 3600 },
  ]);

  it("sorts its transitions regardless of input order", () => {
    expect(zone.offsetSecondsFor(date("20230601"))).toBe(3600);
    expect(zone.offsetSecondsFor(date("20231101"))).toBe(0);
  });

  it("applies the earliest transition to every earlier date", () => {
    expect(zone.offsetSecondsFor(date("20230101"))).toBe(3600);
  });

  it("applies a transition from its own effective date", () => {
    expect(zone.offsetSecondsFor(date("20231028"))).toBe(3600);
    expect(zone.offsetSecondsFor(date("20231029"))).toBe(0);
  });

  it("rejects an empty table", () => {
    expect(() => offsetTableZone("bad", [])).toThrow(/at least one/);
  });

  it("rejects two transitions on the same date", () => {
    expect(() =>
      offsetTableZone("bad", [
        { from: date("20230101"), offsetSeconds: 0 },
        { from: date("20230101"), offsetSeconds: 3600 },
      ]),
    ).toThrow(/two transitions/);
  });

  it("rejects an out of range offset in the table", () => {
    expect(() =>
      offsetTableZone("bad", [{ from: date("20230101"), offsetSeconds: MAX_UTC_OFFSET + 1 }]),
    ).toThrow(TimeRangeError);
  });

  it("searches a long table correctly", () => {
    const transitions = Array.from({ length: 20 }, (_, index) => ({
      from: ServiceDate.parse("20000101").addDays(index * 180),
      offsetSeconds: index * 60,
    }));
    const long = offsetTableZone("Long", transitions);
    expect(long.offsetSecondsFor(ServiceDate.parse("20000101").addDays(180 * 10))).toBe(600);
    expect(long.offsetSecondsFor(ServiceDate.parse("20000101").addDays(180 * 10 - 1))).toBe(540);
  });
});

describe("toEpochSeconds", () => {
  it("converts midnight UTC on the epoch to zero", () => {
    expect(toEpochSeconds(date("19700101"), parseTimeOfDay("00:00:00"), UTC)).toBe(0);
  });

  it("subtracts an eastward offset", () => {
    const zone = fixedOffsetZone("Test", 7200);
    expect(toEpochSeconds(date("19700101"), parseTimeOfDay("02:00:00"), zone)).toBe(0);
  });

  it("keeps the anchor date's offset for a past-midnight time", () => {
    const zone = offsetTableZone("Test", [
      { from: date("20230101"), offsetSeconds: 3600 },
      { from: date("20230606"), offsetSeconds: 7200 },
    ]);
    // 24:30 on 5 June is anchored to 5 June, so it keeps that day's +01:00.
    const anchored = toEpochSeconds(date("20230605"), parseTimeOfDay("24:30:00"), zone);
    const nextDay = toEpochSeconds(date("20230606"), parseTimeOfDay("00:30:00"), zone);
    expect(anchored).toBe(nextDay + 3600);
  });
});

describe("fromEpochSeconds", () => {
  it("inverts toEpochSeconds for a fixed zone", () => {
    const zone = fixedOffsetZone("Test", -5 * 3600);
    const epoch = toEpochSeconds(date("20230605"), parseTimeOfDay("08:30:00"), zone);
    const back = fromEpochSeconds(epoch, zone);
    expect(back.date.toCompact()).toBe("20230605");
    expect(back.secondsOfDay).toBe(8 * 3600 + 30 * 60);
  });

  it("reduces a past-midnight time into the following day", () => {
    const epoch = toEpochSeconds(date("20230605"), parseTimeOfDay("25:30:00"), UTC);
    const back = fromEpochSeconds(epoch, UTC);
    expect(back.date.toCompact()).toBe("20230606");
    expect(back.secondsOfDay).toBe(90 * 60);
  });

  it("handles instants before the epoch", () => {
    const back = fromEpochSeconds(-SECONDS_PER_DAY, UTC);
    expect(back.date.toCompact()).toBe("19691231");
    expect(back.secondsOfDay).toBe(0);
  });

  it("rejects a non-integer instant", () => {
    expect(() => fromEpochSeconds(1.5, UTC)).toThrow(/integer/);
  });

  it("re-reads the offset for the resolved local date", () => {
    const zone = offsetTableZone("Test", [
      { from: date("20230101"), offsetSeconds: 0 },
      { from: date("20230605"), offsetSeconds: 3600 },
    ]);
    const epoch = toEpochSeconds(date("20230605"), parseTimeOfDay("12:00:00"), zone);
    expect(fromEpochSeconds(epoch, zone).secondsOfDay).toBe(12 * 3600);
  });
});

describe("parseUtcOffset", () => {
  it("reads the colon form", () => {
    expect(parseUtcOffset("+02:00")).toBe(7200);
    expect(parseUtcOffset("-05:30")).toBe(-(5 * 3600 + 30 * 60));
  });

  it("reads the compact form", () => {
    expect(parseUtcOffset("+0200")).toBe(7200);
  });

  it("reads Z as UTC", () => {
    expect(parseUtcOffset("Z")).toBe(0);
    expect(parseUtcOffset("z")).toBe(0);
  });

  it("rejects a malformed offset", () => {
    for (const text of ["02:00", "+2:00", "", "UTC", "+02:0"]) {
      expect(() => parseUtcOffset(text)).toThrow(TimeRangeError);
    }
  });

  it("rejects an out of range minute component", () => {
    expect(() => parseUtcOffset("+02:60")).toThrow(/minute/);
  });

  it("rejects an offset beyond ±14 hours", () => {
    expect(() => parseUtcOffset("+15:00")).toThrow(/14 hours/);
  });
});

describe("formatUtcOffset", () => {
  it("renders both signs", () => {
    expect(formatUtcOffset(7200)).toBe("+02:00");
    expect(formatUtcOffset(-(5 * 3600 + 30 * 60))).toBe("-05:30");
  });

  it("renders UTC with a plus", () => {
    expect(formatUtcOffset(0)).toBe("+00:00");
  });

  it("round-trips through the parser", () => {
    for (const seconds of [0, 3600, -3600, 5 * 3600 + 45 * 60, -(9 * 3600 + 30 * 60)]) {
      expect(parseUtcOffset(formatUtcOffset(seconds))).toBe(seconds);
    }
  });
});
