/**
 * One-to-many reachability.
 *
 * "Where can I get to from here in 30 minutes" is the same computation as a
 * journey search with the destination removed. RAPTOR already produces it: the
 * label set after the final round holds the earliest arrival at *every* stop,
 * so the answer is a projection of state the engine computed anyway.
 *
 * The only thing that changes is pruning. A journey search tightens its
 * horizon as soon as it reaches the destination; a reachability search has no
 * destination, so the time budget is the only bound and it has to be enforced
 * from the start.
 */

import { QueryError } from "../errors.js";
import type { ServiceDate } from "../time/date.js";
import { timeOfDay, type TimeOfDay } from "../time/time-of-day.js";
import type { StopIndex } from "../model/ids.js";
import type { Network } from "../model/network.js";
import { UNREACHED } from "../routing/labels.js";
import type { JourneyQuery, PlaceRequest } from "../routing/query.js";
import { resolvePlace } from "../routing/query.js";
import { runRaptor } from "../routing/raptor.js";

/** What a reachability search asks for. */
export interface ReachRequest {
  readonly from: PlaceRequest;
  readonly date: ServiceDate;
  readonly departAfter: TimeOfDay | string;
  /** Time budget, in seconds. */
  readonly budgetSeconds: number;
  /** Maximum vehicle boardings. Defaults to 3. */
  readonly maxBoardings?: number;
  /** Seconds needed between alighting and boarding again. */
  readonly minTransferSeconds?: number;
}

/** One stop the search reached. */
export interface ReachedStop {
  readonly stop: StopIndex;
  readonly stopId: string;
  readonly stopName: string;
  /** Seconds from the requested departure to arriving here. */
  readonly seconds: number;
  /** Vehicle boardings used to get here. */
  readonly boardings: number;
  readonly latitude: number;
  readonly longitude: number;
}

/** The outcome of a reachability search. */
export interface ReachResult {
  readonly origin: string;
  readonly date: ServiceDate;
  readonly departAfter: TimeOfDay;
  readonly budgetSeconds: number;
  /** Stops reached inside the budget, ascending by travel time. */
  readonly reached: readonly ReachedStop[];
}

/** Default maximum vehicle boardings for a reachability search. */
export const DEFAULT_REACH_BOARDINGS = 3;

/**
 * Computes every stop reachable inside a time budget.
 *
 * @throws {QueryError} if the budget is not a positive integer number of
 * seconds.
 */
export function computeReach(network: Network, request: ReachRequest): ReachResult {
  if (!Number.isInteger(request.budgetSeconds) || request.budgetSeconds <= 0) {
    throw new QueryError("budget must be a positive integer number of seconds", {
      budgetSeconds: request.budgetSeconds,
    });
  }

  const origins = resolvePlace(network, request.from, "from");
  const departAfter =
    typeof request.departAfter === "string"
      ? // Reuse the same parse the journey query uses, so both accept the same
        // spellings of a time.
        parseDepartAfter(request.departAfter)
      : request.departAfter;

  const query: JourneyQuery = {
    origins,
    // No destination: the search runs to the budget and stops.
    destinations: [],
    date: request.date,
    departAfter,
    maxBoardings: request.maxBoardings ?? DEFAULT_REACH_BOARDINGS,
    minTransferSeconds: request.minTransferSeconds ?? 60,
    maxJourneySeconds: request.budgetSeconds,
    allowedRouteTypes: undefined,
    requireWheelchair: false,
    requireBikes: false,
  };

  const search = runRaptor(network, query);
  const deadline = departAfter + request.budgetSeconds;
  const reached: ReachedStop[] = [];

  for (const stop of network.stops.boardableIndices()) {
    const best = search.labels.bestArrivalAt(stop);
    if (best === UNREACHED || best > deadline) {
      continue;
    }
    const coordinate = network.stops.coordinateAt(stop);
    if (coordinate === undefined) {
      continue;
    }
    reached.push({
      stop,
      stopId: network.stops.idAt(stop),
      stopName: network.stops.labelAt(stop),
      seconds: best - departAfter,
      boardings: roundReaching(search.labels, stop, best),
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    });
  }

  reached.sort((a, b) => a.seconds - b.seconds || a.stopId.localeCompare(b.stopId));

  return {
    origin: describeOrigin(network, origins.map((point) => point.stop)),
    date: request.date,
    departAfter,
    budgetSeconds: request.budgetSeconds,
    reached,
  };
}

/**
 * The number of stops reachable within each of a series of budgets.
 *
 * One search covers every budget, because a stop reachable in ten minutes is
 * reachable in twenty. Budgets are sorted ascending and deduplicated.
 */
export function reachProfile(
  result: ReachResult,
  budgets: readonly number[],
): Array<{ budgetSeconds: number; stops: number }> {
  const sorted = Array.from(new Set(budgets)).sort((a, b) => a - b);
  return sorted.map((budgetSeconds) => ({
    budgetSeconds,
    stops: result.reached.filter((entry) => entry.seconds <= budgetSeconds).length,
  }));
}

/** The stops reachable within a budget shorter than the search's own. */
export function within(result: ReachResult, budgetSeconds: number): ReachedStop[] {
  return result.reached.filter((entry) => entry.seconds <= budgetSeconds);
}

/** The furthest stop reached, by travel time. */
export function furthestStop(result: ReachResult): ReachedStop | undefined {
  return result.reached[result.reached.length - 1];
}

/** The lowest round in which a stop attained its best arrival. */
function roundReaching(
  labels: { maxRound: number; arrivalAt: (round: number, stop: StopIndex) => number },
  stop: StopIndex,
  best: number,
): number {
  for (let round = 0; round <= labels.maxRound; round += 1) {
    if (labels.arrivalAt(round, stop) === best) {
      return round;
    }
  }
  return labels.maxRound;
}

function describeOrigin(network: Network, stops: readonly StopIndex[]): string {
  const first = stops[0];
  if (first === undefined) {
    return "";
  }
  return stops.length === 1
    ? network.stops.idAt(first)
    : `${network.stops.idAt(first)} (+${stops.length - 1} more)`;
}

function parseDepartAfter(text: string): TimeOfDay {
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) {
    throw new QueryError(`"${text}" is not a HH:MM or HH:MM:SS time`, { text });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  return timeOfDay(hours * 3600 + minutes * 60 + seconds);
}
