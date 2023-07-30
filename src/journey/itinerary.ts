/**
 * Building an itinerary from the engine's raw journey.
 *
 * This is the boundary where indices become names. Everything the renderer,
 * the fare calculator, and the caller need is resolved here, once, so that a
 * result can outlive the network it came from and can be serialised without
 * further lookups.
 */

import { RoutingError } from "../errors.js";
import { SECONDS_PER_DAY, type ServiceDate } from "../time/date.js";
import { routeLabel, type Route } from "../feed/routes.js";
import type { StopIndex } from "../model/ids.js";
import { templateTripIdOf } from "../model/frequency-expansion.js";
import type { Network } from "../model/network.js";
import type { RawJourney, RawLeg } from "../routing/result.js";
import type {
  AccessLeg,
  EgressLeg,
  IntermediateCall,
  JourneyLeg,
  RideLeg,
  WalkLeg,
} from "./leg.js";

/** A complete journey, ready to render or serialise. */
export interface Itinerary {
  /** Legs in travel order; always at least one. */
  readonly legs: readonly JourneyLeg[];
  /** The service date the query was anchored to. */
  readonly date: ServiceDate;
  /** Absolute departure from the requested origin. */
  readonly departure: number;
  /** Absolute arrival at the requested destination. */
  readonly arrival: number;
  /** Total elapsed seconds. */
  readonly totalSeconds: number;
  /** Number of vehicle boardings. */
  readonly boardings: number;
  /** Number of changes between vehicles; one fewer than {@link boardings}. */
  readonly transfers: number;
}

/**
 * Builds an itinerary.
 *
 * `date` is the query date the journey's absolute times are measured from; it
 * is carried through so a renderer can turn a negative or past-86400 time back
 * into a real calendar date.
 *
 * @throws {RoutingError} if a leg references an entity the network does not
 * contain, which would mean the network changed under the search.
 */
export function buildItinerary(
  network: Network,
  journey: RawJourney,
  date: ServiceDate,
): Itinerary {
  const legs: JourneyLeg[] = [];

  for (const entry of journey.legs) {
    legs.push(convertLeg(network, entry));
  }

  if (journey.egressSeconds > 0) {
    const lastStop = lastStopOf(journey);
    const departure = journey.arrival - journey.egressSeconds;
    const egress: EgressLeg = {
      kind: "egress",
      fromStopId: network.stops.idAt(lastStop),
      fromStopName: network.stops.labelAt(lastStop),
      departure,
      arrival: journey.arrival,
      seconds: journey.egressSeconds,
    };
    legs.push(egress);
  }

  const boardings = legs.filter((leg) => leg.kind === "ride").length;

  return {
    legs,
    date,
    departure: journey.departure,
    arrival: journey.arrival,
    totalSeconds: journey.arrival - journey.departure,
    boardings,
    transfers: Math.max(0, boardings - 1),
  };
}

/** Builds an itinerary for every raw journey, preserving order. */
export function buildItineraries(
  network: Network,
  journeys: readonly RawJourney[],
  date: ServiceDate,
): Itinerary[] {
  return journeys.map((journey) => buildItinerary(network, journey, date));
}

/** The ride legs of an itinerary, in travel order. */
export function ridesOf(itinerary: Itinerary): RideLeg[] {
  return itinerary.legs.filter((leg): leg is RideLeg => leg.kind === "ride");
}

/** The stop ids an itinerary touches, in travel order, without repeats. */
export function stopSequenceOf(itinerary: Itinerary): string[] {
  const sequence: string[] = [];
  const push = (stopId: string): void => {
    if (sequence[sequence.length - 1] !== stopId) {
      sequence.push(stopId);
    }
  };
  for (const leg of itinerary.legs) {
    if (leg.kind !== "access") {
      push(leg.fromStopId);
    }
    if (leg.kind !== "egress") {
      push(leg.toStopId);
    }
  }
  return sequence;
}

