import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import { SECONDS_PER_DAY, ServiceDate } from "../../src/time/date.js";
import { parseTimeOfDay } from "../../src/time/time-of-day.js";
import { ServiceCalendar } from "../../src/calendar/service-calendar.js";
import {
  DEFAULT_MAX_OVERHANG_DAYS,
  measureOverhangDays,
  scanServiceDays,
  scanServiceDaysForWindow,
  timeOnQueryDate,
  timeOnScan,
} from "../../src/calendar/window.js";
import {
  activeRuns,
  blankDates,
  describeWeekdays,
  longestBlankRun,
  profileAllServices,
  profileService,
  serviceCountByDate,
} from "../../src/calendar/expander.js";
import { ExceptionType, type CalendarEntry, type CalendarException } from "../../src/feed/calendar.js";

const date = (compact: string): ServiceDate => ServiceDate.parse(compact);

function entry(
  serviceId: string,
  days: readonly boolean[],
  start = "20230601",
  end = "20230831",
): CalendarEntry {
  return { serviceId, days, startDate: date(start), endDate: date(end), line: 1 };
}

function exception(serviceId: string, compact: string, type: ExceptionType): CalendarException {
  return { serviceId, date: date(compact), exceptionType: type, line: 1 };
}

const WEEKDAYS = [true, true, true, true, true, false, false];
const WEEKENDS = [false, false, false, false, false, true, true];

describe("ServiceCalendar.build", () => {
  it("resolves a weekly pattern", () => {
    const calendar = ServiceCalendar.build([entry("WEEKDAY", WEEKDAYS)], []);
    expect(calendar.isActive("WEEKDAY", date("20230605"))).toBe(true);
    expect(calendar.isActive("WEEKDAY", date("20230610"))).toBe(false);
  });

  it("respects the pattern's date range", () => {
    const calendar = ServiceCalendar.build([entry("S", WEEKDAYS, "20230605", "20230609")], []);
    expect(calendar.isActive("S", date("20230605"))).toBe(true);
    expect(calendar.isActive("S", date("20230612"))).toBe(false);
  });

  it("lets an addition override the pattern", () => {
    const calendar = ServiceCalendar.build(
      [entry("S", WEEKDAYS)],
      [exception("S", "20230610", ExceptionType.Added)],
    );
    expect(calendar.isActive("S", date("20230610"))).toBe(true);
  });

  it("lets a removal override the pattern", () => {
    const calendar = ServiceCalendar.build(
      [entry("S", WEEKDAYS)],
      [exception("S", "20230605", ExceptionType.Removed)],
    );
    expect(calendar.isActive("S", date("20230605"))).toBe(false);
  });

  it("honours an exception outside the pattern's range", () => {
    const calendar = ServiceCalendar.build(
      [entry("S", WEEKDAYS, "20230601", "20230630")],
      [exception("S", "20231225", ExceptionType.Added)],
    );
    expect(calendar.isActive("S", date("20231225"))).toBe(true);
  });

  it("supports a service defined only by exceptions", () => {
    const calendar = ServiceCalendar.build([], [exception("S", "20230605", ExceptionType.Added)]);
    expect(calendar.has("S")).toBe(true);
    expect(calendar.isActive("S", date("20230605"))).toBe(true);
    expect(calendar.isActive("S", date("20230606"))).toBe(false);
  });

  it("reports an unknown service as never active", () => {
    const calendar = ServiceCalendar.build([entry("S", WEEKDAYS)], []);
    expect(calendar.has("OTHER")).toBe(false);
    expect(calendar.isActive("OTHER", date("20230605"))).toBe(false);
  });

  it("keeps the first of two entries for one service", () => {
    const calendar = ServiceCalendar.build(
      [entry("S", WEEKDAYS), entry("S", WEEKENDS)],
      [],
    );
    expect(calendar.isActive("S", date("20230605"))).toBe(true);
    expect(calendar.isActive("S", date("20230610"))).toBe(false);
  });

  it("keeps the first of two exceptions for one service and date", () => {
    const calendar = ServiceCalendar.build(
      [],
      [
        exception("S", "20230605", ExceptionType.Added),
        exception("S", "20230605", ExceptionType.Removed),
      ],
    );
    expect(calendar.isActive("S", date("20230605"))).toBe(true);
  });

  it("lists service ids sorted", () => {
    const calendar = ServiceCalendar.build(
      [entry("Z", WEEKDAYS), entry("A", WEEKENDS)],
      [exception("M", "20230605", ExceptionType.Added)],
    );
    expect(calendar.serviceIds()).toEqual(["A", "M", "Z"]);
  });

  it("provides an empty calendar", () => {
    const calendar = ServiceCalendar.empty();
    expect(calendar.serviceIds()).toEqual([]);
    expect(calendar.coverage()).toBeUndefined();
    expect(calendar.isActive("S", date("20230605"))).toBe(false);
    expect(calendar.activeServiceIds(date("20230605"))).toEqual([]);
  });
});

