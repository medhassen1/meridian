/**
 * Checks over dates, times, and service activity.
 *
 * These are the failures that make a technically valid feed useless: a
 * calendar that expired last month, a service every date of which has been
 * removed by exception, a trip that claims to take eleven hours between two
 * adjacent stops.
 */

import { SECONDS_PER_DAY } from "../time/date.js";
import { formatTimeOfDay } from "../time/time-of-day.js";
import { formatDuration, duration } from "../time/duration.js";
import { TABLES } from "../feed/source.js";
import { referencedServiceIds } from "../feed/feed.js";
import { at, type Validator } from "./context.js";

/**
 * Longest plausible single vehicle journey, in seconds.
 *
 * Sixteen hours accommodates long-distance rail and overnight coaches while
 * still catching the classic export bug, a trip whose last call carries a time
 * from the wrong day.
 */
export const MAX_PLAUSIBLE_TRIP_SECONDS = 16 * 3600;

/** Reports services that are active on no date at all. */
export const validateServiceActivity: Validator = ({ calendar }, report) => {
  for (const serviceId of calendar.neverActiveServiceIds()) {
    report.emit(
      "time.service_never_active",
      `service "${serviceId}" is active on no date inside the calendar's coverage`,
      at(TABLES.calendar, 1),
    );
  }
};

/**
 * Reports trips whose service is never active.
 *
 * Distinct from the rule above: a never-active service is a calendar problem,
 * whereas a trip depending on one is dead weight in the timetable, and a feed
 * can have many of the second for one of the first.
 */
export const validateTripActivity: Validator = ({ feed, calendar }, report) => {
  const neverActive = new Set(calendar.neverActiveServiceIds());
  if (neverActive.size === 0) {
    return;
  }
  for (const trip of feed.trips) {
    if (neverActive.has(trip.serviceId)) {
      report.emit(
        "time.trip_never_runs",
        `trip "${trip.tripId}" uses service "${trip.serviceId}", which is never active`,
        at(TABLES.trips, trip.line),
      );
    }
  }
};

/**
 * Compares the calendar's real coverage against the range `feed_info.txt`
 * declares.
 *
 * A feed whose declared range extends past its calendar is promising service
 * it does not describe, which is what a stale export looks like.
 */
export const validateDeclaredRange: Validator = ({ feed, calendar }, report) => {
  const info = feed.feedInfo;
  const coverage = calendar.coverage();
  if (info?.startDate === undefined || info.endDate === undefined || coverage === undefined) {
    return;
  }

  if (coverage.end.isBefore(info.endDate)) {
    report.emit(
      "time.declared_range_mismatch",
      `feed_info declares service through ${info.endDate.toISO()} but the calendar ends on ${coverage.end.toISO()}`,
      at(TABLES.feedInfo, info.line),
    );
  }
  if (info.startDate.isBefore(coverage.start)) {
    report.emit(
      "time.declared_range_mismatch",
      `feed_info declares service from ${info.startDate.toISO()} but the calendar starts on ${coverage.start.toISO()}`,
      at(TABLES.feedInfo, info.line),
    );
  }
};

/**
 * Reports a calendar whose coverage is entirely in the past relative to a
 * reference date supplied by the caller.
 *
 * The reference date is a parameter rather than the system clock, so the check
 * is reproducible and so that a caller validating a future timetable can say
 * which date it cares about.
 */
export function validateFeedExpiry(referenceDateCompact: string): Validator {
  return ({ calendar }, report) => {
    const coverage = calendar.coverage();
    if (coverage === undefined) {
      return;
    }
    if (coverage.end.toCompact() < referenceDateCompact) {
      report.emit(
        "time.feed_expired",
        `the calendar ends on ${coverage.end.toISO()}, before the reference date ${referenceDateCompact}`,
        at(TABLES.calendar, 1),
      );
    }
  };
}

/** Reports trips that run for implausibly long, or that hop between stops instantly. */
export const validateTripDurations: Validator = ({ feed }, report) => {
  for (const trip of feed.trips) {
    const first = trip.calls[0];
    const last = trip.calls[trip.calls.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }

    const elapsed = last.arrivalTime - first.departureTime;
    if (elapsed > MAX_PLAUSIBLE_TRIP_SECONDS) {
      report.emit(
        "time.trip_too_long",
        `trip "${trip.tripId}" runs for ${formatDuration(
          duration(elapsed),
        )}, from ${formatTimeOfDay(first.departureTime)} to ${formatTimeOfDay(last.arrivalTime)}`,
        at(TABLES.trips, trip.line),
      );
    }

    for (let index = 1; index < trip.calls.length; index += 1) {
      const previous = trip.calls[index - 1];
      const current = trip.calls[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (current.arrivalTime === previous.departureTime && current.stopId !== previous.stopId) {
        report.emit(
          "time.zero_length_hop",
          `trip "${trip.tripId}" travels from "${previous.stopId}" to "${current.stopId}" in zero seconds`,
          at(TABLES.stopTimes, current.line),
        );
      }
    }
  }
};

/** Reports services and shapes that nothing references. */
export const validateUnusedEntities: Validator = ({ feed, calendar }, report) => {
  const usedServices = new Set(referencedServiceIds(feed));
  for (const serviceId of calendar.serviceIds()) {
    if (!usedServices.has(serviceId)) {
      report.emit(
        "cover.unused_service",
        `service "${serviceId}" is defined but no trip uses it`,
        at(TABLES.calendar, 1),
      );
    }
  }

  const usedShapes = new Set<string>();
  const usedRoutes = new Set<string>();
  for (const trip of feed.trips) {
    if (trip.shapeId !== undefined) {
      usedShapes.add(trip.shapeId);
    }
    usedRoutes.add(trip.routeId);
  }
  for (const shapeId of feed.shapes.keys()) {
    if (!usedShapes.has(shapeId)) {
      report.emit(
        "cover.unused_shape",
        `shape "${shapeId}" is defined but no trip uses it`,
        at(TABLES.shapes, 1),
      );
    }
  }
  for (const route of feed.routes) {
    if (!usedRoutes.has(route.routeId)) {
      report.emit(
        "cover.route_without_trips",
        `route "${route.routeId}" has no trips`,
        at(TABLES.routes, route.line),
      );
    }
  }
};

/**
 * The longest past-midnight overhang any trip in the feed reaches, in whole
 * days.
 *
 * Exposed so that a caller can size the routing engine's service-day scan from
 * the feed rather than from a constant.
 */
export function feedOverhangDays(
  trips: readonly { readonly calls: readonly { readonly arrivalTime: number }[] }[],
): number {
  let longest = 0;
  for (const trip of trips) {
    const last = trip.calls[trip.calls.length - 1];
    if (last === undefined) {
      continue;
    }
    const days = Math.floor(last.arrivalTime / SECONDS_PER_DAY);
    if (days > longest) {
      longest = days;
    }
  }
  return longest;
}

/** Every temporal validator, in the order a report reads best. */
export const TEMPORAL_VALIDATORS: readonly Validator[] = [
  validateServiceActivity,
  validateTripActivity,
  validateDeclaredRange,
  validateTripDurations,
  validateUnusedEntities,
];
