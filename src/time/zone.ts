/**
 * Explicit UTC offset rules, used to place service-day local times on an
 * absolute timeline.
 *
 * meridian deliberately ships no IANA time zone database. Bundling one would
 * make results depend on the tzdata release installed at build time, which is
 * exactly the kind of hidden, drifting input that makes a routing result
 * irreproducible six months later. Instead a caller who needs absolute
 * instants supplies the offset rule explicitly, and the rule is recorded
 * alongside the result.
 *
 * All internal routing runs on service-day local seconds and never needs a
 * zone at all; this module exists at the boundary, for callers converting to
 * and from epoch timestamps.
 */

import { TimeRangeError } from "../errors.js";
import { ServiceDate, SECONDS_PER_DAY } from "./date.js";
import type { TimeOfDay } from "./time-of-day.js";

/** Largest offset from UTC accepted, matching the real world range of ±14h. */
export const MAX_UTC_OFFSET = 14 * 3600;

/**
 * A rule mapping a service date to that day's offset from UTC, in seconds east
 * of Greenwich.
 */
export interface TimeZone {
  /** Identifier recorded in reports, for example `Europe/Berlin`. */
  readonly id: string;
  /** Offset in seconds east of UTC that applies on the given service date. */
  offsetSecondsFor(date: ServiceDate): number;
}

/** A single offset change, effective from `from` onwards. */
export interface OffsetTransition {
  /** First service date on which `offsetSeconds` applies. */
  readonly from: ServiceDate;
  /** Offset in seconds east of UTC. */
  readonly offsetSeconds: number;
}

/**
 * Builds a zone whose offset never changes.
 *
 * @throws {TimeRangeError} if the offset is not a whole number of seconds
 * within {@link MAX_UTC_OFFSET}.
 */
export function fixedOffsetZone(id: string, offsetSeconds: number): TimeZone {
  assertOffset(offsetSeconds);
  return Object.freeze({
    id,
    offsetSecondsFor(): number {
      return offsetSeconds;
    },
  });
}

/** The zone for UTC itself. */
export const UTC: TimeZone = fixedOffsetZone("UTC", 0);

/**
 * Builds a zone from an explicit table of offset changes.
 *
 * Transitions are sorted internally, so callers may pass them in any order.
 * The first transition's offset also applies to every date before it, which
 * makes a table with a single entry equivalent to a fixed offset zone.
 *
 * @throws {TimeRangeError} if the table is empty, contains a duplicate
 * effective date, or contains an out of range offset.
 */
export function offsetTableZone(id: string, transitions: readonly OffsetTransition[]): TimeZone {
  if (transitions.length === 0) {
    throw new TimeRangeError(`zone "${id}" needs at least one offset transition`, { id });
  }
  const sorted = transitions.slice().sort((a, b) => a.from.compare(b.from));
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index] as OffsetTransition;
    assertOffset(entry.offsetSeconds);
    const previous = sorted[index - 1];
    if (previous !== undefined && previous.from.equals(entry.from)) {
      throw new TimeRangeError(`zone "${id}" has two transitions on ${entry.from.toISO()}`, {
        id,
        date: entry.from.toCompact(),
      });
    }
  }

  return Object.freeze({
    id,
    offsetSecondsFor(date: ServiceDate): number {
      // Binary search for the last transition at or before `date`.
      let low = 0;
      let high = sorted.length - 1;
      let found = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const entry = sorted[mid] as OffsetTransition;
        if (entry.from.compare(date) <= 0) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return (sorted[found] as OffsetTransition).offsetSeconds;
    },
  });
}

/**
 * Converts a service-day local time to seconds since the Unix epoch.
 *
 * The offset used is the one in force on the *anchor* date, even when the time
 * of day rolls past midnight. That matches how transit agencies publish
 * schedules: a trip anchored to the day before a spring-forward transition
 * keeps that day's offset for its whole run, so its printed times stay
 * self-consistent.
 */
export function toEpochSeconds(date: ServiceDate, time: TimeOfDay, zone: TimeZone): number {
  const offset = zone.offsetSecondsFor(date);
  return date.toEpochDay() * SECONDS_PER_DAY + time - offset;
}

/**
 * Converts seconds since the Unix epoch back to a service date and time of
 * day, using the offset in force on the resulting local date.
 *
 * The result always has a time of day inside `[00:00:00, 24:00:00)`; it does
 * not attempt to recover the "past midnight" anchoring of the original trip,
 * which is not derivable from an instant alone.
 */
export function fromEpochSeconds(
  epochSeconds: number,
  zone: TimeZone,
): { date: ServiceDate; secondsOfDay: number } {
  if (!Number.isInteger(epochSeconds)) {
    throw new TimeRangeError("epoch seconds must be an integer", { epochSeconds });
  }
  // Resolve the local date with a provisional offset, then re-read the offset
  // for that date. One refinement suffices because transitions are at most a
  // few hours and are anchored to whole days.
  const provisional = Math.floor(epochSeconds / SECONDS_PER_DAY);
  const provisionalDate = ServiceDate.fromEpochDay(provisional);
  const offset = zone.offsetSecondsFor(provisionalDate);
  const localSeconds = epochSeconds + offset;
  const epochDay = Math.floor(localSeconds / SECONDS_PER_DAY);
  const date = ServiceDate.fromEpochDay(epochDay);
  return { date, secondsOfDay: localSeconds - epochDay * SECONDS_PER_DAY };
}

const OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/;

/**
 * Parses an ISO 8601 style offset such as `+02:00`, `-0500`, or `Z`.
 *
 * @throws {TimeRangeError} if the text is not a recognised offset.
 */
export function parseUtcOffset(text: string): number {
  if (text === "Z" || text === "z") {
    return 0;
  }
  const match = OFFSET_PATTERN.exec(text);
  if (!match) {
    throw new TimeRangeError(`"${text}" is not a UTC offset such as "+02:00"`, { text });
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const mins = Number(match[3]);
  if (mins > 59) {
    throw new TimeRangeError(`"${text}" has an out of range minute component`, { text });
  }
  const offset = sign * (hours * 3600 + mins * 60);
  assertOffset(offset);
  return offset;
}

/** Renders an offset in the `+HH:MM` form; UTC renders as `+00:00`. */
export function formatUtcOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const absolute = Math.abs(offsetSeconds);
  const hours = Math.floor(absolute / 3600);
  const mins = Math.floor((absolute % 3600) / 60);
  return `${sign}${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function assertOffset(offsetSeconds: number): void {
  if (!Number.isInteger(offsetSeconds)) {
    throw new TimeRangeError("UTC offset must be an integer number of seconds", { offsetSeconds });
  }
  if (Math.abs(offsetSeconds) > MAX_UTC_OFFSET) {
    throw new TimeRangeError("UTC offset exceeds ±14 hours", { offsetSeconds });
  }
}
