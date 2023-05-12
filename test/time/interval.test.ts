import { describe, expect, it } from "vitest";

import { TimeRangeError } from "../../src/errors.js";
import { parseTimeOfDay, type TimeOfDay } from "../../src/time/time-of-day.js";
import {
  compareIntervals,
  formatInterval,
  hullOfIntervals,
  intersectIntervals,
  interval,
  intervalContains,
  intervalGaps,
  intervalLength,
  intervalsOverlap,
  isEmptyInterval,
  mergeIntervals,
  subtractInterval,
} from "../../src/time/interval.js";

const at = (text: string): TimeOfDay => parseTimeOfDay(text);
const span = (from: string, to: string) => interval(at(from), at(to));

describe("interval", () => {
  it("builds a half-open range", () => {
    const value = span("08:00:00", "09:00:00");
    expect(value.start).toBe(8 * 3600);
    expect(value.end).toBe(9 * 3600);
  });

  it("permits an empty range", () => {
    expect(isEmptyInterval(span("08:00:00", "08:00:00"))).toBe(true);
  });

  it("rejects an inverted range", () => {
    expect(() => span("09:00:00", "08:00:00")).toThrow(TimeRangeError);
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(span("08:00:00", "09:00:00"))).toBe(true);
  });
});

describe("membership", () => {
  const window = span("08:00:00", "09:00:00");

  it("includes its start and excludes its end", () => {
    expect(intervalContains(window, at("08:00:00"))).toBe(true);
    expect(intervalContains(window, at("08:59:59"))).toBe(true);
    expect(intervalContains(window, at("09:00:00"))).toBe(false);
    expect(intervalContains(window, at("07:59:59"))).toBe(false);
  });

  it("measures its length", () => {
    expect(intervalLength(window)).toBe(3600);
    expect(intervalLength(span("08:00:00", "08:00:00"))).toBe(0);
  });
});

describe("overlap", () => {
  it("finds a shared span", () => {
    expect(intervalsOverlap(span("08:00:00", "09:00:00"), span("08:30:00", "09:30:00"))).toBe(true);
  });

  it("treats touching intervals as disjoint", () => {
    expect(intervalsOverlap(span("08:00:00", "09:00:00"), span("09:00:00", "10:00:00"))).toBe(false);
  });

  it("treats separated intervals as disjoint", () => {
    expect(intervalsOverlap(span("08:00:00", "09:00:00"), span("10:00:00", "11:00:00"))).toBe(false);
  });

  it("intersects overlapping intervals", () => {
    const shared = intersectIntervals(span("08:00:00", "09:00:00"), span("08:30:00", "09:30:00"));
    expect(shared).toEqual(span("08:30:00", "09:00:00"));
  });

  it("returns undefined when intersecting disjoint intervals", () => {
    expect(intersectIntervals(span("08:00:00", "09:00:00"), span("09:00:00", "10:00:00"))).toBeUndefined();
  });

  it("takes the convex hull, gap included", () => {
    expect(hullOfIntervals(span("08:00:00", "09:00:00"), span("10:00:00", "11:00:00"))).toEqual(
      span("08:00:00", "11:00:00"),
    );
    expect(hullOfIntervals(span("10:00:00", "11:00:00"), span("08:00:00", "09:00:00"))).toEqual(
      span("08:00:00", "11:00:00"),
    );
  });
});

