/**
 * Durations measured in whole seconds.
 *
 * Every elapsed quantity in meridian — ride time, walking time, waiting time,
 * transfer slack, headway — is a second count. Keeping them all in one unit
 * removes the class of bug where a minutes value is added to a seconds value,
 * and the branded type stops a raw number sneaking in from feed input.
 */

import { TimeRangeError } from "../errors.js";

declare const durationBrand: unique symbol;

/** A non-negative whole number of seconds. */
export type Duration = number & { readonly [durationBrand]: true };

/** Zero elapsed time. */
export const ZERO_DURATION = 0 as Duration;

/**
 * Largest accepted duration, 30 days.
 *
 * Journey search windows and footpath budgets are always far below this; the
 * ceiling catches a caller passing milliseconds where seconds were expected.
 */
export const MAX_DURATION = 30 * 86_400;

/**
 * Wraps a raw second count as a {@link Duration}.
 *
 * @throws {TimeRangeError} if the value is not a non-negative integer within
 * {@link MAX_DURATION}.
 */
export function duration(seconds: number): Duration {
  if (!Number.isInteger(seconds)) {
    throw new TimeRangeError("duration must be an integer number of seconds", { seconds });
  }
  if (seconds < 0) {
    throw new TimeRangeError("duration must not be negative", { seconds });
  }
  if (seconds > MAX_DURATION) {
    throw new TimeRangeError("duration exceeds the 30 day limit", { seconds });
  }
  return seconds as Duration;
}

/** Builds a duration from whole minutes. */
export function minutes(count: number): Duration {
  if (!Number.isInteger(count)) {
    throw new TimeRangeError("minutes must be an integer", { minutes: count });
  }
  return duration(count * 60);
}

/** Builds a duration from whole hours. */
export function hours(count: number): Duration {
  if (!Number.isInteger(count)) {
    throw new TimeRangeError("hours must be an integer", { hours: count });
  }
  return duration(count * 3600);
}

/** Sum of two durations. */
export function addDurations(a: Duration, b: Duration): Duration {
  return duration(a + b);
}

/**
 * Difference of two durations, floored at zero.
 *
 * Saturating rather than throwing keeps slack calculations — "how much of the
 * budget is left" — free of guard clauses at every call site.
 */
export function subtractDurations(a: Duration, b: Duration): Duration {
  return duration(Math.max(0, a - b));
}

/**
 * Scales a duration by a non-negative factor, rounding to the nearest second.
 *
 * @throws {TimeRangeError} if the factor is negative or not finite.
 */
export function scaleDuration(value: Duration, factor: number): Duration {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new TimeRangeError("duration scale factor must be finite and non-negative", { factor });
  }
  return duration(Math.round(value * factor));
}

/** The shorter of two durations; ties return `a`. */
export function minDuration(a: Duration, b: Duration): Duration {
  return b < a ? b : a;
}

/** The longer of two durations; ties return `a`. */
export function maxDuration(a: Duration, b: Duration): Duration {
  return b > a ? b : a;
}

/**
 * Renders a compact human readable form: `2h 05m`, `45m 30s`, `12s`.
 *
 * Zero-valued leading units are dropped, and a zero duration renders as `0s`
 * rather than an empty string.
 */
export function formatDuration(value: Duration): string {
  if (value === 0) {
    return "0s";
  }
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0 || (h > 0 && s > 0)) {
    parts.push(h > 0 ? `${String(m).padStart(2, "0")}m` : `${m}m`);
  }
  if (s > 0) {
    parts.push(parts.length > 0 ? `${String(s).padStart(2, "0")}s` : `${s}s`);
  }
  return parts.join(" ");
}

/**
 * Renders a fixed `HH:MM:SS` form, suitable for aligned table columns.
 * Hours are not capped at 24.
 */
export function formatDurationClock(value: Duration): string {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Parses the compact form produced by {@link formatDuration}, ignoring
 * whitespace between units. A bare integer is read as seconds so that command
 * line flags accept `--max-walk 900`.
 *
 * @throws {TimeRangeError} if the text matches no accepted form.
 */
export function parseDuration(text: string): Duration {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) {
    throw new TimeRangeError("duration text is empty", { text });
  }
  if (/^\d+$/.test(compact)) {
    return duration(Number(compact));
  }
  const match = DURATION_PATTERN.exec(compact);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    throw new TimeRangeError(`"${text}" is not a duration such as "1h 30m"`, { text });
  }
  const h = match[1] === undefined ? 0 : Number(match[1]);
  const m = match[2] === undefined ? 0 : Number(match[2]);
  const s = match[3] === undefined ? 0 : Number(match[3]);
  return duration(h * 3600 + m * 60 + s);
}