describe("coverage", () => {
  it("spans every pattern range and exception date", () => {
    const calendar = ServiceCalendar.build(
      [entry("A", WEEKDAYS, "20230601", "20230630")],
      [exception("B", "20230501", ExceptionType.Added), exception("B", "20230801", ExceptionType.Added)],
    );
    expect(calendar.coverage()?.start.toCompact()).toBe("20230501");
    expect(calendar.coverage()?.end.toCompact()).toBe("20230801");
  });

  it("is undefined with no calendars or exceptions", () => {
    expect(ServiceCalendar.build([], []).coverage()).toBeUndefined();
  });

  it("spans exception dates alone", () => {
    const calendar = ServiceCalendar.build([], [exception("S", "20230605", ExceptionType.Added)]);
    expect(calendar.coverage()?.start.toCompact()).toBe("20230605");
  });
});

describe("active queries", () => {
  const calendar = ServiceCalendar.build(
    [entry("WEEKDAY", WEEKDAYS), entry("WEEKEND", WEEKENDS)],
    [exception("WEEKDAY", "20230612", ExceptionType.Removed)],
  );

  it("lists active services for a date, sorted", () => {
    expect(calendar.activeServiceIds(date("20230605"))).toEqual(["WEEKDAY"]);
    expect(calendar.activeServiceIds(date("20230610"))).toEqual(["WEEKEND"]);
  });

  it("caches the answer for a repeated date", () => {
    const first = calendar.activeServiceIds(date("20230605"));
    expect(calendar.activeServiceIds(date("20230605"))).toBe(first);
  });

  it("reports a date with no service at all", () => {
    expect(calendar.isBlankDate(date("20230612"))).toBe(true);
    expect(calendar.isBlankDate(date("20230605"))).toBe(false);
  });

  it("lists active dates in a range", () => {
    const dates = calendar.activeDates("WEEKDAY", date("20230605"), date("20230611"));
    expect(dates.map((value) => value.toCompact())).toEqual([
      "20230605",
      "20230606",
      "20230607",
      "20230608",
      "20230609",
    ]);
  });

  it("counts active dates", () => {
    expect(calendar.countActiveDates("WEEKEND", date("20230601"), date("20230630"))).toBe(8);
  });

  it("returns nothing for an unknown service", () => {
    expect(calendar.activeDates("NOPE", date("20230601"), date("20230630"))).toEqual([]);
  });

  it("reports the first and last active date", () => {
    expect(calendar.firstActiveDate("WEEKDAY")?.toCompact()).toBe("20230601");
    expect(calendar.lastActiveDate("WEEKDAY")?.toCompact()).toBe("20230831");
  });

  it("reports no first or last date for an empty calendar", () => {
    const empty = ServiceCalendar.empty();
    expect(empty.firstActiveDate("S")).toBeUndefined();
    expect(empty.lastActiveDate("S")).toBeUndefined();
  });

  it("names services that are never active", () => {
    const withDead = ServiceCalendar.build(
      [entry("LIVE", WEEKDAYS, "20230605", "20230609"), entry("DEAD", WEEKDAYS, "20230610", "20230611")],
      [],
    );
    expect(withDead.neverActiveServiceIds()).toEqual(["DEAD"]);
  });
});

