/**
 * Half-open second intervals `[start, end)`.
 *
 * Half-open bounds are what make interval algebra composable: two adjacent
 * intervals meeting at the same second neither overlap nor leave a gap, so a
 * service window ending at 09:00:00 and the next beginning at 09:00:00 tile
 * cleanly. The routing engine relies on that when it merges frequency windows
 * and when it clips a search window to a service day.
 */

import { TimeRangeError } from "../errors.js";
import { formatTimeOfDay, type TimeOfDay } from "./time-of-day.js";
import { duration, type Duration } from "./duration.js";

/** A half-open range of times of day, `[start, end)`. */
export interface TimeInterval {
  /** Inclusive lower bound. */
  readonly start: TimeOfDay;
  /** Exclusive upper bound; never below `start`. */
  readonly end: TimeOfDay;
}

/**
 * Builds an interval.
 *
 * An empty interval (`start === end`) is legal and behaves as the identity for
 * union and the absorbing element for intersection.
 *
 * @throws {TimeRangeError} if `end` precedes `start`.
 */
export function interval(start: TimeOfDay, end: TimeOfDay): TimeInterval {
  if (end < start) {
    throw new TimeRangeError("interval end precedes its start", {
      start: formatTimeOfDay(start),
      end: formatTimeOfDay(end),
    });
  }
  return Object.freeze({ start, end });
}

/** Elapsed seconds covered by the interval. */
export function intervalLength(value: TimeInterval): Duration {
  return duration(value.end - value.start);
}

/** True when the interval covers no time at all. */
export function isEmptyInterval(value: TimeInterval): boolean {
  return value.start >= value.end;
}

/** True when `time` falls in `[start, end)`. */
export function intervalContains(value: TimeInterval, time: TimeOfDay): boolean {
  return time >= value.start && time < value.end;
}

/** True when the two intervals share at least one second. */
export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * The shared span of two intervals, or `undefined` when they are disjoint.
 * Touching intervals are disjoint under half-open semantics.
 */
export function intersectIntervals(a: TimeInterval, b: TimeInterval): TimeInterval | undefined {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return start < end ? interval(start, end) : undefined;
}

/**
 * The smallest interval containing both inputs.
 *
 * This is the convex hull rather than a set union: for disjoint inputs it also
 * covers the gap between them. Use {@link mergeIntervals} when the gap must be
 * preserved.
 */
export function hullOfIntervals(a: TimeInterval, b: TimeInterval): TimeInterval {
  const start = a.start < b.start ? a.start : b.start;
  const end = a.end > b.end ? a.end : b.end;
  return interval(start, end);
}

/**
 * Normalises a list of intervals into ascending, non-overlapping coverage.
 *
 * Empty intervals are dropped. Adjacent intervals that merely touch are joined,
 * because a passenger cannot observe the boundary between two back-to-back
 * service windows.
 *
 * The input is not mutated, and the result is deterministic for any input
 * ordering.
 */
export function mergeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = intervals
    .filter((candidate) => !isEmptyInterval(candidate))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TimeInterval[] = [];
  for (const candidate of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && candidate.start <= last.end) {
      if (candidate.end > last.end) {
        merged[merged.length - 1] = interval(last.start, candidate.end);
      }
      continue;
    }
    merged.push(candidate);
  }
  return merged;
}

/**
 * Removes `cut` from `value`, returning the zero, one, or two remaining
 * fragments in ascending order.
 */
export function subtractInterval(value: TimeInterval, cut: TimeInterval): TimeInterval[] {
  if (isEmptyInterval(value)) {
    return [];
  }
  if (!intervalsOverlap(value, cut)) {
    return [value];
  }
  const fragments: TimeInterval[] = [];
  if (value.start < cut.start) {
    fragments.push(interval(value.start, cut.start));
  }
  if (cut.end < value.end) {
    fragments.push(interval(cut.end, value.end));
  }
  return fragments;
}

/**
 * The gaps left uncovered by `intervals` inside `bounds`, in ascending order.
 *
 * Used by the validator to report parts of a service window with no scheduled
 * departures.
 */
export function intervalGaps(
  bounds: TimeInterval,
  intervals: readonly TimeInterval[],
): TimeInterval[] {
  if (isEmptyInterval(bounds)) {
    return [];
  }
  const gaps: TimeInterval[] = [];
  let cursor = bounds.start;
  for (const covered of mergeIntervals(intervals)) {
    const clipped = intersectIntervals(covered, bounds);
    if (clipped === undefined) {
      continue;
    }
    if (clipped.start > cursor) {
      gaps.push(interval(cursor, clipped.start));
    }
    if (clipped.end > cursor) {
      cursor = clipped.end;
    }
  }
  if (cursor < bounds.end) {
    gaps.push(interval(cursor, bounds.end));
  }
  return gaps;
}

/** Total ordering by start, then by end. */
export function compareIntervals(a: TimeInterval, b: TimeInterval): number {
  return a.start - b.start || a.end - b.end;
}

/** Renders `HH:MM:SS-HH:MM:SS`, keeping hours past 24. */
export function formatInterval(value: TimeInterval): string {
  return `${formatTimeOfDay(value.start)}-${formatTimeOfDay(value.end)}`;
}
