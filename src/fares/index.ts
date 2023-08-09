/**
 * Fare computation over the classic GTFS fare model.
 */

export {
  type FareableLeg,
  type FareMatch,
  FareMatcher,
  ruleApplies,
  compareMatches,
} from "./matcher.js";

export {
  type LegFare,
  type JourneyFare,
  type UnpricedReason,
  computeFare,
  coversLeg,
  describeFareableLeg,
  buildZoneIndex,
  formatFare,
  describeFare,
} from "./compute.js";
