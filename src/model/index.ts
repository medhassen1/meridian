/**
 * The compiled routing network: dense indices, route patterns, timetables, and
 * the footpath graph.
 */

export {
  type StopIndex,
  type PatternIndex,
  type TripIndex,
  NO_INDEX,
  Interner,
  stopIndex,
  patternIndex,
  tripIndex,
  isIndex,
} from "./ids.js";

export { STOP_GRID_CELL_METRES, StopCatalogue } from "./stop-index.js";

export {
  type RoutePattern,
  patternKeyOf,
  buildPatterns,
  positionOf,
  positionsOf,
  allowsBoardingAt,
  allowsAlightingAt,
  isLoop,
  indexPatternsByStop,
} from "./route-pattern.js";

export { type TripFilter, PatternTimetable } from "./timetable.js";

export {
  type ExpandedRun,
  type ExpansionResult,
  RUN_SEPARATOR,
  expandFrequencies,
  isGeneratedRun,
  templateTripIdOf,
} from "./frequency-expansion.js";

export {
  type Footpath,
  type TransferGraphOptions,
  DEFAULT_MAX_WALK_METRES,
  DEFAULT_WALK_SPEED,
  DEFAULT_BOARDING_SLACK,
  DEFAULT_MAX_TRANSFER_SECONDS,
  TransferGraph,
} from "./transfer-graph.js";

export { type NetworkStatistics, Network } from "./network.js";

export {
  type BuildOptions,
  type BuildResult,
  BUILD_RULES,
  buildNetwork,
  rebuildWithTransfers,
  assertNetworkConsistent,
} from "./builder.js";
