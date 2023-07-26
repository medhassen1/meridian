/**
 * Profile search: every distinct journey across a departure window.
 *
 * A single earliest-arrival query answers "if I leave now, when do I arrive".
 * A passenger planning a trip wants the timetable: the departures worth taking
 * over the next two hours, and what each one costs.
 *
 * Range RAPTOR gets that by running the search from each candidate departure
 * time in *descending* order. Later departures are computed first, and their
 * results prune the earlier ones — an earlier departure is only interesting if
 * it arrives strictly sooner than everything already found, or does so with
 * fewer boardings or less walking.
 *
 * Candidate departure times come from the network itself rather than from a
 * fixed step: the only departures worth starting at are the ones a vehicle
 * actually leaves an origin at, so a two-hour window on an hourly route costs
 * two searches, not a hundred and twenty.
 */

import { QueryError } from "../errors.js";
import { timeOfDay, type TimeOfDay } from "../time/time-of-day.js";
import type { Network } from "../model/network.js";
import { tripIndex, type StopIndex } from "../model/ids.js";
import { DayScanner } from "./day-scan.js";
import { compareCriteria, profileFrontier, type ProfileCriteria } from "./pareto.js";
import type { JourneyQuery } from "./query.js";
import { runRaptor, type SearchStatistics } from "./raptor.js";
import {
  extractJourneys,
  journeyKey,
  walkSeconds,
  type RawJourney,
} from "./result.js";

/** Options controlling a profile search. */
export interface ProfileOptions {
  /** Length of the departure window, in seconds. */
  readonly windowSeconds: number;
  /**
   * Largest number of departure times examined. Guards a dense network where
   * hundreds of vehicles leave an origin within the window.
   */
  readonly maxDepartures?: number;
  /** Largest number of journeys returned. */
  readonly maxJourneys?: number;
}

/** The outcome of a profile search. */
export interface ProfileResult {
  /** Journeys on the Pareto frontier, ordered for presentation. */
  readonly journeys: readonly RawJourney[];
  /** Departure times actually searched, ascending. */
  readonly departuresSearched: readonly number[];
  /** Work performed, summed across every underlying search. */
  readonly statistics: SearchStatistics;
}

/** Default cap on the number of departure times examined. */
export const DEFAULT_MAX_DEPARTURES = 60;

/** Default cap on the number of journeys returned. */
export const DEFAULT_MAX_JOURNEYS = 12;

/**
 * Runs a profile search over a departure window.
 *
 * @throws {QueryError} if the window is not a positive integer number of
 * seconds.
 */
export function runRangeRaptor(
  network: Network,
  query: JourneyQuery,
  options: ProfileOptions,
): ProfileResult {
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds <= 0) {
    throw new QueryError("profile window must be a positive integer number of seconds", {
      windowSeconds: options.windowSeconds,
    });
  }
  const maxDepartures = options.maxDepartures ?? DEFAULT_MAX_DEPARTURES;
  const maxJourneys = options.maxJourneys ?? DEFAULT_MAX_JOURNEYS;

  const departures = candidateDepartures(network, query, options.windowSeconds, maxDepartures);
  const found = new Map<string, RawJourney>();
  const statistics = {
    rounds: 0,
    patternScans: 0,
    tripLookups: 0,
    footpathsExamined: 0,
    labelsImproved: 0,
  };

  // Descending, so that later departures are found first and their arrivals
  // prune the earlier searches.
  for (const departure of departures.slice().reverse()) {
    const search = runRaptor(network, { ...query, departAfter: timeOfDay(departure) });
    accumulate(statistics, search.statistics);

    for (const journey of extractJourneys(network, search)) {
      const key = journeyKey(journey);
      if (!found.has(key)) {
        found.set(key, journey);
      }
    }
  }

  const frontier = profileFrontier(Array.from(found.values()), criteriaOf);
  frontier.sort((a, b) => a.departure - b.departure || compareCriteria(criteriaOf(a), criteriaOf(b)));

  return {
    journeys: frontier.slice(0, maxJourneys),
    departuresSearched: departures,
    statistics,
  };
}

/**
 * The departure times worth starting a search at.
 *
 * Every departure from an origin stop inside the window, plus the window's own
 * start so that a journey beginning with a walk is not missed. Times are
 * returned ascending and deduplicated.
 */
export function candidateDepartures(
  network: Network,
  query: JourneyQuery,
  windowSeconds: number,
  maxDepartures: number,
): number[] {
  const start = query.departAfter;
  const end = start + windowSeconds;
  const scanner = DayScanner.build(network, query.date, end);
  const times = new Set<number>([start]);

  if (!scanner.isEmpty) {
    for (const origin of query.origins) {
      collectDeparturesAt(network, scanner, origin.stop, start, end, times);
    }
  }

  const ordered = Array.from(times).sort((a, b) => a - b);
  if (ordered.length <= maxDepartures) {
    return ordered;
  }

  // Keep the window start plus an even spread of the rest, so the profile
  // still covers the whole window when a stop is very busy.
  const kept = new Set<number>([ordered[0] as number]);
  const step = (ordered.length - 1) / (maxDepartures - 1);
  for (let index = 1; index < maxDepartures; index += 1) {
    kept.add(ordered[Math.min(ordered.length - 1, Math.round(index * step))] as number);
  }
  return Array.from(kept).sort((a, b) => a - b);
}

/** Adds every absolute departure from one stop inside a window. */
function collectDeparturesAt(
  network: Network,
  scanner: DayScanner,
  stop: StopIndex,
  start: number,
  end: number,
  into: Set<number>,
): void {
  for (const pattern of network.patternsAt(stop)) {
    const record = network.patternAt(pattern);
    const timetable = network.timetableFor(pattern);

    for (let position = 0; position < record.stops.length - 1; position += 1) {
      if (record.stops[position] !== stop) {
        continue;
      }
      for (const anchor of scanner.anchorList()) {
        for (let trip = 0; trip < timetable.tripCount; trip += 1) {
          const index = tripIndex(trip);
          if (!anchor.activeServices.has(timetable.serviceIdAt(index))) {
            continue;
          }
          const departure = scanner.toAbsolute(anchor, timetable.departureAt(index, position));
          if (departure >= start && departure <= end) {
            into.add(departure);
          }
        }
      }
    }
  }
}

/** Criteria used to build the profile's Pareto frontier. */
export function criteriaOf(journey: RawJourney): ProfileCriteria {
  return {
    arrival: journey.arrival,
    boardings: journey.boardings,
    departure: journey.departure,
    walkSeconds: walkSeconds(journey),
  };
}

/**
 * The distinct departure times of the journeys in a profile, ascending.
 *
 * This is the "next departures" list a passenger actually reads.
 */
export function departureBoard(result: ProfileResult): TimeOfDay[] {
  const times = new Set<number>();
  for (const journey of result.journeys) {
    times.add(journey.departure);
  }
  return Array.from(times)
    .sort((a, b) => a - b)
    .filter((value) => value >= 0)
    .map((value) => timeOfDay(value));
}

function accumulate(into: SearchStatistics, from: SearchStatistics): void {
  const target = into as {
    rounds: number;
    patternScans: number;
    tripLookups: number;
    footpathsExamined: number;
    labelsImproved: number;
  };
  target.rounds += from.rounds;
  target.patternScans += from.patternScans;
  target.tripLookups += from.tripLookups;
  target.footpathsExamined += from.footpathsExamined;
  target.labelsImproved += from.labelsImproved;
}