describe("scanServiceDays", () => {
  it("includes the query date and the days before it", () => {
    const scans = scanServiceDays(date("20230605"), 2);
    expect(scans.map((scan) => scan.date.toCompact())).toEqual(["20230605", "20230604", "20230603"]);
    expect(scans.map((scan) => scan.offsetSeconds)).toEqual([0, SECONDS_PER_DAY, 2 * SECONDS_PER_DAY]);
  });

  it("returns only the query date with no overhang", () => {
    expect(scanServiceDays(date("20230605"), 0)).toHaveLength(1);
  });

  it("uses a documented default overhang", () => {
    expect(scanServiceDays(date("20230605"))).toHaveLength(DEFAULT_MAX_OVERHANG_DAYS + 1);
  });

  it("rejects a negative or non-integer overhang", () => {
    expect(() => scanServiceDays(date("20230605"), -1)).toThrow(TimeRangeError);
    expect(() => scanServiceDays(date("20230605"), 1.5)).toThrow(TimeRangeError);
  });
});

describe("scanServiceDaysForWindow", () => {
  it("includes days a window reaches forward into", () => {
    const scans = scanServiceDaysForWindow(date("20230605"), parseTimeOfDay("23:00:00"), 3 * 3600, 1);
    expect(scans.map((scan) => scan.dayShift)).toEqual([-1, 0, 1]);
    expect(scans[0]?.date.toCompact()).toBe("20230606");
  });

  it("stays on the query date for a window inside one day", () => {
    const scans = scanServiceDaysForWindow(date("20230605"), parseTimeOfDay("08:00:00"), 3600, 0);
    expect(scans.map((scan) => scan.dayShift)).toEqual([0]);
  });

  it("rejects a negative or non-integer window", () => {
    expect(() =>
      scanServiceDaysForWindow(date("20230605"), parseTimeOfDay("08:00:00"), -1),
    ).toThrow(TimeRangeError);
    expect(() =>
      scanServiceDaysForWindow(date("20230605"), parseTimeOfDay("08:00:00"), 1.5),
    ).toThrow(TimeRangeError);
  });
});

describe("scan time conversion", () => {
  const scans = scanServiceDays(date("20230605"), 1);

  it("translates a query time onto an earlier anchor", () => {
    expect(timeOnScan(scans[0] as never, parseTimeOfDay("00:10:00"))).toBe(600);
    expect(timeOnScan(scans[1] as never, parseTimeOfDay("00:10:00"))).toBe(SECONDS_PER_DAY + 600);
  });

  it("returns undefined when the translation leaves the range", () => {
    expect(timeOnScan(scans[1] as never, parseTimeOfDay("160:00:00"))).toBeUndefined();
  });

  it("translates back onto the query date's clock", () => {
    expect(timeOnQueryDate(scans[1] as never, parseTimeOfDay("24:10:00"))).toBe(600);
    expect(timeOnQueryDate(scans[0] as never, parseTimeOfDay("08:00:00"))).toBe(8 * 3600);
  });
});

describe("measureOverhangDays", () => {
  it("reports zero for times inside one day", () => {
    expect(measureOverhangDays([parseTimeOfDay("23:59:59")])).toBe(0);
  });

  it("reports the largest overhang", () => {
    expect(
      measureOverhangDays([parseTimeOfDay("23:00:00"), parseTimeOfDay("25:00:00"), parseTimeOfDay("49:00:00")]),
    ).toBe(2);
  });

  it("reports zero for no times at all", () => {
    expect(measureOverhangDays([])).toBe(0);
  });
});

