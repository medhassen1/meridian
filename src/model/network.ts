/**
 * The compiled routing network.
 *
 * Everything a query needs, in the shape a query needs it: stops as dense
 * indices, trips grouped into patterns with flat time matrices, footpaths as
 * an adjacency list, and a calendar that answers service activity. The feed it
 * was built from is kept alongside, because results have to be rendered with
 * the names and colours the agency published.
 *
 * A network is immutable and safe to share across concurrent queries. Building
 * one is the expensive step; running a query against it is not.
 */

import { UnknownStopError } from "../errors.js";
import type { BoundingBox } from "../geo/bbox.js";
import type { Coordinate } from "../geo/coordinate.js";
import type { GridMatch } from "../geo/grid.js";
import type { ServiceCalendar } from "../calendar/service-calendar.js";
import type { GtfsFeed, TripWithCalls } from "../feed/feed.js";
import type { Route } from "../feed/routes.js";
import type { Frequency } from "../feed/frequencies.js";
import type { Stop } from "../feed/stops.js";
import { type PatternIndex, type StopIndex } from "./ids.js";
import type { RoutePattern } from "./route-pattern.js";
import type { StopCatalogue } from "./stop-index.js";
import type { PatternTimetable } from "./timetable.js";
import type { TransferGraph } from "./transfer-graph.js";

/** Counts describing a compiled network. */
export interface NetworkStatistics {
  readonly stops: number;
  readonly boardableStops: number;
  readonly patterns: number;
  readonly trips: number;
  readonly footpaths: number;
  /** Patterns whose trips overtake one another, forcing a linear trip search. */
  readonly overtakingPatterns: number;
  /** Longest past-midnight overhang in the timetable, in whole days. */
  readonly overhangDays: number;
}

/** The compiled network. */
export class Network {
  /** The feed this network was compiled from. */
  readonly feed: GtfsFeed;

  /** Stops, addressable by index. */
  readonly stops: StopCatalogue;

  /** Distinct stop sequences, in index order. */
  readonly patterns: readonly RoutePattern[];

  /** Timetables, parallel to {@link patterns}. */
  readonly timetables: readonly PatternTimetable[];

  /** Walking connections between stops. */
  readonly transfers: TransferGraph;

  /** Service activity by date. */
  readonly calendar: ServiceCalendar;

  /** Longest past-midnight overhang present in the timetable, in whole days. */
  readonly overhangDays: number;

  private readonly patternsByStop: ReadonlyArray<readonly PatternIndex[]>;
  private readonly frequenciesByTrip: ReadonlyMap<string, readonly Frequency[]>;

  constructor(parameters: {
    feed: GtfsFeed;
    stops: StopCatalogue;
    patterns: readonly RoutePattern[];
    timetables: readonly PatternTimetable[];
    transfers: TransferGraph;
    calendar: ServiceCalendar;
    patternsByStop: ReadonlyArray<readonly PatternIndex[]>;
    frequenciesByTrip: ReadonlyMap<string, readonly Frequency[]>;
    overhangDays: number;
  }) {
    this.feed = parameters.feed;
    this.stops = parameters.stops;
    this.patterns = parameters.patterns;
    this.timetables = parameters.timetables;
    this.transfers = parameters.transfers;
    this.calendar = parameters.calendar;
    this.patternsByStop = parameters.patternsByStop;
    this.frequenciesByTrip = parameters.frequenciesByTrip;
    this.overhangDays = parameters.overhangDays;
  }

  /** The patterns calling at a stop, ascending by pattern index. */
  patternsAt(stop: StopIndex): readonly PatternIndex[] {
    return this.patternsByStop[stop] ?? [];
  }

  /** The timetable for a pattern. */
  timetableFor(pattern: PatternIndex): PatternTimetable {
    return this.timetables[pattern] as PatternTimetable;
  }

  /** The pattern record at an index. */
  patternAt(pattern: PatternIndex): RoutePattern {
    return this.patterns[pattern] as RoutePattern;
  }

  /** The route a pattern belongs to, or `undefined` when it was dropped. */
  routeFor(pattern: PatternIndex): Route | undefined {
    return this.feed.routeById.get(this.patternAt(pattern).routeId);
  }

  /** The trip record behind a trip id. */
  tripFor(tripId: string): TripWithCalls | undefined {
    return this.feed.tripById.get(tripId);
  }

  /** The frequency windows for a trip, empty when it is a scheduled trip. */
  frequenciesFor(tripId: string): readonly Frequency[] {
    return this.frequenciesByTrip.get(tripId) ?? [];
  }

  /** True when the trip is published as a headway rather than a timetable. */
  isFrequencyBased(tripId: string): boolean {
    return this.frequenciesFor(tripId).length > 0;
  }

  /**
   * The index of a stop id.
   *
   * @throws {UnknownStopError} when the network has no such stop. Queries name
   * stops by id, and a typo should fail loudly rather than silently search
   * from nowhere.
   */
  requireStop(stopId: string): StopIndex {
    const index = this.stops.indexOf(stopId);
    if (index === undefined) {
      throw new UnknownStopError(stopId);
    }
    return index;
  }

  /** The stop record for an id, or `undefined`. */
  stopById(stopId: string): Stop | undefined {
    const index = this.stops.indexOf(stopId);
    return index === undefined ? undefined : this.stops.stopAt(index);
  }

  /** Stops within a radius of a point, nearest first. */
  stopsNear(point: Coordinate, radiusMetres: number): GridMatch<StopIndex>[] {
    return this.stops.nearby(point, radiusMetres);
  }

  /** The bounding box of the network's located stops. */
  get boundingBox(): BoundingBox | undefined {
    return this.stops.boundingBox;
  }

  /** Number of trips across every pattern. */
  get tripCount(): number {
    let total = 0;
    for (const timetable of this.timetables) {
      total += timetable.tripCount;
    }
    return total;
  }

  /** Counts describing the network. */
  statistics(): NetworkStatistics {
    return {
      stops: this.stops.count,
      boardableStops: this.stops.boardableIndices().length,
      patterns: this.patterns.length,
      trips: this.tripCount,
      footpaths: this.transfers.edgeCount,
      overtakingPatterns: this.timetables.filter((timetable) => !timetable.isTotallyOrdered).length,
      overhangDays: this.overhangDays,
    };
  }

  /**
   * Patterns that call at any of a set of stops, deduplicated and ascending.
   *
   * Used when an origin resolves to several platforms of one station.
   */
  patternsAtAny(stops: Iterable<StopIndex>): PatternIndex[] {
    const seen = new Set<PatternIndex>();
    for (const stop of stops) {
      for (const pattern of this.patternsAt(stop)) {
        seen.add(pattern);
      }
    }
    return Array.from(seen).sort((a, b) => a - b);
  }
}
