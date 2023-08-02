/**
 * Journeys as a caller sees them: legs with names and times, measurements, and
 * deterministic ordering.
 */

export {
  type LegKind,
  type LegBase,
  type AccessLeg,
  type RideLeg,
  type WalkLeg,
  type EgressLeg,
  type JourneyLeg,
  type IntermediateCall,
  isRide,
  isOnFoot,
  originStopIdOf,
  destinationStopIdOf,
  formatAbsoluteTime,
  dateOfAbsoluteTime,
  describeLeg,
} from "./leg.js";

export {
  type Itinerary,
  buildItinerary,
  buildItineraries,
  ridesOf,
  stopSequenceOf,
  routesOf,
  isWalkOnly,
} from "./itinerary.js";

export {
  type JourneyMetrics,
  type ProfileMetrics,
  measureJourney,
  waitsBetweenLegs,
  movementRatio,
  totalDuration,
  summariseJourney,
  routeSequence,
  summariseProfile,
} from "./metrics.js";

export {
  type SortOrder,
  criteriaOfItinerary,
  tieBreakKey,
  compareByArrival,
  compareByDeparture,
  compareByDuration,
  compareByTransfers,
  compareByWalking,
  comparatorFor,
  sortItineraries,
  bestItineraries,
  deduplicateItineraries,
} from "./compare.js";
