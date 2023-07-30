/**
 * Journey legs as a caller sees them.
 *
 * The engine's internal legs carry indices and back-pointers; these carry
 * names, ids, and times. The translation happens once, when an itinerary is
 * built, so nothing downstream has to hold a network to render a result.
 *
 * Times are *absolute seconds*, measured from midnight of the query date. They
 * may be negative — a journey beginning at 00:10 can board a vehicle that left
 * at 23:50 the evening before — and they may exceed 86400. Formatting handles
 * both, because silently clamping either end would misstate the day a
 * passenger travels on.
 */

import { SECONDS_PER_DAY, ServiceDate } from "../time/date.js";
import { formatDuration, duration } from "../time/duration.js";

/** What kind of movement a leg represents. */
export type LegKind = "access" | "ride" | "walk" | "egress";

/** Fields every leg carries. */
export interface LegBase {
  readonly kind: LegKind;
  /** Absolute departure, in seconds from midnight of the query date. */
  readonly departure: number;
  /** Absolute arrival. */
  readonly arrival: number;
  /** Elapsed seconds; always `arrival - departure`. */
  readonly seconds: number;
}

/** The walk from the requested origin to the first stop. */
export interface AccessLeg extends LegBase {
  readonly kind: "access";
  readonly toStopId: string;
  readonly toStopName: string;
}

/** A stop called at while aboard a vehicle. */
export interface IntermediateCall {
  readonly stopId: string;
  readonly stopName: string;
  readonly arrival: number;
  readonly departure: number;
}

/** A ride aboard one vehicle. */
export interface RideLeg extends LegBase {
  readonly kind: "ride";
  readonly routeId: string;
  /** The route's display name. */
  readonly routeName: string;
  /** The route's GTFS `route_type`. */
  readonly routeType: number;
  readonly tripId: string;
  readonly headsign: string | undefined;
  readonly fromStopId: string;
  readonly fromStopName: string;
  readonly toStopId: string;
  readonly toStopName: string;
  /** The service date the vehicle's run is anchored to. */
  readonly serviceDate: ServiceDate;
  /** Stops passed through between boarding and alighting, in order. */
  readonly intermediateStops: readonly IntermediateCall[];
  /**
   * Seconds a rider is expected to wait when the trip is headway-based, or
   * zero when its times are exact.
   */
  readonly expectedWaitSeconds: number;
}

/** A walk between two stops mid-journey. */
export interface WalkLeg extends LegBase {
  readonly kind: "walk";
  readonly fromStopId: string;
  readonly fromStopName: string;
  readonly toStopId: string;
  readonly toStopName: string;
  /** True when the walk came from `transfers.txt` rather than from geometry. */
  readonly published: boolean;
}

/** The walk from the last stop to the requested destination. */
export interface EgressLeg extends LegBase {
  readonly kind: "egress";
  readonly fromStopId: string;
  readonly fromStopName: string;
}

/** One step of a journey. */
export type JourneyLeg = AccessLeg | RideLeg | WalkLeg | EgressLeg;

/** True when the leg puts the passenger aboard a vehicle. */
export function isRide(leg: JourneyLeg): leg is RideLeg {
  return leg.kind === "ride";
}

/** True when the leg is travelled on foot. */
export function isOnFoot(leg: JourneyLeg): boolean {
  return leg.kind !== "ride";
}

/** The stop a leg starts from, or `undefined` for an access leg. */
export function originStopIdOf(leg: JourneyLeg): string | undefined {
  return leg.kind === "access" ? undefined : leg.fromStopId;
}

/** The stop a leg ends at, or `undefined` for an egress leg. */
export function destinationStopIdOf(leg: JourneyLeg): string | undefined {
  return leg.kind === "egress" ? undefined : leg.toStopId;
}

/**
 * Renders an absolute time as a wall clock time, with a day marker when it
 * falls outside the query date.
 *
 * `-600` renders as `23:50 (-1d)` and `90000` as `01:00 (+1d)`, which is what
 * a passenger needs in order to catch the right vehicle.
 */
export function formatAbsoluteTime(seconds: number): string {
  const dayOffset = Math.floor(seconds / SECONDS_PER_DAY);
  const withinDay = seconds - dayOffset * SECONDS_PER_DAY;
  const hours = Math.floor(withinDay / 3600);
  const minutes = Math.floor((withinDay % 3600) / 60);
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  if (dayOffset === 0) {
    return clock;
  }
  return `${clock} (${dayOffset > 0 ? "+" : ""}${dayOffset}d)`;
}

/** The calendar date an absolute time falls on, relative to the query date. */
export function dateOfAbsoluteTime(queryDate: ServiceDate, seconds: number): ServiceDate {
  return queryDate.addDays(Math.floor(seconds / SECONDS_PER_DAY));
}

/** A one-line description of a leg, used by the text renderer. */
export function describeLeg(leg: JourneyLeg): string {
  const window = `${formatAbsoluteTime(leg.departure)}-${formatAbsoluteTime(leg.arrival)}`;
  const elapsed = formatDuration(duration(Math.max(0, leg.seconds)));

  switch (leg.kind) {
    case "access":
      return `${window} walk ${elapsed} to ${leg.toStopName}`;
    case "ride": {
      const headsign = leg.headsign === undefined ? "" : ` towards ${leg.headsign}`;
      return `${window} ${leg.routeName}${headsign} from ${leg.fromStopName} to ${leg.toStopName} (${elapsed})`;
    }
    case "walk":
      return `${window} walk ${elapsed} from ${leg.fromStopName} to ${leg.toStopName}`;
    case "egress":
      return `${window} walk ${elapsed} from ${leg.fromStopName}`;
  }
}
