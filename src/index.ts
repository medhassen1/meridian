/**
 * meridian — a deterministic transit routing engine.
 *
 * The public surface, in the order a caller meets it: read a feed, compile it
 * into a network, plan journeys against it, and render the result.
 *
 * ```ts
 * import { loadFeed, buildNetwork, planJourney, renderPlan, ServiceDate } from "meridian";
 *
 * const { feed } = loadFeed(source);
 * const { network } = buildNetwork(feed!);
 * const plan = planJourney(network, {
 *   from: { kind: "stop", stopId: "CENTRAL" },
 *   to: { kind: "stop", stopId: "HARBOUR" },
 *   date: ServiceDate.parse("20230612"),
 *   departAfter: "08:00:00",
 * });
 * console.log(renderPlan(plan));
 * ```
 *
 * Nothing in this library reads the system clock, the host time zone, the
 * network, or any file the caller did not name. The same inputs always produce
 * the same output.
 */

export {
  type ErrorCode,
  type ErrorDetails,
  MeridianError,
  CsvFormatError,
  CsvSchemaError,
  MissingTableError,
  InvalidTableError,
  ReferentialIntegrityError,
  NetworkBuildError,
  QueryError,
  RoutingError,
  UnknownStopError,
  UnknownServiceError,
  TimeRangeError,
  GeometryError,
  CliUsageError,
  isMeridianError,
  hasErrorCode,
} from "./errors.js";

export * from "./time/index.js";
export * from "./geo/index.js";
export * from "./csv/index.js";
export * from "./feed/index.js";
export * from "./calendar/index.js";
export * from "./validate/index.js";
export * from "./model/index.js";
export * from "./routing/index.js";
export * from "./journey/index.js";
export * from "./fares/index.js";
export * from "./isochrone/index.js";
export * from "./report/index.js";

export { DirectoryFeedSource } from "./feed/directory.js";

export {
  type PlannedJourney,
  type PlanResult,
  type PlanOptions,
  DEFAULT_PLAN_LIMIT,
  planJourney,
  planProfile,
  fastestJourney,
  fewestTransfers,
  isEmpty,
} from "./planner.js";

/** The library's version, matching `package.json`. */
export const VERSION = "0.6.0";
