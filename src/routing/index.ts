/**
 * The routing engine: query normalisation, the RAPTOR round loop, profile
 * search, and journey reconstruction.
 */

export {
  type AccessPoint,
  type PlaceRequest,
  type JourneyRequest,
  type JourneyQuery,
  DEFAULT_MAX_BOARDINGS,
  DEFAULT_MIN_TRANSFER_SECONDS,
  DEFAULT_MAX_JOURNEY_SECONDS,
  DEFAULT_ACCESS_RADIUS_METRES,
  MAX_ACCESS_STOPS,
  ACCESS_WALK_SPEED,
  normaliseQuery,
  resolvePlace,
  tripPermitted,
  hasTripFilters,
  searchHorizon,
} from "./query.js";

export {
  type DayAnchor,
  type Boarding,
  type Alighting,
  type TripPredicate,
  DayScanner,
} from "./day-scan.js";

export { type Leg, UNREACHED, LabelSet, MarkedStops } from "./labels.js";

export {
  type RelaxationOutcome,
  relaxFootpaths,
  seedOrigins,
  bestDestinationArrival,
} from "./footpath.js";

export {
  type SearchStatistics,
  type SearchResult,
  MAX_ROUNDS,
  runRaptor,
  collectPatternQueue,
} from "./raptor.js";

export {
  type RawLeg,
  type RawJourney,
  extractJourneys,
  extractBestJourney,
  journeyKey,
  rideSeconds,
  walkSeconds,
  waitSeconds,
} from "./result.js";

export {
  type Criteria,
  type ProfileCriteria,
  dominates,
  strictlyDominates,
  profileDominates,
  profileStrictlyDominates,
  paretoFrontier,
  profileFrontier,
  compareCriteria,
  diversify,
} from "./pareto.js";

export {
  type ProfileOptions,
  type ProfileResult,
  DEFAULT_MAX_DEPARTURES,
  DEFAULT_MAX_JOURNEYS,
  runRangeRaptor,
  candidateDepartures,
  criteriaOf,
  departureBoard,
} from "./range-raptor.js";