describe("expander", () => {
  const calendar = ServiceCalendar.build(
    [entry("WEEKDAY", WEEKDAYS, "20230605", "20230623"), entry("WEEKEND", WEEKENDS, "20230605", "20230623")],
    [],
  );

  it("collapses active dates into contiguous runs", () => {
    const runs = activeRuns(calendar, "WEEKDAY", date("20230605"), date("20230618"));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.days).toBe(5);
    expect(runs[0]?.start.toCompact()).toBe("20230605");
    expect(runs[1]?.start.toCompact()).toBe("20230612");
  });

  it("returns no runs for a service that never runs", () => {
    expect(activeRuns(calendar, "NOPE", date("20230605"), date("20230618"))).toEqual([]);
  });

  it("returns a single run for a service active throughout", () => {
    const daily = ServiceCalendar.build([entry("D", [true, true, true, true, true, true, true])], []);
    expect(activeRuns(daily, "D", date("20230605"), date("20230611"))).toHaveLength(1);
  });

  it("profiles a service", () => {
    const profile = profileService(calendar, "WEEKDAY", date("20230605"), date("20230618"));
    expect(profile.activeDays).toBe(10);
    expect(profile.byWeekday[5]).toBe(0);
    expect(profile.firstActive?.toCompact()).toBe("20230605");
    expect(profile.lastActive?.toCompact()).toBe("20230616");
  });

  it("profiles every service", () => {
    const profiles = profileAllServices(calendar, date("20230605"), date("20230611"));
    expect(profiles.map((profile) => profile.serviceId)).toEqual(["WEEKDAY", "WEEKEND"]);
  });

  it("describes which weekdays a profile covers", () => {
    expect(describeWeekdays(profileService(calendar, "WEEKDAY", date("20230605"), date("20230618")))).toBe(
      "weekdays",
    );
    expect(describeWeekdays(profileService(calendar, "WEEKEND", date("20230605"), date("20230618")))).toBe(
      "Sat Sun",
    );
    expect(describeWeekdays(profileService(calendar, "NOPE", date("20230605"), date("20230618")))).toBe(
      "never",
    );
  });

  it("describes a daily service as daily", () => {
    const daily = ServiceCalendar.build([entry("D", [true, true, true, true, true, true, true])], []);
    expect(describeWeekdays(profileService(daily, "D", date("20230605"), date("20230611")))).toBe("daily");
  });

  it("finds dates with no service at all", () => {
    const weekdaysOnly = ServiceCalendar.build([entry("W", WEEKDAYS, "20230605", "20230611")], []);
    const blanks = blankDates(weekdaysOnly, date("20230605"), date("20230611"));
    expect(blanks.map((value) => value.toCompact())).toEqual(["20230610", "20230611"]);
  });

  it("finds the longest blank run, keeping the first of equal-length runs", () => {
    const weekdaysOnly = ServiceCalendar.build([entry("W", WEEKDAYS, "20230605", "20230616")], []);
    const longest = longestBlankRun(weekdaysOnly, date("20230605"), date("20230618"));
    expect(longest?.days).toBe(2);
    expect(longest?.start.toCompact()).toBe("20230610");
  });

  it("prefers a strictly longer blank run", () => {
    const sparse = ServiceCalendar.build(
      [],
      [
        exception("S", "20230605", ExceptionType.Added),
        exception("S", "20230612", ExceptionType.Added),
      ],
    );
    const longest = longestBlankRun(sparse, date("20230605"), date("20230612"));
    expect(longest?.days).toBe(6);
    expect(longest?.start.toCompact()).toBe("20230606");
  });

  it("reports no blank run when service is daily", () => {
    const daily = ServiceCalendar.build([entry("D", [true, true, true, true, true, true, true])], []);
    expect(longestBlankRun(daily, date("20230605"), date("20230611"))).toBeUndefined();
  });

  it("counts services per date", () => {
    const counts = serviceCountByDate(calendar, date("20230605"), date("20230611"));
    expect(counts).toHaveLength(7);
    expect(counts[0]?.services).toBe(1);
    expect(counts[5]?.services).toBe(1);
  });
});
