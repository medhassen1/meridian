/**
 * The RAPTOR round loop.
 *
 * RAPTOR — Round-bAsed Public Transit Optimized Router, Delling et al., 2012 —
 * computes earliest arrivals by rounds rather than by relaxing a priority
 * queue. Round `k` finds the earliest arrival at every stop using at most `k`
 * boardings, which means the number of transfers is a *structural* property of
 * the answer rather than a cost to be traded against time. That is what makes
 * it a good fit for a passenger-facing planner: "fastest" and "fewest changes"
 * both fall out of the same run.
 *
 * Each round does two things. It scans every pattern reachable from a stop
 * improved in the previous round, riding it forward and recording arrivals.
 * Then it extends the newly improved stops along footpaths. When a round
 * improves nothing, no later round can either, and the search stops.
 */

import { RoutingError } from "../errors.js";
import type { PatternIndex, StopIndex, TripIndex } from "../model/ids.js";
import type { Network } from "../model/network.js";
import { allowsAlightingAt, allowsBoardingAt, type RoutePattern } from "../model/route-pattern.js";
import { DayScanner, type DayAnchor } from "./day-scan.js";
import { bestDestinationArrival, relaxFootpaths, seedOrigins } from "./footpath.js";
import { LabelSet, MarkedStops, UNREACHED } from "./labels.js";
import { hasTripFilters, searchHorizon, tripPermitted, type JourneyQuery } from "./query.js";

/** Counters describing the work one search performed. */
export interface SearchStatistics {
  /** Rounds actually executed, excluding the seeding round. */
  readonly rounds: number;
  /** Pattern scans performed across every round. */
  readonly patternScans: number;
  /** Trip lookups performed. */
  readonly tripLookups: number;
  /** Footpaths examined. */
  readonly footpathsExamined: number;
  /** Stop labels improved. */
  readonly labelsImproved: number;
}

/** The state a completed search leaves behind. */
export interface SearchResult {
  readonly labels: LabelSet;
  readonly scanner: DayScanner;
  readonly query: JourneyQuery;
  readonly statistics: SearchStatistics;
}

/**
 * The largest number of rounds the engine will run regardless of the query.
 *
 * Each round costs a full pattern sweep, and a journey needing more than a
 * dozen boardings is not one a passenger would accept. The cap turns a
 * pathological query into a bounded one.
 */
export const MAX_ROUNDS = 12;

/**
 * Runs the earliest-arrival search.
 *
 * @throws {RoutingError} if the query asks for more rounds than
 * {@link MAX_ROUNDS}.
 */
export function runRaptor(network: Network, query: JourneyQuery): SearchResult {
  if (query.maxBoardings > MAX_ROUNDS) {
    throw new RoutingError(`maxBoardings ${query.maxBoardings} exceeds the limit of ${MAX_ROUNDS}`, {
      maxBoardings: query.maxBoardings,
      limit: MAX_ROUNDS,
    });
  }

  const horizon = searchHorizon(query);
  const scanner = DayScanner.build(network, query.date, horizon);
  const labels = new LabelSet(network.stops.count, query.maxBoardings);
  const marked = new MarkedStops(network.stops.count);

  const statistics = {
    rounds: 0,
    patternScans: 0,
    tripLookups: 0,
    footpathsExamined: 0,
    labelsImproved: 0,
  };

  if (scanner.isEmpty) {
    // No service runs on any relevant date; the labels stay empty and every
    // caller sees "no journey" rather than a spurious result.
    return { labels, scanner, query, statistics };
  }

  seedOrigins(labels, network.transfers, query.origins, query.departAfter, marked, horizon);

  const permitted = hasTripFilters(query)
    ? (tripId: string): boolean => tripPermitted(network, query, tripId)
    : undefined;

  for (let round = 1; round <= query.maxBoardings; round += 1) {
    labels.carryForward(round - 1, round);
    const sources = marked.drain();
    if (sources.length === 0) {
      break;
    }
    statistics.rounds = round;

    // Target pruning: nothing arriving later than the best known destination
    // arrival can improve the answer, so the effective horizon tightens as the
    // search progresses.
    const pruneAt = Math.min(horizon, bestDestinationArrival(labels, query.destinations));

    const queue = collectPatternQueue(network, sources);
    for (const [pattern, startPosition] of queue) {
      statistics.patternScans += 1;
      scanPattern(
        network,
        scanner,
        labels,
        marked,
        round,
        pattern,
        startPosition,
        query,
        pruneAt,
        permitted,
        statistics,
      );
    }

    const improvedByRide = marked.values().slice();
    const outcome = relaxFootpaths(
      labels,
      network.transfers,
      round,
      improvedByRide,
      marked,
      pruneAt,
    );
    statistics.footpathsExamined += outcome.examined;
    statistics.labelsImproved += outcome.improved;
  }

  return { labels, scanner, query, statistics };
}

