/**
 * Matching fare rules to a leg.
 *
 * The GTFS fare model works by elimination. A fare is a candidate for a leg
 * when every constraint its rules state is satisfied: the right route, the
 * right origin zone, the right destination zone, or a zone the leg passes
 * through. A fare with no rules at all applies to nothing, and a rule with no
 * constraints applies to everything.
 *
 * Where several fares match, the most constrained rule wins — a rule naming an
 * origin, a destination, and a route is a deliberate statement about one
 * journey, while a rule naming only a route is a default. Among equally
 * constrained rules the cheaper fare wins, and the fare id breaks any
 * remaining tie so the result never depends on table order.
 */

import { compareFareRules, type FareAttribute, type FareRule } from "../feed/fares.js";
import type { GtfsFeed } from "../feed/feed.js";

/** What a leg looks like to the fare matcher. */
export interface FareableLeg {
  readonly routeId: string;
  /** Fare zone of the boarding stop, when it has one. */
  readonly originZoneId: string | undefined;
  /** Fare zone of the alighting stop, when it has one. */
  readonly destinationZoneId: string | undefined;
  /** Fare zones of every stop the leg touches, including its ends. */
  readonly zonesTouched: ReadonlySet<string>;
}

/** A fare that could apply to a leg, and the rule that made it apply. */
export interface FareMatch {
  readonly fare: FareAttribute;
  readonly rule: FareRule;
}

/**
 * An index of fares and their rules, built once per network.
 *
 * Rules are pre-sorted by specificity, so matching is a linear scan that stops
 * at the first hit for a given fare.
 */
export class FareMatcher {
  private readonly fares: ReadonlyMap<string, FareAttribute>;
  private readonly rulesByFare: ReadonlyMap<string, readonly FareRule[]>;
  private readonly ordered: readonly FareRule[];

  private constructor(
    fares: ReadonlyMap<string, FareAttribute>,
    rulesByFare: ReadonlyMap<string, readonly FareRule[]>,
    ordered: readonly FareRule[],
  ) {
    this.fares = fares;
    this.rulesByFare = rulesByFare;
    this.ordered = ordered;
  }

  /** Builds a matcher from a feed's fare tables. */
  static build(feed: GtfsFeed): FareMatcher {
    const fares = new Map(feed.fareAttributes.map((fare) => [fare.fareId, fare]));
    const rulesByFare = new Map<string, FareRule[]>();
    for (const rule of feed.fareRules) {
      if (!fares.has(rule.fareId)) {
        // Dangling rule; the validator reports it and it can never price a leg.
        continue;
      }
      const existing = rulesByFare.get(rule.fareId);
      if (existing === undefined) {
        rulesByFare.set(rule.fareId, [rule]);
      } else {
        existing.push(rule);
      }
    }
    for (const rules of rulesByFare.values()) {
      rules.sort(compareFareRules);
    }

    const ordered = feed.fareRules
      .filter((rule) => fares.has(rule.fareId))
      .slice()
      .sort(compareFareRules);

    return new FareMatcher(fares, rulesByFare, ordered);
  }

  /** True when the feed defines no fares at all. */
  get isEmpty(): boolean {
    return this.fares.size === 0;
  }

  /** Number of fares defined. */
  get fareCount(): number {
    return this.fares.size;
  }

  /** A fare by id. */
  fareById(fareId: string): FareAttribute | undefined {
    return this.fares.get(fareId);
  }

  /** The rules defined for a fare, most specific first. */
  rulesFor(fareId: string): readonly FareRule[] {
    return this.rulesByFare.get(fareId) ?? [];
  }

  /**
   * Every fare that could price the leg, most specific and cheapest first.
   *
   * A fare appears at most once, matched by its most specific applicable rule.
   */
  candidates(leg: FareableLeg): FareMatch[] {
    const byFare = new Map<string, FareMatch>();

    for (const rule of this.ordered) {
      if (byFare.has(rule.fareId)) {
        continue;
      }
      if (!ruleApplies(rule, leg)) {
        continue;
      }
      const fare = this.fares.get(rule.fareId);
      if (fare !== undefined) {
        byFare.set(rule.fareId, { fare, rule });
      }
    }

    return Array.from(byFare.values()).sort(compareMatches);
  }

  /** The single fare that prices the leg, or `undefined` when none applies. */
  best(leg: FareableLeg): FareMatch | undefined {
    return this.candidates(leg)[0];
  }
}

/**
 * True when a rule's constraints are all satisfied.
 *
 * An unset constraint is not a wildcard match in the loose sense — it simply
 * imposes nothing. That is why a rule with no constraints prices every leg.
 */
export function ruleApplies(rule: FareRule, leg: FareableLeg): boolean {
  if (rule.routeId !== undefined && rule.routeId !== leg.routeId) {
    return false;
  }
  if (rule.originId !== undefined && rule.originId !== leg.originZoneId) {
    return false;
  }
  if (rule.destinationId !== undefined && rule.destinationId !== leg.destinationZoneId) {
    return false;
  }
  if (rule.containsId !== undefined && !leg.zonesTouched.has(rule.containsId)) {
    return false;
  }
  return true;
}

/** Ordering for matches: most specific rule, then cheapest, then fare id. */
export function compareMatches(a: FareMatch, b: FareMatch): number {
  const byRule = compareFareRules(a.rule, b.rule);
  if (byRule !== 0) {
    return byRule;
  }
  if (a.fare.price !== b.fare.price) {
    return a.fare.price - b.fare.price;
  }
  return a.fare.fareId.localeCompare(b.fare.fareId);
}
