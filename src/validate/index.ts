/**
 * Feed validation: the rule catalogue, the checks themselves, and reporting.
 */

export {
  type RuleCategory,
  type ValidationRule,
  type SeverityOverride,
  VALIDATION_RULES,
  RuleRegistry,
  findRule,
  rulesInCategory,
} from "./rules.js";

export {
  type ValidationContext,
  type Validator,
  DEFAULT_PER_RULE_LIMIT,
  Reporter,
  at,
} from "./context.js";

export {
  REFERENTIAL_VALIDATORS,
  validateTripReferences,
  validateCallReferences,
  validateRouteReferences,
  validateStopReferences,
  validateTransferReferences,
  validateFrequencyReferences,
  validateFareReferences,
  validatePathwayReferences,
} from "./referential.js";

export {
  TEMPORAL_VALIDATORS,
  MAX_PLAUSIBLE_TRIP_SECONDS,
  validateServiceActivity,
  validateTripActivity,
  validateDeclaredRange,
  validateFeedExpiry,
  validateTripDurations,
  validateUnusedEntities,
  feedOverhangDays,
} from "./temporal.js";

export {
  GEOMETRY_VALIDATORS,
  MAX_SPEED_BY_MODE,
  MAX_SHAPE_OFFSET_METRES,
  OUTLIER_FACTOR,
  validateImpliedSpeeds,
  validateDuplicatePositions,
  validateOutlierStops,
  validateAntimeridian,
  validateShapeProximity,
  validateStopCoverage,
} from "./geometry.js";

export {
  type ValidateOptions,
  type ValidationReport,
  DEFAULT_VALIDATORS,
  validateFeed,
  isClean,
  formatReport,
  reportToJson,
  groupByRule,
} from "./report.js";
