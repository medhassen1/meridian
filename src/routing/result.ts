/**
 * Turning labels back into journeys.
 *
 * RAPTOR finishes holding arrival times and one back-pointer per stop per
 * round. Reconstruction walks those pointers backwards from a destination to
 * an origin, which produces the legs in reverse and requires care in two
 * places.
 *
 * The round has to be tracked alongside the stop: a ride consumes a round, a
 * walk does not, and reading the wrong round's pointer yields a leg from a
 * different journey. And the walk that ends a journey has to be recognised as
 * egress rather than as an interchange, because a passenger does not wait for
 * a vehicle they are not going to board.
 */

import { RoutingError } from "../errors.js";
import type { StopIndex } from "../model/ids.js";
import type { Network } from "../model/network.js";
import { UNREACHED, type Leg } from "./labels.js";
import type { SearchResult } from "./raptor.js";
import type { AccessPoint } from "./query.js";

/** One step of a reconstructed journey, still in engine terms. */
export interface RawLeg {
  readonly leg: Leg;
  /** The stop the leg ends at. */
  readonly to: StopIndex;
  /** The round the leg was recorded in. */
  readonly round: number;
}

/** A journey as the engine reconstructed it. */
export interface RawJourney {
  /** Legs in travel order. */
  readonly legs: readonly RawLeg[];
  readonly origin: StopIndex;
  readonly destination: StopIndex;
  /** Absolute time the passenger leaves the origin. */
  readonly departure: number;
  /** Absolute time the passenger reaches the destination, including egress. */
  readonly arrival: number;
  /** Seconds spent walking from the final stop to the requested place. */
  readonly egressSeconds: number;
  /** Number of vehicle boardings. */
  readonly boardings: number;
}

/**
 * Reconstructs the best journey to each destination, one per round that
 * achieved a distinct arrival.
 *
 * Returns journeys ordered by arrival time, then by boarding count. A caller
 * wanting only the fastest takes the first; one building a Pareto set keeps
 * them all and filters with `src/journey/compare.ts`.
 */
export function extractJourneys(network: Network, search: SearchResult): RawJourney[] {
  const journeys: RawJourney[] = [];

  for (let round = 0; round <= search.labels.maxRound; round += 1) {
    for (const destination of search.query.destinations) {
      const arrival = search.labels.arrivalAt(round, destination.stop);
      if (arrival === UNREACHED) {
        continue;
      }
      const journey = reconstruct(network, search, round, destination);
      if (journey !== undefined) {
        journeys.push(journey);
      }
    }
  }

  journeys.sort(
    (a, b) => a.arrival - b.arrival || a.boardings - b.boardings || a.departure - b.departure,
  );
  return dropDuplicates(journeys);
}

/**
 * Reconstructs the single best journey, or `undefined` when no destination was
 * reached.
 */
export function extractBestJourney(
  network: Network,
  search: SearchResult,
): RawJourney | undefined {
  return extractJourneys(network, search)[0];
}

/**
 * Walks the back-pointers from one destination in one round.
 *
 * Returns `undefined` when the chain is broken, which can only happen if the
 * label set was mutated between the search and the reconstruction.
 */
function reconstruct(
  network: Network,
  search: SearchResult,
  round: number,
  destination: AccessPoint,
): RawJourney | undefined {
  const legs: RawLeg[] = [];
  let stop = destination.stop;
  let currentRound = round;

  // A journey may take at most one leg per round plus one walk per round, so
  // twice the round count is a hard ceiling on the chain length.
  const maxSteps = (search.labels.maxRound + 1) * 2 + 2;

  for (let step = 0; step < maxSteps; step += 1) {
    const leg = search.labels.legAt(currentRound, stop);
    if (leg === undefined) {
      return undefined;
    }
    legs.push({ leg, to: stop, round: currentRound });

    if (leg.kind === "access") {
      const first = legs[legs.length - 1] as RawLeg;
      const ordered = tightenLeadIn(legs.slice().reverse());
      const finalArrival = search.labels.arrivalAt(round, destination.stop) + destination.seconds;
      const start = ordered[0] as RawLeg;
      return {
        legs: ordered,
        origin: first.to,
        destination: destination.stop,
        departure: start.leg.departure,
        arrival: finalArrival,
        egressSeconds: destination.seconds,
        boardings: ordered.filter((entry) => entry.leg.kind === "ride").length,
      };
    }

    stop = leg.from;
    if (leg.kind === "ride") {
      currentRound -= 1;
      if (currentRound < 0) {
        return undefined;
      }
    }
  }

  throw new RoutingError("journey reconstruction did not terminate", {
    destination: network.stops.idAt(destination.stop),
    round,
  });
}

