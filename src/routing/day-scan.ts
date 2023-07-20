/**
 * Placing service-day times on one absolute timeline.
 *
 * A trip's published times are relative to its own service date, and a trip
 * running past midnight carries times beyond 24:00:00 on the *previous* date.
 * A search that only looked at the query date's services would miss every
 * overnight journey; one that re-anchored times ad hoc would end up comparing
 * seconds measured from different origins.
 *
 * The fix is a single absolute clock, measured in seconds from midnight of the
 * query date. A trip anchored `k` days earlier contributes its published time
 * minus `k × 86400`; one anchored `k` days later contributes its time plus the
 * same. {@link DayScanner} enumerates the anchors worth considering, resolves
 * service activity once per anchor, and answers trip lookups in absolute
 * seconds.
 */

import { SECONDS_PER_DAY, ServiceDate } from "../time/date.js";
import { MAX_TIME_OF_DAY } from "../time/time-of-day.js";
import type { Network } from "../model/network.js";
import type { PatternTimetable } from "../model/timetable.js";
import type { TripIndex } from "../model/ids.js";

/** One service day considered by a search. */
export interface DayAnchor {
  /** The service date whose trips are being read. */
  readonly date: ServiceDate;
  /**
   * Whole days from the query date to this anchor. Positive means earlier;
   * negative means later.
   */
  readonly dayShift: number;
  /** Service ids active on this anchor date. */
  readonly activeServices: ReadonlySet<string>;
}

/** A boarding resolved against the absolute clock. */
export interface Boarding {
  readonly trip: TripIndex;
  /** The anchor whose timetable the trip came from. */
  readonly anchor: DayAnchor;
  /** Departure from the requested position, on the absolute clock. */
  readonly departure: number;
}

/** An alighting resolved against the absolute clock. */
export interface Alighting {
  readonly trip: TripIndex;
  readonly anchor: DayAnchor;
  /** Arrival at the requested position, on the absolute clock. */
  readonly arrival: number;
}

/** Restricts which trips a search may use, by trip id. */
export type TripPredicate = (tripId: string) => boolean;

/**
 * Enumerates the service days a search must read, and converts between
 * published and absolute times.
 *
 * Anchors with no active service at all are dropped at construction, so a
 * network with weekday-only service costs nothing to scan on a Sunday.
 */
export class DayScanner {
  /** The query date the absolute clock is measured from. */
  readonly date: ServiceDate;

  private readonly anchors: readonly DayAnchor[];

  private constructor(date: ServiceDate, anchors: readonly DayAnchor[]) {
    this.date = date;
    this.anchors = anchors;
  }

  /**
   * Builds a scanner covering the query date, the days before it whose
   * vehicles could still be running, and the days after it a long search could
   * reach.
   *
   * @param horizonSeconds The latest absolute time the search may consider.
   */
  static build(network: Network, date: ServiceDate, horizonSeconds: number): DayScanner {
    const backwards = network.overhangDays;
    const forwards = Math.max(0, Math.floor(horizonSeconds / SECONDS_PER_DAY));

    const anchors: DayAnchor[] = [];
    for (let dayShift = -forwards; dayShift <= backwards; dayShift += 1) {
      const anchorDate = date.addDays(-dayShift);
      const active = new Set(network.calendar.activeServiceIds(anchorDate));
      if (active.size === 0) {
        continue;
      }
      anchors.push({ date: anchorDate, dayShift, activeServices: active });
    }

    anchors.sort((a, b) => a.dayShift - b.dayShift);
    return new DayScanner(date, anchors);
  }

  /** Builds a scanner covering exactly one service date, with no overhang. */
  static forSingleDay(network: Network, date: ServiceDate): DayScanner {
    const active = new Set(network.calendar.activeServiceIds(date));
    return new DayScanner(
      date,
      active.size === 0 ? [] : [{ date, dayShift: 0, activeServices: active }],
    );
  }

