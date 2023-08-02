/**
 * Ordering and filtering itineraries.
 *
 * Two different jobs live here and they must not be conflated. Dominance
 * decides which itineraries are worth showing at all; ordering decides the
 * sequence they appear in. Ordering has to be *total* — every pair must
 * compare unequal unless the journeys are genuinely identical — because
 * results are compared byte for byte in tests and in downstream diffs, and a
 * comparator with ties leaves the output at the mercy of the sort's internals.
 */

import { paretoFrontier, type Criteria } from "../routing/pareto.js";
import type { Itinerary } from "./itinerary.js";
import { measureJourney } from "./metrics.js";
import { isRide, type JourneyLeg } from "./leg.js";

/** How a list of itineraries should be ordered. */
export type SortOrder = "arrival" | "departure" | "duration" | "transfers" | "walking";

/** The criteria an itinerary is compared on. */
export function criteriaOfItinerary(itinerary: Itinerary): Criteria {
  const metrics = measureJourney(itinerary);
  return {
    arrival: itinerary.arrival,
    boardings: itinerary.boardings,
    walkSeconds: metrics.walkSeconds,
  };
}

/**
 * A tie-breaking key that distinguishes two itineraries with identical
 * criteria.
 *
 * Built from the leg structure, so two journeys that differ only in which
 * route they use still order deterministically.
 */
export function tieBreakKey(itinerary: Itinerary): string {
  const parts: string[] = [];
  for (const leg of itinerary.legs) {
    parts.push(legKey(leg));
  }
  return parts.join(">");
}

/** Total ordering by soonest arrival, then fewest boardings, then structure. */
export function compareByArrival(a: Itinerary, b: Itinerary): number {
  return (
    a.arrival - b.arrival ||
    a.boardings - b.boardings ||
    a.totalSeconds - b.totalSeconds ||
    tieBreakKey(a).localeCompare(tieBreakKey(b))
  );
}

/** Total ordering by latest departure, which suits an arrive-by view. */
export function compareByDeparture(a: Itinerary, b: Itinerary): number {
  return (
    b.departure - a.departure ||
    a.arrival - b.arrival ||
    a.boardings - b.boardings ||
    tieBreakKey(a).localeCompare(tieBreakKey(b))
  );
}

/** Total ordering by shortest elapsed time. */
export function compareByDuration(a: Itinerary, b: Itinerary): number {
  return (
    a.totalSeconds - b.totalSeconds ||
    a.boardings - b.boardings ||
    a.arrival - b.arrival ||
    tieBreakKey(a).localeCompare(tieBreakKey(b))
  );
}

/** Total ordering by fewest changes, then by arrival. */
export function compareByTransfers(a: Itinerary, b: Itinerary): number {
  return (
    a.transfers - b.transfers ||
    a.arrival - b.arrival ||
    a.totalSeconds - b.totalSeconds ||
    tieBreakKey(a).localeCompare(tieBreakKey(b))
  );
}

/** Total ordering by least walking, then by arrival. */
export function compareByWalking(a: Itinerary, b: Itinerary): number {
  const left = measureJourney(a).walkSeconds;
  const right = measureJourney(b).walkSeconds;
  return (
    left - right ||
    a.arrival - b.arrival ||
    a.boardings - b.boardings ||
    tieBreakKey(a).localeCompare(tieBreakKey(b))
  );
}

/** The comparator for a named order. */
export function comparatorFor(order: SortOrder): (a: Itinerary, b: Itinerary) => number {
  switch (order) {
    case "arrival":
      return compareByArrival;
    case "departure":
      return compareByDeparture;
    case "duration":
      return compareByDuration;
    case "transfers":
      return compareByTransfers;
    case "walking":
      return compareByWalking;
  }
}

/** Returns a sorted copy; the input is not modified. */
export function sortItineraries(
  itineraries: readonly Itinerary[],
  order: SortOrder = "arrival",
): Itinerary[] {
  return itineraries.slice().sort(comparatorFor(order));
}

/**
 * Reduces a list to the itineraries no other itinerary beats outright.
 *
 * Applied after sorting so that, among equals, the one the caller's chosen
 * order prefers survives.
 */
export function bestItineraries(
  itineraries: readonly Itinerary[],
  order: SortOrder = "arrival",
): Itinerary[] {
  return paretoFrontier(sortItineraries(itineraries, order), criteriaOfItinerary);
}

/**
 * Removes itineraries that repeat an earlier one's structure.
 *
 * Two journeys using the same routes between the same stops at the same times
 * are the same journey however they were found.
 */
export function deduplicateItineraries(itineraries: readonly Itinerary[]): Itinerary[] {
  const seen = new Set<string>();
  const unique: Itinerary[] = [];
  for (const itinerary of itineraries) {
    const key = `${itinerary.departure}|${itinerary.arrival}|${tieBreakKey(itinerary)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(itinerary);
  }
  return unique;
}

function legKey(leg: JourneyLeg): string {
  if (isRide(leg)) {
    return `r:${leg.routeId}:${leg.tripId}:${leg.fromStopId}:${leg.toStopId}`;
  }
  switch (leg.kind) {
    case "access":
      return `a:${leg.toStopId}:${leg.seconds}`;
    case "walk":
      return `w:${leg.fromStopId}:${leg.toStopId}:${leg.seconds}`;
    case "egress":
      return `e:${leg.fromStopId}:${leg.seconds}`;
  }
}