/**
 * Pushes the legs before the first boarding as late as they will go.
 *
 * RAPTOR seeds round zero at the query's departure time, so a reconstructed
 * journey nominally starts then — even when the first vehicle does not leave
 * for another twenty minutes. Reporting that as the departure time tells a
 * passenger to stand at a stop for twenty minutes for no reason.
 *
 * Walking backwards from the first ride and re-timing the access and transfer
 * legs to end exactly when it departs gives the real answer: the latest moment
 * the passenger can set out and still catch it. Journeys with no ride at all
 * are left alone — there is nothing to be late for.
 */
function tightenLeadIn(ordered: readonly RawLeg[]): RawLeg[] {
  const legs = ordered.slice();
  const firstRide = legs.findIndex((entry) => entry.leg.kind === "ride");
  if (firstRide <= 0) {
    return legs;
  }

  let arriveBy = (legs[firstRide] as RawLeg).leg.departure;
  for (let index = firstRide - 1; index >= 0; index -= 1) {
    const entry = legs[index] as RawLeg;
    const leg = entry.leg;
    if (leg.kind === "ride") {
      break;
    }
    const departure = arriveBy - leg.seconds;
    legs[index] = { ...entry, leg: { ...leg, departure, arrival: arriveBy } };
    arriveBy = departure;
  }
  return legs;
}

/**
 * Removes journeys that repeat an earlier one.
 *
 * Several destinations of one station routinely produce the same underlying
 * ride, and several rounds produce the same journey when a later round finds
 * no improvement. Identity is the leg sequence, which is what a passenger
 * would call "the same journey".
 */
function dropDuplicates(journeys: readonly RawJourney[]): RawJourney[] {
  const seen = new Set<string>();
  const unique: RawJourney[] = [];
  for (const journey of journeys) {
    const key = journeyKey(journey);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(journey);
  }
  return unique;
}

/** A stable identity for a journey, used for deduplication. */
export function journeyKey(journey: RawJourney): string {
  const parts: string[] = [String(journey.departure), String(journey.arrival)];
  for (const entry of journey.legs) {
    switch (entry.leg.kind) {
      case "ride":
        parts.push(
          `r${entry.leg.pattern}:${entry.leg.trip}:${entry.leg.fromPosition}:${entry.leg.toPosition}:${entry.leg.anchor.dayShift}`,
        );
        break;
      case "walk":
        parts.push(`w${entry.leg.from}:${entry.to}:${entry.leg.seconds}`);
        break;
      case "access":
        parts.push(`a${entry.to}:${entry.leg.seconds}`);
        break;
    }
  }
  return parts.join("|");
}

/** Seconds spent aboard a vehicle. */
export function rideSeconds(journey: RawJourney): number {
  let total = 0;
  for (const entry of journey.legs) {
    if (entry.leg.kind === "ride") {
      total += entry.leg.arrival - entry.leg.departure;
    }
  }
  return total;
}

/** Seconds spent walking, including access and egress. */
export function walkSeconds(journey: RawJourney): number {
  let total = journey.egressSeconds;
  for (const entry of journey.legs) {
    if (entry.leg.kind === "walk" || entry.leg.kind === "access") {
      total += entry.leg.seconds;
    }
  }
  return total;
}

/**
 * Seconds spent waiting at a stop.
 *
 * Derived rather than accumulated: total elapsed time minus time spent moving.
 * That way it stays correct however the legs were assembled.
 */
export function waitSeconds(journey: RawJourney): number {
  const elapsed = journey.arrival - journey.departure;
  return Math.max(0, elapsed - rideSeconds(journey) - walkSeconds(journey));
}
