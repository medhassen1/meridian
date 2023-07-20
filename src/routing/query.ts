/**
 * Journey queries: what a caller asks for, and what the engine actually runs.
 *
 * A request names places by stop id or by coordinate and states preferences in
 * human units. A query is the normalised form: dense stop indices, absolute
 * second counts, and every default already resolved. Normalising once, up
 * front, means the engine never has to decide what an omitted option meant.
 */

import { QueryError } from "../errors.js";
import { ServiceDate } from "../time/date.js";
import { parseTimeOfDay, type TimeOfDay } from "../time/time-of-day.js";
import { walkingSeconds } from "../geo/distance.js";
import type { Coordinate } from "../geo/coordinate.js";
import { RouteType } from "../feed/routes.js";
import type { Network } from "../model/network.js";
import type { StopIndex } from "../model/ids.js";

/** A place a journey starts or ends, once resolved to the network. */
export interface AccessPoint {
  readonly stop: StopIndex;
  /** Seconds spent reaching this stop from the requested place. */
  readonly seconds: number;
}

/** A place named by the caller. */
export type PlaceRequest =
  | { readonly kind: "stop"; readonly stopId: string }
  | { readonly kind: "coordinate"; readonly at: Coordinate; readonly maxWalkMetres?: number };

/** What a caller asks for. */
export interface JourneyRequest {
  readonly from: PlaceRequest;
  readonly to: PlaceRequest;
  /** Service date the search is anchored to. */
  readonly date: ServiceDate;
  /** Earliest departure, as `HH:MM:SS` or a resolved time of day. */
  readonly departAfter: TimeOfDay | string;
  /** Maximum number of vehicle boardings. Defaults to 4. */
  readonly maxBoardings?: number;
  /** Seconds a passenger needs between alighting and boarding again. */
  readonly minTransferSeconds?: number;
  /** Longest acceptable journey, in seconds. Defaults to 6 hours. */
  readonly maxJourneySeconds?: number;
  /** When set, only these modes may be used. */
  readonly allowedRouteTypes?: readonly RouteType[];
  /** When true, only wheelchair-accessible trips may be used. */
  readonly requireWheelchair?: boolean;
  /** When true, only trips carrying bicycles may be used. */
  readonly requireBikes?: boolean;
}

/** The normalised form the engine runs. */
export interface JourneyQuery {
  readonly origins: readonly AccessPoint[];
  readonly destinations: readonly AccessPoint[];
  readonly date: ServiceDate;
  readonly departAfter: TimeOfDay;
  readonly maxBoardings: number;
  readonly minTransferSeconds: number;
  readonly maxJourneySeconds: number;
  readonly allowedRouteTypes: ReadonlySet<RouteType> | undefined;
  readonly requireWheelchair: boolean;
  readonly requireBikes: boolean;
}

/** Default maximum number of vehicle boardings. */
export const DEFAULT_MAX_BOARDINGS = 4;

/** Default seconds needed between alighting and boarding again. */
export const DEFAULT_MIN_TRANSFER_SECONDS = 60;

/** Default longest acceptable journey, in seconds. */
export const DEFAULT_MAX_JOURNEY_SECONDS = 6 * 3600;

/** Default radius searched around a coordinate for access stops, in metres. */
export const DEFAULT_ACCESS_RADIUS_METRES = 800;

/** Largest number of stops a coordinate may resolve to. */
export const MAX_ACCESS_STOPS = 12;

/** Walking speed used for access and egress legs, in metres per second. */
export const ACCESS_WALK_SPEED = 1.3;

/**
 * Normalises a request against a network.
 *
 * @throws {QueryError} if a place resolves to no stop, if the two ends resolve
 * to the same single stop, or if a numeric option is out of range.
 * @throws {UnknownStopError} if a named stop is not in the network.
 */
