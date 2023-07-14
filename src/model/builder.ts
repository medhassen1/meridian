/**
 * Compiling a parsed feed into a routing network.
 *
 * The build is one pass with no I/O and no clock reads, so the same feed
 * always produces the same network. Every ordering decision inside it is
 * explicit — stops by id, patterns by key, trips by departure — because the
 * indices assigned here become the tie-breakers in every routing result.
 */

import { NetworkBuildError } from "../errors.js";
import { SECONDS_PER_DAY } from "../time/date.js";
import { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { ServiceCalendar } from "../calendar/service-calendar.js";
import type { Frequency } from "../feed/frequencies.js";
import type { GtfsFeed, TripWithCalls } from "../feed/feed.js";
import { TABLES } from "../feed/source.js";
import { expandFrequencies, type ExpandedRun } from "./frequency-expansion.js";
import { Network } from "./network.js";
import {
  buildPatterns,
  indexPatternsByStop,
  type RoutePattern,
} from "./route-pattern.js";
import { StopCatalogue } from "./stop-index.js";
import { PatternTimetable } from "./timetable.js";
import { TransferGraph, type TransferGraphOptions } from "./transfer-graph.js";

/** Options controlling network construction. */
export interface BuildOptions extends TransferGraphOptions {
  /**
   * When false, no footpaths are generated and only published transfers apply.
   * Defaults to true.
   */
  readonly generateFootpaths?: boolean;
  /**
   * When false, headway-based trips are left as single template trips rather
   * than expanded into their generated runs. Defaults to true; disabling it is
   * only useful for inspecting the feed as published.
   */
  readonly expandFrequencies?: boolean;
  /** Maximum diagnostics retained during the build. */
  readonly diagnosticLimit?: number;
}

/** The outcome of a build. */
export interface BuildResult {
  readonly network: Network;
  readonly diagnostics: DiagnosticSink;
  /** Provenance of each generated run, keyed by its synthetic trip id. */
  readonly generatedRuns: ReadonlyMap<string, ExpandedRun>;
}

/** Rule identifiers emitted by this module. */
export const BUILD_RULES = {
  tripSkipped: "build.trip_skipped",
  noPatterns: "build.no_patterns",
  overtaking: "build.overtaking_pattern",
  isolatedStop: "build.isolated_stop",
} as const;

/**
 * Compiles a feed into a network.
 *
 * @throws {NetworkBuildError} if the feed is internally inconsistent in a way
 * the loader should have caught — a pattern referencing a trip that does not
 * exist, for instance. Ordinary feed problems produce diagnostics instead.
 */
export function buildNetwork(sourceFeed: GtfsFeed, options: BuildOptions = {}): BuildResult {
  const sink = new DiagnosticSink(options.diagnosticLimit);

  // Headway-based trips become concrete runs before anything else looks at the
  // timetable, so patterns, indices, and the query path never have to know
  // that `frequencies.txt` existed.
  const expansion =
    (options.expandFrequencies ?? true)
      ? expandFrequencies(sourceFeed)
      : { feed: sourceFeed, runs: new Map<string, ExpandedRun>() };
  const feed = expansion.feed;

  const stops = StopCatalogue.build(feed.stops);
  const { patterns, skippedTripIds } = buildPatterns(feed.trips, stops);

  for (const tripId of skippedTripIds) {
    sink.error(
      BUILD_RULES.tripSkipped,
      `trip "${tripId}" calls at a stop the feed does not define and was excluded from the network`,
      position(TABLES.stopTimes, feed.tripById.get(tripId)?.line ?? 1, 1),
    );
  }
  if (patterns.length === 0) {
    sink.warn(
      BUILD_RULES.noPatterns,
      "the feed yielded no route patterns, so no journey can ever be found",
      position(TABLES.trips, 1, 1),
    );
  }

  const timetables = patterns.map((pattern) => PatternTimetable.build(pattern, feed.tripById));
  for (let index = 0; index < timetables.length; index += 1) {
    const timetable = timetables[index] as PatternTimetable;
    if (!timetable.isTotallyOrdered) {
      sink.info(
        BUILD_RULES.overtaking,
        `pattern ${index} on route "${(patterns[index] as RoutePattern).routeId}" contains overtaking trips, so its trip lookup falls back to a linear scan`,
        position(TABLES.trips, 1, 1),
      );
    }
  }

  const transfers =
    (options.generateFootpaths ?? true)
      ? TransferGraph.build(stops, feed.transfers, options)
      : TransferGraph.build(stops, feed.transfers, { ...options, maxWalkMetres: 0 });

  const patternsByStop = indexPatternsByStop(patterns, stops.count);
  reportIsolatedStops(stops, patternsByStop, transfers, sink);

  const network = new Network({
    feed,
    stops,
    patterns,
    timetables,
    transfers,
    calendar: ServiceCalendar.build(feed.calendars, feed.calendarExceptions),
    patternsByStop,
    frequenciesByTrip: groupFrequencies(feed.frequencies),
    overhangDays: measureOverhang(feed.trips),
  });

  return { network, diagnostics: sink, generatedRuns: expansion.runs };
}

/**
 * Rebuilds a network with different transfer options, reusing nothing.
 *
 * Provided so that a caller exploring the effect of walking radius does not
 * have to re-parse the feed, which is by far the more expensive half.
 */
export function rebuildWithTransfers(network: Network, options: BuildOptions): BuildResult {
  return buildNetwork(network.feed, options);
}

/**
 * The longest past-midnight overhang across the feed, in whole days.
 *
 * Determines how many service days back a query has to scan. Measuring it from
 * the feed means a network with no overnight service pays for exactly one
 * service day per query rather than a fixed worst case.
 */
function measureOverhang(trips: readonly TripWithCalls[]): number {
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

/** Groups frequency windows by the trip they apply to. */
function groupFrequencies(frequencies: readonly Frequency[]): Map<string, Frequency[]> {
  const byTrip = new Map<string, Frequency[]>();
  for (const frequency of frequencies) {
    const existing = byTrip.get(frequency.tripId);
    if (existing === undefined) {
      byTrip.set(frequency.tripId, [frequency]);
    } else {
      existing.push(frequency);
    }
  }
  for (const windows of byTrip.values()) {
    windows.sort((a, b) => a.startTime - b.startTime || a.line - b.line);
  }
  return byTrip;
}

/**
 * Reports served stops that no footpath reaches.
 *
 * An isolated stop is still routable — a passenger can board and alight there
 * — but it can never be used for an interchange, which is usually a sign that
 * its coordinates are wrong rather than that it is genuinely remote.
 */
function reportIsolatedStops(
  stops: StopCatalogue,
  patternsByStop: ReadonlyArray<readonly unknown[]>,
  transfers: TransferGraph,
  sink: DiagnosticSink,
): void {
  for (const stop of stops.boardableIndices()) {
    const servedByPattern = (patternsByStop[stop]?.length ?? 0) > 0;
    if (!servedByPattern) {
      continue;
    }
    if (transfers.from(stop).length === 0) {
      sink.info(
        BUILD_RULES.isolatedStop,
        `stop "${stops.idAt(stop)}" is served but has no walking connection to any other stop`,
        position(TABLES.stops, stops.stopAt(stop).line, 1),
      );
    }
  }
}

/**
 * Asserts that a network is internally consistent.
 *
 * Cheap enough to run in tests over every fixture, and it catches the class of
 * builder bug — an index off by one, a pattern and timetable that disagree —
 * that would otherwise surface as a wrong journey rather than a crash.
 *
 * @throws {NetworkBuildError} on the first inconsistency found.
 */
export function assertNetworkConsistent(network: Network): void {
  if (network.patterns.length !== network.timetables.length) {
    throw new NetworkBuildError("pattern and timetable counts disagree", {
      patterns: network.patterns.length,
      timetables: network.timetables.length,
    });
  }

  for (let index = 0; index < network.patterns.length; index += 1) {
    const pattern = network.patterns[index] as RoutePattern;
    const timetable = network.timetables[index] as PatternTimetable;

    if (pattern.index !== index) {
      throw new NetworkBuildError(`pattern at ${index} reports index ${pattern.index}`, { index });
    }
    if (pattern.stops.length < 2) {
      throw new NetworkBuildError(`pattern ${index} has fewer than 2 stops`, { index });
    }
    if (
      pattern.pickup.length !== pattern.stops.length ||
      pattern.dropOff.length !== pattern.stops.length
    ) {
      throw new NetworkBuildError(`pattern ${index} has mismatched boarding rule arrays`, { index });
    }
    if (timetable.stopCount !== pattern.stops.length) {
      throw new NetworkBuildError(`timetable ${index} disagrees with its pattern's stop count`, {
        index,
      });
    }

    for (const stop of pattern.stops) {
      if (stop < 0 || stop >= network.stops.count) {
        throw new NetworkBuildError(`pattern ${index} references out of range stop ${stop}`, {
          index,
          stop,
        });
      }
    }
  }
}
