/**
 * The error hierarchy shared by every meridian subsystem.
 *
 * Every error thrown by the public API derives from {@link MeridianError} and
 * carries a stable machine-readable {@link MeridianError.code}. Codes are part
 * of the public contract: callers may branch on them, and they never change
 * meaning within a major version. Human-readable messages are not part of the
 * contract and may be reworded.
 *
 * Errors deliberately carry structured context (`details`) instead of encoding
 * values into the message. Report renderers format the context; programs read
 * it.
 */

/** Stable machine-readable discriminator for every meridian error. */
export type ErrorCode =
  | "CSV_MALFORMED"
  | "CSV_SCHEMA"
  | "FEED_MISSING_TABLE"
  | "FEED_INVALID_TABLE"
  | "FEED_INTEGRITY"
  | "NETWORK_BUILD"
  | "QUERY_INVALID"
  | "ROUTING_FAILED"
  | "UNKNOWN_STOP"
  | "UNKNOWN_SERVICE"
  | "TIME_RANGE"
  | "GEOMETRY"
  | "CLI_USAGE";

/** Arbitrary structured context attached to an error. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Base class for every error raised by meridian.
 *
 * `instanceof MeridianError` is the supported way to distinguish a fault
 * originating inside this library from an unrelated runtime failure.
 */
export class MeridianError extends Error {
  /** Stable machine-readable discriminator. */
  readonly code: ErrorCode;

  /** Structured context describing what was rejected and why. */
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    // Restores the prototype chain when the package is consumed from compiled
    // ES5 output, where extending built-ins otherwise breaks `instanceof`.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Renders the error as a plain object with deterministic key order, suitable
   * for embedding in a JSON report.
   */
  toJSON(): { code: ErrorCode; name: string; message: string; details: ErrorDetails } {
    return {
      code: this.code,
      name: this.name,
      message: this.message,
      details: sortDetails(this.details),
    };
  }
}

/** A CSV byte stream that could not be tokenised into rows. */
export class CsvFormatError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("CSV_MALFORMED", message, details);
  }
}

/** A CSV row whose shape or cell values violate the declared column schema. */
export class CsvSchemaError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("CSV_SCHEMA", message, details);
  }
}

/** A required GTFS table was absent from the feed source. */
export class MissingTableError extends MeridianError {
  constructor(table: string, details: ErrorDetails = {}) {
    super("FEED_MISSING_TABLE", `required table "${table}" is missing from the feed`, {
      table,
      ...details,
    });
  }
}

/** A GTFS table parsed cleanly but its contents are not usable. */
export class InvalidTableError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("FEED_INVALID_TABLE", message, details);
  }
}

/** A cross-table reference does not resolve. */
export class ReferentialIntegrityError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("FEED_INTEGRITY", message, details);
  }
}

/** The compiled routing network could not be built from the feed. */
export class NetworkBuildError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("NETWORK_BUILD", message, details);
  }
}

/** A journey or isochrone query is self-inconsistent or out of range. */
export class QueryError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("QUERY_INVALID", message, details);
  }
}

/** The routing engine could not complete, for reasons other than "no path". */
export class RoutingError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("ROUTING_FAILED", message, details);
  }
}

/** A stop id was referenced that the network does not contain. */
export class UnknownStopError extends MeridianError {
  constructor(stopId: string, details: ErrorDetails = {}) {
    super("UNKNOWN_STOP", `unknown stop "${stopId}"`, { stopId, ...details });
  }
}

/** A service id was referenced that no calendar defines. */
export class UnknownServiceError extends MeridianError {
  constructor(serviceId: string, details: ErrorDetails = {}) {
    super("UNKNOWN_SERVICE", `unknown service "${serviceId}"`, { serviceId, ...details });
  }
}

/** A date, time-of-day, or interval fell outside its representable range. */
export class TimeRangeError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("TIME_RANGE", message, details);
  }
}

/** A coordinate, bounding box, or shape violated a geometric invariant. */
export class GeometryError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("GEOMETRY", message, details);
  }
}

/** The command line was not understood. */
export class CliUsageError extends MeridianError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("CLI_USAGE", message, details);
  }
}

/**
 * Returns the details object with keys in ascending lexicographic order.
 *
 * Report output is compared byte-for-byte in tests and in downstream diffing
 * tools, so key order must not depend on insertion order.
 */
function sortDetails(details: ErrorDetails): ErrorDetails {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(details).sort()) {
    sorted[key] = details[key];
  }
  return sorted;
}

/**
 * Narrows an unknown caught value to a {@link MeridianError}.
 *
 * Useful in `catch` blocks under `useUnknownInCatchVariables`.
 */
export function isMeridianError(value: unknown): value is MeridianError {
  return value instanceof MeridianError;
}

/**
 * Narrows an unknown caught value to a {@link MeridianError} with a specific
 * code.
 */
export function hasErrorCode(value: unknown, code: ErrorCode): value is MeridianError {
  return isMeridianError(value) && value.code === code;
}