/** The distinct routes an itinerary uses, in travel order. */
export function routesOf(itinerary: Itinerary): string[] {
  const routes: string[] = [];
  for (const ride of ridesOf(itinerary)) {
    if (routes[routes.length - 1] !== ride.routeId) {
      routes.push(ride.routeId);
    }
  }
  return routes;
}

/** True when the itinerary never boards a vehicle. */
export function isWalkOnly(itinerary: Itinerary): boolean {
  return itinerary.boardings === 0;
}

function convertLeg(network: Network, entry: RawLeg): JourneyLeg {
  const leg = entry.leg;

  if (leg.kind === "access") {
    const access: AccessLeg = {
      kind: "access",
      toStopId: network.stops.idAt(entry.to),
      toStopName: network.stops.labelAt(entry.to),
      departure: leg.departure,
      arrival: leg.arrival,
      seconds: leg.seconds,
    };
    return access;
  }

  if (leg.kind === "walk") {
    const walk: WalkLeg = {
      kind: "walk",
      fromStopId: network.stops.idAt(leg.from),
      fromStopName: network.stops.labelAt(leg.from),
      toStopId: network.stops.idAt(entry.to),
      toStopName: network.stops.labelAt(entry.to),
      departure: leg.departure,
      arrival: leg.arrival,
      seconds: leg.seconds,
      published: leg.published,
    };
    return walk;
  }

  const pattern = network.patternAt(leg.pattern);
  const timetable = network.timetableFor(leg.pattern);
  const tripId = timetable.tripIdAt(leg.trip);
  const route: Route | undefined = network.feed.routeById.get(pattern.routeId);
  if (route === undefined) {
    throw new RoutingError(`journey references unknown route "${pattern.routeId}"`, {
      routeId: pattern.routeId,
    });
  }

  const intermediateStops: IntermediateCall[] = [];
  for (let position = leg.fromPosition + 1; position < leg.toPosition; position += 1) {
    const stop = pattern.stops[position] as StopIndex;
    intermediateStops.push({
      stopId: network.stops.idAt(stop),
      stopName: network.stops.labelAt(stop),
      arrival: timetable.arrivalAt(leg.trip, position) - leg.anchor.dayShift * SECONDS_PER_DAY,
      departure: timetable.departureAt(leg.trip, position) - leg.anchor.dayShift * SECONDS_PER_DAY,
    });
  }

  const template = network.tripFor(tripId);
  const ride: RideLeg = {
    kind: "ride",
    routeId: route.routeId,
    routeName: routeLabel(route),
    routeType: route.routeType,
    tripId,
    headsign: template?.tripHeadsign ?? pattern.headsign,
    fromStopId: network.stops.idAt(leg.from),
    fromStopName: network.stops.labelAt(leg.from),
    toStopId: network.stops.idAt(entry.to),
    toStopName: network.stops.labelAt(entry.to),
    serviceDate: leg.anchor.date,
    intermediateStops,
    expectedWaitSeconds: expectedWaitFor(network, tripId),
    departure: leg.departure,
    arrival: leg.arrival,
    seconds: leg.arrival - leg.departure,
  };
  return ride;
}

/**
 * The expected wait for a headway-based trip.
 *
 * Reads the template's own frequency rows rather than the expansion record, so
 * an itinerary built from a network whose runs were expanded elsewhere still
 * reports the right figure.
 */
function expectedWaitFor(network: Network, tripId: string): number {
  const windows = network.frequenciesFor(templateTripIdOf(tripId));
  let longest = 0;
  for (const window of windows) {
    if (window.exactTimes === 0) {
      const wait = Math.ceil(window.headwaySecs / 2);
      if (wait > longest) {
        longest = wait;
      }
    }
  }
  return longest;
}

function lastStopOf(journey: RawJourney): StopIndex {
  const last = journey.legs[journey.legs.length - 1];
  if (last === undefined) {
    throw new RoutingError("journey has no legs");
  }
  return last.to;
}