describe("mergeIntervals", () => {
  it("joins overlapping intervals", () => {
    expect(mergeIntervals([span("08:00:00", "09:00:00"), span("08:30:00", "10:00:00")])).toEqual([
      span("08:00:00", "10:00:00"),
    ]);
  });

  it("joins touching intervals", () => {
    expect(mergeIntervals([span("08:00:00", "09:00:00"), span("09:00:00", "10:00:00")])).toEqual([
      span("08:00:00", "10:00:00"),
    ]);
  });

  it("keeps separated intervals apart, in ascending order", () => {
    expect(mergeIntervals([span("10:00:00", "11:00:00"), span("08:00:00", "09:00:00")])).toEqual([
      span("08:00:00", "09:00:00"),
      span("10:00:00", "11:00:00"),
    ]);
  });

  it("absorbs an interval nested inside another", () => {
    expect(mergeIntervals([span("08:00:00", "12:00:00"), span("09:00:00", "10:00:00")])).toEqual([
      span("08:00:00", "12:00:00"),
    ]);
  });

  it("drops empty intervals", () => {
    expect(mergeIntervals([span("08:00:00", "08:00:00")])).toEqual([]);
  });

  it("returns nothing for no input", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it("does not modify its input", () => {
    const input = [span("10:00:00", "11:00:00"), span("08:00:00", "09:00:00")];
    const copy = input.slice();
    mergeIntervals(input);
    expect(input).toEqual(copy);
  });

  it("produces the same result for any input ordering", () => {
    const parts = [span("08:00:00", "09:00:00"), span("12:00:00", "13:00:00"), span("08:30:00", "10:00:00")];
    const forwards = mergeIntervals(parts);
    const backwards = mergeIntervals(parts.slice().reverse());
    expect(forwards).toEqual(backwards);
  });
});

describe("subtractInterval", () => {
  it("splits an interval cut through its middle", () => {
    expect(subtractInterval(span("08:00:00", "12:00:00"), span("09:00:00", "10:00:00"))).toEqual([
      span("08:00:00", "09:00:00"),
      span("10:00:00", "12:00:00"),
    ]);
  });

  it("trims a leading cut", () => {
    expect(subtractInterval(span("08:00:00", "12:00:00"), span("07:00:00", "09:00:00"))).toEqual([
      span("09:00:00", "12:00:00"),
    ]);
  });

  it("trims a trailing cut", () => {
    expect(subtractInterval(span("08:00:00", "12:00:00"), span("11:00:00", "13:00:00"))).toEqual([
      span("08:00:00", "11:00:00"),
    ]);
  });

  it("removes an interval entirely covered", () => {
    expect(subtractInterval(span("09:00:00", "10:00:00"), span("08:00:00", "12:00:00"))).toEqual([]);
  });

  it("leaves a disjoint interval untouched", () => {
    const value = span("08:00:00", "09:00:00");
    expect(subtractInterval(value, span("10:00:00", "11:00:00"))).toEqual([value]);
  });

  it("returns nothing for an empty subject", () => {
    expect(subtractInterval(span("08:00:00", "08:00:00"), span("07:00:00", "09:00:00"))).toEqual([]);
  });
});

describe("intervalGaps", () => {
  it("finds the uncovered stretches inside the bounds", () => {
    const gaps = intervalGaps(span("08:00:00", "12:00:00"), [
      span("08:00:00", "09:00:00"),
      span("10:00:00", "11:00:00"),
    ]);
    expect(gaps).toEqual([span("09:00:00", "10:00:00"), span("11:00:00", "12:00:00")]);
  });

  it("returns the whole bounds when nothing is covered", () => {
    expect(intervalGaps(span("08:00:00", "12:00:00"), [])).toEqual([span("08:00:00", "12:00:00")]);
  });

  it("returns nothing when the bounds are fully covered", () => {
    expect(intervalGaps(span("08:00:00", "12:00:00"), [span("07:00:00", "13:00:00")])).toEqual([]);
  });

  it("returns nothing for empty bounds", () => {
    expect(intervalGaps(span("08:00:00", "08:00:00"), [])).toEqual([]);
  });

  it("ignores coverage entirely outside the bounds", () => {
    expect(intervalGaps(span("08:00:00", "09:00:00"), [span("12:00:00", "13:00:00")])).toEqual([
      span("08:00:00", "09:00:00"),
    ]);
  });

  it("clips coverage that overhangs the bounds", () => {
    expect(intervalGaps(span("08:00:00", "12:00:00"), [span("07:00:00", "09:00:00")])).toEqual([
      span("09:00:00", "12:00:00"),
    ]);
  });
});

describe("ordering and rendering", () => {
  it("orders by start then end", () => {
    expect(compareIntervals(span("08:00:00", "09:00:00"), span("09:00:00", "10:00:00"))).toBeLessThan(0);
    expect(compareIntervals(span("08:00:00", "10:00:00"), span("08:00:00", "09:00:00"))).toBeGreaterThan(0);
    expect(compareIntervals(span("08:00:00", "09:00:00"), span("08:00:00", "09:00:00"))).toBe(0);
  });

  it("renders both bounds, keeping hours past 24", () => {
    expect(formatInterval(span("23:00:00", "25:30:00"))).toBe("23:00:00-25:30:00");
  });
});