export function normaliseQuery(network: Network, request: JourneyRequest): JourneyQuery {
  const origins = resolvePlace(network, request.from, "from");
  const destinations = resolvePlace(network, request.to, "to");

  const originStops = new Set(origins.map((point) => point.stop));
  if (destinations.every((point) => originStops.has(point.stop)) && destinations.length > 0) {
    throw new QueryError("the origin and destination resolve to the same stops", {
      origins: origins.map((point) => network.stops.idAt(point.stop)),
    });
  }

  const departAfter =
    typeof request.departAfter === "string"
      ? parseTimeOfDay(request.departAfter)
      : request.departAfter;

  const maxBoardings = request.maxBoardings ?? DEFAULT_MAX_BOARDINGS;
  if (!Number.isInteger(maxBoardings) || maxBoardings < 1) {
    throw new QueryError("maxBoardings must be a positive integer", { maxBoardings });
  }

  const minTransferSeconds = request.minTransferSeconds ?? DEFAULT_MIN_TRANSFER_SECONDS;
  if (!Number.isInteger(minTransferSeconds) || minTransferSeconds < 0) {
    throw new QueryError("minTransferSeconds must be a non-negative integer", {
      minTransferSeconds,
    });
  }

  const maxJourneySeconds = request.maxJourneySeconds ?? DEFAULT_MAX_JOURNEY_SECONDS;
  if (!Number.isInteger(maxJourneySeconds) || maxJourneySeconds < 1) {
    throw new QueryError("maxJourneySeconds must be a positive integer", { maxJourneySeconds });
  }

  return {
    origins,
    destinations,
    date: request.date,
    departAfter,
    maxBoardings,
    minTransferSeconds,
    maxJourneySeconds,
    allowedRouteTypes:
      request.allowedRouteTypes === undefined ? undefined : new Set(request.allowedRouteTypes),
    requireWheelchair: request.requireWheelchair ?? false,
    requireBikes: request.requireBikes ?? false,
  };
}

/**
 * Resolves a place to the stops a journey may start from or end at.
 *
 * A named station expands to its platforms, because a passenger asked to
 * depart from "Central" does not care which one and a search that picks one
 * arbitrarily will miss journeys. A coordinate expands to the nearest walkable
 * stops, each with its own access time.
 */
export function resolvePlace(
  network: Network,
  place: PlaceRequest,
  label: string,
): AccessPoint[] {
  if (place.kind === "stop") {
    const index = network.requireStop(place.stopId);
    const points = network.stops.boardingPointsOf(index);
    if (points.length === 0) {
      throw new QueryError(`${label} stop "${place.stopId}" cannot be boarded`, {
        stopId: place.stopId,
      });
    }
    return points.map((stop) => ({ stop, seconds: 0 }));
  }

  const radius = place.maxWalkMetres ?? DEFAULT_ACCESS_RADIUS_METRES;
  const matches = network.stops
    .nearby(place.at, radius)
    .filter((match) => network.stops.isBoardable(match.value))
    .slice(0, MAX_ACCESS_STOPS);

  if (matches.length === 0) {
    throw new QueryError(`no boardable stop within ${radius} m of the ${label} coordinate`, {
      latitude: place.at.latitude,
      longitude: place.at.longitude,
      radius,
    });
  }

  return matches.map((match) => ({
    stop: match.value,
    seconds: walkingSeconds(match.distanceMetres, ACCESS_WALK_SPEED),
  }));
}

/**
 * True when a trip may be used under the query's mode and accessibility
 * filters.
 *
 * Accessibility is checked strictly: a trip whose accessibility is *unknown*
 * is excluded when the query requires it. Returning a journey a wheelchair
 * user cannot take is a worse failure than returning none.
 */
export function tripPermitted(network: Network, query: JourneyQuery, tripId: string): boolean {
  const trip = network.tripFor(tripId);
  if (trip === undefined) {
    return false;
  }
  if (query.requireWheelchair && trip.wheelchairAccessible !== 1) {
    return false;
  }
  if (query.requireBikes && trip.bikesAllowed !== 1) {
    return false;
  }
  if (query.allowedRouteTypes !== undefined) {
    const route = network.feed.routeById.get(trip.routeId);
    if (route === undefined || !query.allowedRouteTypes.has(route.routeType)) {
      return false;
    }
  }
  return true;
}

/**
 * True when the query's filters can exclude any trip at all.
 *
 * When nothing is filtered the engine skips the per-trip check entirely, which
 * matters because it sits in the pattern scan.
 */
export function hasTripFilters(query: JourneyQuery): boolean {
  return (
    query.requireWheelchair || query.requireBikes || query.allowedRouteTypes !== undefined
  );
}

/** The latest absolute time a journey may arrive at and still be accepted. */
export function searchHorizon(query: JourneyQuery): number {
  return query.departAfter + query.maxJourneySeconds;
}