  /** The anchors this scanner considers, ascending by day shift. */
  anchorList(): readonly DayAnchor[] {
    return this.anchors;
  }

  /** True when no anchor has any active service. */
  get isEmpty(): boolean {
    return this.anchors.length === 0;
  }

  /** Converts a published time on an anchor to the absolute clock. */
  toAbsolute(anchor: DayAnchor, publishedTime: number): number {
    return publishedTime - anchor.dayShift * SECONDS_PER_DAY;
  }

  /** Converts an absolute time to the published clock of an anchor. */
  toPublished(anchor: DayAnchor, absoluteTime: number): number {
    return absoluteTime + anchor.dayShift * SECONDS_PER_DAY;
  }

  /**
   * The earliest boarding of a pattern at a position at or after an absolute
   * time.
   *
   * Every anchor is consulted and the earliest absolute departure wins. An
   * anchor whose published equivalent of the requested time lies past the
   * representable range is skipped: no trip on it could serve the request.
   */
  earliestBoarding(
    timetable: PatternTimetable,
    stopPosition: number,
    absoluteTime: number,
    permitted?: TripPredicate,
  ): Boarding | undefined {
    let best: Boarding | undefined;

    for (const anchor of this.anchors) {
      const published = this.toPublished(anchor, absoluteTime);
      if (published > MAX_TIME_OF_DAY) {
        continue;
      }
      const trip = timetable.earliestTripAfter(
        stopPosition,
        Math.max(0, published),
        (candidate) => this.accepts(anchor, timetable, candidate, permitted),
      );
      if (trip === undefined) {
        continue;
      }
      const departure = this.toAbsolute(anchor, timetable.departureAt(trip, stopPosition));
      if (best === undefined || departure < best.departure) {
        best = { trip, anchor, departure };
      }
    }
    return best;
  }

  /**
   * The latest alighting from a pattern at a position at or before an absolute
   * time, used by the arrive-by search.
   */
  latestAlighting(
    timetable: PatternTimetable,
    stopPosition: number,
    absoluteTime: number,
    permitted?: TripPredicate,
  ): Alighting | undefined {
    let best: Alighting | undefined;

    for (const anchor of this.anchors) {
      const published = this.toPublished(anchor, absoluteTime);
      if (published < 0) {
        continue;
      }
      const trip = timetable.latestTripBefore(
        stopPosition,
        Math.min(MAX_TIME_OF_DAY, published),
        (candidate) => this.accepts(anchor, timetable, candidate, permitted),
      );
      if (trip === undefined) {
        continue;
      }
      const arrival = this.toAbsolute(anchor, timetable.arrivalAt(trip, stopPosition));
      if (best === undefined || arrival > best.arrival) {
        best = { trip, anchor, arrival };
      }
    }
    return best;
  }

  /**
   * The absolute departure of a known trip from a position on a known anchor.
   *
   * Used when reconstructing a journey, where the boarding has already been
   * chosen and only its time is needed.
   */
  departureOf(
    timetable: PatternTimetable,
    anchor: DayAnchor,
    trip: TripIndex,
    stopPosition: number,
  ): number {
    return this.toAbsolute(anchor, timetable.departureAt(trip, stopPosition));
  }

  /** The absolute arrival of a known trip at a position on a known anchor. */
  arrivalOf(
    timetable: PatternTimetable,
    anchor: DayAnchor,
    trip: TripIndex,
    stopPosition: number,
  ): number {
    return this.toAbsolute(anchor, timetable.arrivalAt(trip, stopPosition));
  }

  private accepts(
    anchor: DayAnchor,
    timetable: PatternTimetable,
    trip: TripIndex,
    permitted: TripPredicate | undefined,
  ): boolean {
    if (!anchor.activeServices.has(timetable.serviceIdAt(trip))) {
      return false;
    }
    return permitted === undefined || permitted(timetable.tripIdAt(trip));
  }
}
