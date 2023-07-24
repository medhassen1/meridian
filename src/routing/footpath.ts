/**
 * Footpath relaxation.
 *
 * After each RAPTOR round the stops just improved are extended on foot, so
 * that the next round can board a pattern at a neighbouring stop rather than
 * only at the one the vehicle reached. Correctness depends on two rules that
 * are easy to get subtly wrong.
 *
 * A walk may not follow another walk within one round. Chaining them would let
 * the search cross the city on foot in a single relaxation, and it is the
 * reason the transfer graph is transitively closed at build time instead.
 *
 * A walk arriving at a stop does not permit an immediate boarding there for
 * free. The transfer slack still applies, and it is applied at boarding time
 * rather than here, so that a passenger who merely passes through a stop is
 * not charged for it.
 */

import type { StopIndex } from "../model/ids.js";
import type { TransferGraph } from "../model/transfer-graph.js";
import { LabelSet, MarkedStops, UNREACHED } from "./labels.js";

/** What one relaxation pass did. */
export interface RelaxationOutcome {
  /** Stops whose label improved. */
  readonly improved: number;
  /** Footpaths considered. */
  readonly examined: number;
}

/**
 * Extends every stop improved in `round` along its outgoing footpaths.
 *
 * Only stops present in `sources` are relaxed, and only their *direct*
 * neighbours are reached, so the pass cannot chain walks. Newly improved stops
 * are added to `marked` for the next round's pattern scan but are not relaxed
 * again here.
 *
 * @param horizon Absolute time past which an arrival is not worth recording.
 */
export function relaxFootpaths(
  labels: LabelSet,
  transfers: TransferGraph,
  round: number,
  sources: readonly StopIndex[],
  marked: MarkedStops,
  horizon: number,
): RelaxationOutcome {
  let improved = 0;
  let examined = 0;

  for (const from of sources) {
    const departure = labels.arrivalAt(round, from);
    if (departure === UNREACHED) {
      continue;
    }
    // A stop reached *by* a walk must not be walked from again in the same
    // round; the closed transfer graph already contains the composite path.
    const leg = labels.legAt(round, from);
    if (leg !== undefined && leg.kind === "walk") {
      continue;
    }

    for (const footpath of transfers.from(from)) {
      examined += 1;
      const arrival = departure + footpath.seconds;
      if (arrival > horizon || arrival >= labels.bestArrivalAt(footpath.to)) {
        continue;
      }
      const changed = labels.improve(round, footpath.to, arrival, {
        kind: "walk",
        from,
        seconds: footpath.seconds,
        departure,
        arrival,
        published: footpath.published,
      });
      if (changed) {
        improved += 1;
        marked.add(footpath.to);
      }
    }
  }

  return { improved, examined };
}

/**
 * Seeds round zero from the query's origins.
 *
 * Each origin contributes its access time, and the resulting stops are then
 * relaxed once so that a journey may begin by walking to a nearby stop. That
 * initial relaxation is the only place a walk may follow a walk — the access
 * leg is not itself a footpath — and it is what lets a coordinate origin reach
 * stops just outside its own search radius.
 */
export function seedOrigins(
  labels: LabelSet,
  transfers: TransferGraph,
  origins: ReadonlyArray<{ stop: StopIndex; seconds: number }>,
  departAfter: number,
  marked: MarkedStops,
  horizon: number,
): void {
  const seeded: StopIndex[] = [];
  for (const origin of origins) {
    const arrival = departAfter + origin.seconds;
    if (arrival > horizon) {
      continue;
    }
    const changed = labels.improve(0, origin.stop, arrival, {
      kind: "access",
      seconds: origin.seconds,
      departure: departAfter,
      arrival,
    });
    if (changed) {
      seeded.push(origin.stop);
      marked.add(origin.stop);
    }
  }
  relaxFootpaths(labels, transfers, 0, seeded, marked, horizon);
}

/**
 * The earliest arrival at any destination, including the egress walk.
 *
 * Used for target pruning: a label later than this can never improve the
 * answer, so the scan can discard it without recording it. Returns
 * {@link UNREACHED} when no destination has been reached yet.
 */
export function bestDestinationArrival(
  labels: LabelSet,
  destinations: ReadonlyArray<{ stop: StopIndex; seconds: number }>,
): number {
  let best = UNREACHED;
  for (const destination of destinations) {
    const arrival = labels.bestArrivalAt(destination.stop);
    if (arrival === UNREACHED) {
      continue;
    }
    const total = arrival + destination.seconds;
    if (total < best) {
      best = total;
    }
  }
  return best;
}
