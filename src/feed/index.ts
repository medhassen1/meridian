/**
 * GTFS table reading: entity types, per-table readers, and the feed loader.
 */

export {
  TABLES,
  type TableName,
  type FeedSource,
  REQUIRED_TABLES,
  MemoryFeedSource,
  FilteredFeedSource,
  missingRequiredTables,
  hasAnyCalendarTable,
} from "./source.js";

export {
  TABLE_RULES,
  type LoadedTable,
  type TableReadOptions,
  readTable,
  requireColumns,
  warnIfEmpty,
  indexByKey,
  groupByKey,
} from "./table.js";

export {
  type Agency,
  AGENCY_REQUIRED_COLUMNS,
  AGENCY_RULES,
  readAgencies,
  commonTimezone,
} from "./agency.js";

export {
  type Stop,
  LocationType,
  WheelchairBoarding,
  STOP_REQUIRED_COLUMNS,
  LOCATED_TYPES,
  STOP_RULES,
  readStops,
  isBoardable,
  groupingIdOf,
  stopLabel,
} from "./stops.js";

export {
  type Route,
  RouteType,
  ContinuousService,
  ROUTE_REQUIRED_COLUMNS,
  ROUTE_RULES,
  DEFAULT_ROUTE_COLOR,
  DEFAULT_ROUTE_TEXT_COLOR,
  readRoutes,
  foldExtendedRouteType,
  routeLabel,
  routeTypeName,
  compareRoutesForDisplay,
} from "./routes.js";

export {
  type Trip,
  DirectionId,
  WheelchairAccessibility,
  BikesAllowed,
  TRIP_REQUIRED_COLUMNS,
  TRIP_RULES,
  readTrips,
  tripLabel,
  tripsByBlock,
} from "./trips.js";

export {
  type RawStopTime,
  type StopTime,
  BoardingRule,
  Timepoint,
  STOP_TIME_REQUIRED_COLUMNS,
  STOP_TIME_RULES,
  readStopTimes,
  groupStopTimes,
  interpolateStopTimes,
  allowsBoarding,
  allowsAlighting,
  dwellSeconds,
} from "./stop-times.js";

export {
  type CalendarEntry,
  type CalendarException,
  ExceptionType,
  CALENDAR_REQUIRED_COLUMNS,
  CALENDAR_DATE_REQUIRED_COLUMNS,
  CALENDAR_RULES,
  readCalendars,
  readCalendarExceptions,
  runsOnWeekday,
  matchesWeeklyPattern,
  reportRedundantExceptions,
  declaredServiceIds,
} from "./calendar.js";

export {
  type Frequency,
  ExactTimes,
  FREQUENCY_REQUIRED_COLUMNS,
  FREQUENCY_RULES,
  MAX_GENERATED_DEPARTURES,
  readFrequencies,
  frequencyWindow,
  generateDepartures,
  expectedWaitSeconds,
} from "./frequencies.js";

export {
  type Transfer,
  TransferType,
  TRANSFER_REQUIRED_COLUMNS,
  TRANSFER_RULES,
  readTransfers,
  forbidsTransfer,
  isTimedTransfer,
  isInSeatTransfer,
  requiredTransferSeconds,
  transferSpecificity,
} from "./transfers.js";

export {
  type ShapePoint,
  type Shape,
  SHAPE_REQUIRED_COLUMNS,
  SHAPE_RULES,
  readShapePoints,
  buildShapes,
} from "./shapes.js";

export {
  type FareAttribute,
  type FareRule,
  PaymentMethod,
  FARE_ATTRIBUTE_REQUIRED_COLUMNS,
  FARE_RULE_REQUIRED_COLUMNS,
  FARE_RULES,
  readFareAttributes,
  readFareRules,
  allowsUnlimitedTransfers,
  fareRuleSpecificity,
  compareFareRules,
} from "./fares.js";

export {
  type Pathway,
  type Level,
  PathwayMode,
  PATHWAY_REQUIRED_COLUMNS,
  LEVEL_REQUIRED_COLUMNS,
  PATHWAY_RULES,
  STATION_WALK_SPEED,
  SECONDS_PER_STAIR,
  readPathways,
  readLevels,
  traversalSeconds,
  isStepFree,
  allowsDirection,
  pathwayModeName,
} from "./pathways.js";

export {
  type FeedInfo,
  FEED_INFO_REQUIRED_COLUMNS,
  FEED_INFO_RULES,
  readFeedInfo,
  coversDate,
  describeRange,
} from "./feed-info.js";

export {
  type GtfsFeed,
  type TripWithCalls,
  type FeedSummary,
  summariseFeed,
  tripsForService,
  tripsForRoute,
  servedStopIds,
  unservedStops,
  referencedServiceIds,
} from "./feed.js";

export {
  type LoadOptions,
  type LoadResult,
  LOADER_RULES,
  loadFeed,
  loadFeedFromTables,
} from "./loader.js";
