/**
 * The high-level planning API.
 *
 * Everything below this file is composable and independently useful; this is
 * the one call most callers want. It ties the query normaliser, the search,
 * journey reconstruction, and fare computation together, and it is the surface
 * the CLI and the README examples use.
 */

import type { ServiceDate } from "./time/date.js";
import { computeFare, FareMatcher, type JourneyFare } from "./fares/index.js";
import {
  bestItineraries,
  buildItineraries,
  measureJourney,
  sortItineraries,
  type Itinerary,
  type JourneyMetrics,
  type SortOrder,
} from "./journey/index.js";
import type { Network } from "./model/network.js";
import {
  extractJourneys,
  normaliseQuery,
  runRangeRaptor,
  runRaptor,
  type JourneyRequest,
  type ProfileOptions,
  type SearchStatistics,
} from "./routing/index.js";

/** A planned journey with everything a caller normally wants. */
export interface PlannedJourney {
  readonly itinerary: Itinerary;
  readonly metrics: JourneyMetrics;
  readonly fare: JourneyFare;
}

/** The outcome of a plan. */
export interface PlanResult {
  readonly journeys: readonly PlannedJourney[];
  readonly date: ServiceDate;
  readonly statistics: SearchStatistics;
}

/** Options shared by the planning entry points. */
export interface PlanOptions {
  /** Order the results are returned in. Defaults to `"arrival"`. */
  readonly order?: SortOrder;
  /**
   * When true, only journeys on the Pareto frontier are returned. Defaults to
   * true: a passenger wants the options that are each best at something, not
   * every option the engine found.
   */
  readonly paretoOnly?: boolean;
  /** Largest number of journeys returned. Defaults to 5. */
  readonly limit?: number;
  /** When false, fares are not computed. Defaults to true. */
  readonly computeFares?: boolean;
}

/** Default number of journeys returned by {@link planJourney}. */
export const DEFAULT_PLAN_LIMIT = 5;

/**
 * Plans journeys leaving at or after a single departure time.
 *
 * @throws {QueryError} if the request is self-inconsistent.
 * @throws {UnknownStopError} if it names a stop the network does not contain.
 */
export function planJourney(
  network: Network,
  request: JourneyRequest,
  options: PlanOptions = {},
): PlanResult {
  const query = normaliseQuery(network, request);
  const search = runRaptor(network, query);
  const itineraries = buildItineraries(
    network,
    extractJourneys(network, search),
    query.date,
  );

  return {
    journeys: finalise(network, itineraries, options),
    date: query.date,
    statistics: search.statistics,
  };
}

/**
 * Plans journeys across a departure window.
 *
 * Use this when the caller is choosing *when* to travel rather than only how:
 * it returns the distinct worthwhile departures over the window rather than
 * the best journey from one moment.
 */
export function planProfile(
  network: Network,
  request: JourneyRequest,
  profile: ProfileOptions,
  options: PlanOptions = {},
): PlanResult {
  const query = normaliseQuery(network, request);
  const result = runRangeRaptor(network, query, profile);
  const itineraries = buildItineraries(network, result.journeys, query.date);

  return {
    journeys: finalise(network, itineraries, {
      // A profile's whole purpose is the spread of departure times, and the
      // frontier has already been taken inside the range search.
      paretoOnly: false,
      limit: profile.maxJourneys ?? DEFAULT_PLAN_LIMIT,
      ...options,
    }),
    date: query.date,
    statistics: result.statistics,
  };
}

/** The fastest journey, or `undefined` when none was found. */
export function fastestJourney(result: PlanResult): PlannedJourney | undefined {
  return result.journeys
    .slice()
    .sort((a, b) => a.itinerary.arrival - b.itinerary.arrival)[0];
}

/** The journey with the fewest changes, breaking ties by arrival. */
export function fewestTransfers(result: PlanResult): PlannedJourney | undefined {
  return result.journeys
    .slice()
    .sort(
      (a, b) =>
        a.itinerary.transfers - b.itinerary.transfers ||
        a.itinerary.arrival - b.itinerary.arrival,
    )[0];
}

/** True when the plan found nothing. */
export function isEmpty(result: PlanResult): boolean {
  return result.journeys.length === 0;
}

function finalise(
  network: Network,
  itineraries: readonly Itinerary[],
  options: PlanOptions,
): PlannedJourney[] {
  const order = options.order ?? "arrival";
  const selected =
    (options.paretoOnly ?? true)
      ? bestItineraries(itineraries, order)
      : sortItineraries(itineraries, order);

  const limited = selected.slice(0, options.limit ?? DEFAULT_PLAN_LIMIT);
  const matcher = (options.computeFares ?? true) ? FareMatcher.build(network.feed) : undefined;

  return limited.map((itinerary) => ({
    itinerary,
    metrics: measureJourney(itinerary),
    fare:
      matcher === undefined
        ? { legs: [], total: undefined, currency: undefined, reason: "no-fares-defined" as const }
        : computeFare(network.feed, itinerary, matcher),
  }));
}
