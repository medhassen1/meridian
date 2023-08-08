/**
 * Pricing a journey.
 *
 * The GTFS fare model prices *legs*, then lets a fare cover some number of
 * onward transfers within a time limit. Computing a journey total therefore
 * means walking the legs in order, deciding for each whether the fare already
 * paid still covers it, and starting a new fare when it does not.
 *
 * Two limits end a fare's coverage: the number of transfers it allows, and the
 * elapsed time since it was purchased. Both are optional in the data, and an
 * absent transfer count means unlimited rather than zero — a quirk of the
 * format that a naive reading gets backwards and that would silently
 * quadruple a journey's price.
 *
 * Where a journey mixes currencies no total is produced. Summing across
 * currencies would be worse than declining to answer.
 */

import { allowsUnlimitedTransfers, type FareAttribute } from "../feed/fares.js";
import type { GtfsFeed } from "../feed/feed.js";
import { ridesOf, type Itinerary } from "../journey/itinerary.js";
import type { RideLeg } from "../journey/leg.js";
import { FareMatcher, type FareableLeg } from "./matcher.js";

/** The fare charged for one leg, or the reason none was. */
export interface LegFare {
  readonly leg: RideLeg;
  /** The fare charged, or `undefined` when the leg is covered or unpriced. */
  readonly fare: FareAttribute | undefined;
  /** True when an earlier fare's transfer allowance covered this leg. */
  readonly coveredByTransfer: boolean;
  /** Amount charged for this leg, in the fare's currency. Zero when covered. */
  readonly amount: number;
}

/** What a journey costs. */
export interface JourneyFare {
  readonly legs: readonly LegFare[];
  /** Total charged, or `undefined` when the journey could not be priced. */
  readonly total: number | undefined;
  /** ISO 4217 code of the total, when there is one. */
  readonly currency: string | undefined;
  /** Why no total was produced, when there is none. */
  readonly reason: UnpricedReason | undefined;
}

/** Why a journey could not be priced. */
export type UnpricedReason =
  | "no-fares-defined"
  | "leg-without-fare"
  | "mixed-currencies"
  | "walk-only";

/**
 * Prices a journey.
 *
 * Walking-only journeys are free but are reported as unpriced rather than as
 * costing zero, because "no fare applies" and "the fare is nothing" are
 * different answers and a caller displaying a price should know which it has.
 */
export function computeFare(
  feed: GtfsFeed,
  itinerary: Itinerary,
  matcher: FareMatcher = FareMatcher.build(feed),
): JourneyFare {
  const rides = ridesOf(itinerary);
  if (rides.length === 0) {
    return { legs: [], total: undefined, currency: undefined, reason: "walk-only" };
  }
  if (matcher.isEmpty) {
    return {
      legs: rides.map((leg) => ({ leg, fare: undefined, coveredByTransfer: false, amount: 0 })),
      total: undefined,
      currency: undefined,
      reason: "no-fares-defined",
    };
  }

  const zoneByStop = buildZoneIndex(feed);
  const legFares: LegFare[] = [];

  /** The fare currently in force, and how much of its allowance is left. */
  let active: { fare: FareAttribute; purchasedAt: number; transfersUsed: number } | undefined;
  let unpriced = false;

  for (const leg of rides) {
    if (active !== undefined && coversLeg(active, leg)) {
      active.transfersUsed += 1;
      legFares.push({ leg, fare: active.fare, coveredByTransfer: true, amount: 0 });
      continue;
    }

    const match = matcher.best(describeFareableLeg(leg, zoneByStop));
    if (match === undefined) {
      unpriced = true;
      legFares.push({ leg, fare: undefined, coveredByTransfer: false, amount: 0 });
      active = undefined;
      continue;
    }

    active = { fare: match.fare, purchasedAt: leg.departure, transfersUsed: 0 };
    legFares.push({
      leg,
      fare: match.fare,
      coveredByTransfer: false,
      amount: match.fare.price,
    });
  }

  if (unpriced) {
    return {
      legs: legFares,
      total: undefined,
      currency: undefined,
      reason: "leg-without-fare",
    };
  }

  const currencies = new Set(
    legFares.map((entry) => entry.fare?.currencyType).filter((code): code is string => code !== undefined),
  );
  if (currencies.size > 1) {
    return { legs: legFares, total: undefined, currency: undefined, reason: "mixed-currencies" };
  }

  const total = legFares.reduce((sum, entry) => sum + entry.amount, 0);
  return {
    legs: legFares,
    // Rounded to the cent: repeated addition of decimal prices accumulates
    // binary representation error that would otherwise surface as 4.680000001.
    total: Math.round(total * 100) / 100,
    currency: currencies.values().next().value,
    reason: undefined,
  };
}

/**
 * True when a fare already purchased still covers a leg.
 *
 * Both limits must hold. An absent transfer count means unlimited transfers;
 * an absent duration means the fare never expires.
 */
export function coversLeg(
  active: { fare: FareAttribute; purchasedAt: number; transfersUsed: number },
  leg: RideLeg,
): boolean {
  const { fare } = active;
  if (!allowsUnlimitedTransfers(fare) && active.transfersUsed >= (fare.transfers as number)) {
    return false;
  }
  if (fare.transferDuration !== undefined) {
    if (leg.departure - active.purchasedAt > fare.transferDuration) {
      return false;
    }
  }
  return true;
}

/** Describes a ride leg in the terms the matcher understands. */
export function describeFareableLeg(
  leg: RideLeg,
  zoneByStop: ReadonlyMap<string, string>,
): FareableLeg {
  const zonesTouched = new Set<string>();
  const record = (stopId: string): void => {
    const zone = zoneByStop.get(stopId);
    if (zone !== undefined) {
      zonesTouched.add(zone);
    }
  };

  record(leg.fromStopId);
  record(leg.toStopId);
  for (const call of leg.intermediateStops) {
    record(call.stopId);
  }

  return {
    routeId: leg.routeId,
    originZoneId: zoneByStop.get(leg.fromStopId),
    destinationZoneId: zoneByStop.get(leg.toStopId),
    zonesTouched,
  };
}

/** Maps each stop id to its fare zone, where one is declared. */
export function buildZoneIndex(feed: GtfsFeed): Map<string, string> {
  const zoneByStop = new Map<string, string>();
  for (const stop of feed.stops) {
    if (stop.zoneId !== undefined) {
      zoneByStop.set(stop.stopId, stop.zoneId);
    }
  }
  return zoneByStop;
}

/**
 * Renders a price with the conventional two decimal places.
 *
 * Currency-aware formatting is deliberately out of scope: it depends on the
 * reader's locale, which the library has no business guessing.
 */
export function formatFare(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/** A one-line description of what a journey costs, or why it is unpriced. */
export function describeFare(fare: JourneyFare): string {
  if (fare.total !== undefined && fare.currency !== undefined) {
    return formatFare(fare.total, fare.currency);
  }
  switch (fare.reason) {
    case "walk-only":
      return "no fare (journey is on foot)";
    case "no-fares-defined":
      return "no fare (the feed defines none)";
    case "leg-without-fare":
      return "no fare (at least one leg has no applicable fare)";
    case "mixed-currencies":
      return "no total (legs are priced in different currencies)";
    case undefined:
      return "no fare";
  }
}