/**
 * Builds the round's scan queue: each pattern paired with the earliest
 * position at which one of the improved stops reaches it.
 *
 * Boarding a pattern later than necessary can never produce a better arrival,
 * so only the earliest position matters. Patterns come back in ascending index
 * order, which makes the scan order independent of how the marked stops were
 * discovered.
 */
export function collectPatternQueue(
  network: Network,
  sources: readonly StopIndex[],
): Array<[PatternIndex, number]> {
  const earliest = new Map<PatternIndex, number>();

  for (const stop of sources) {
    for (const pattern of network.patternsAt(stop)) {
      const record = network.patternAt(pattern);
      const position = record.stops.indexOf(stop);
      if (position === -1) {
        continue;
      }
      const existing = earliest.get(pattern);
      if (existing === undefined || position < existing) {
        earliest.set(pattern, position);
      }
    }
  }

  return Array.from(earliest.entries()).sort(([a], [b]) => a - b);
}

/**
 * Rides one pattern forward from `startPosition`, recording arrivals and
 * upgrading to an earlier trip wherever one can be caught.
 *
 * The upgrade check is what keeps the scan linear. Having boarded a trip, the
 * scan only re-queries the timetable at a stop where the previous round's
 * label would have allowed catching something earlier; everywhere else it
 * simply reads the trip it is already on.
 */
function scanPattern(
  network: Network,
  scanner: DayScanner,
  labels: LabelSet,
  marked: MarkedStops,
  round: number,
  pattern: PatternIndex,
  startPosition: number,
  query: JourneyQuery,
  pruneAt: number,
  permitted: ((tripId: string) => boolean) | undefined,
  statistics: { tripLookups: number; labelsImproved: number },
): void {
  const record: RoutePattern = network.patternAt(pattern);
  const timetable = network.timetableFor(pattern);
  if (timetable.tripCount === 0) {
    return;
  }

  /** The trip currently being ridden, if any, and where it was boarded. */
  let boarded:
    | {
        trip: TripIndex;
        anchor: DayAnchor;
        from: StopIndex;
        fromPosition: number;
        departure: number;
      }
    | undefined;

  for (let position = startPosition; position < record.stops.length; position += 1) {
    const stop = record.stops[position] as StopIndex;

    // Alight, if we are aboard something and this stop permits it.
    if (boarded !== undefined && allowsAlightingAt(record, position)) {
      const arrival = scanner.arrivalOf(timetable, boarded.anchor, boarded.trip, position);
      if (arrival <= pruneAt && arrival < labels.bestArrivalAt(stop)) {
        const changed = labels.improve(round, stop, arrival, {
          kind: "ride",
          pattern,
          trip: boarded.trip,
          anchor: boarded.anchor,
          from: boarded.from,
          fromPosition: boarded.fromPosition,
          toPosition: position,
          departure: boarded.departure,
          arrival,
        });
        if (changed) {
          statistics.labelsImproved += 1;
          marked.add(stop);
        }
      }
    }

    if (!allowsBoardingAt(record, position)) {
      continue;
    }

    // The time at which a passenger standing here in the previous round could
    // be ready to board. Origins pay no transfer slack; anyone who arrived by
    // vehicle or on foot does.
    const previous = labels.arrivalAt(round - 1, stop);
    if (previous === UNREACHED) {
      continue;
    }
    const previousLeg = labels.legAt(round - 1, stop);
    const slack = previousLeg !== undefined && previousLeg.kind === "access" ? 0 : query.minTransferSeconds;
    const readyAt = previous + slack;

    // Only look for a better trip when one could actually be caught earlier
    // than the one already boarded.
    if (boarded !== undefined && readyAt >= boarded.departure) {
      continue;
    }

    statistics.tripLookups += 1;
    const candidate = scanner.earliestBoarding(timetable, position, readyAt, permitted);
    if (candidate === undefined) {
      continue;
    }
    if (boarded === undefined || candidate.departure < boarded.departure) {
      boarded = {
        trip: candidate.trip,
        anchor: candidate.anchor,
        from: stop,
        fromPosition: position,
        departure: candidate.departure,
      };
    }
  }
}
