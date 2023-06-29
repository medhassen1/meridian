/**
 * The validation rule registry.
 *
 * Every check meridian performs has an id, a description, and a default
 * severity, all declared here rather than buried at the point of use. Two
 * things follow. A caller can raise or lower any rule without patching the
 * validator, which matters because "a stop with no name" is fatal to one
 * consumer and cosmetic to another. And the full catalogue can be printed,
 * which is the only practical way to document what a validator actually does.
 */

import type { DiagnosticSeverity } from "../csv/position.js";

/** Which stage of the pipeline a rule belongs to. */
export type RuleCategory = "referential" | "temporal" | "geometry" | "coverage";

/** One declared check. */
export interface ValidationRule {
  readonly id: string;
  readonly category: RuleCategory;
  readonly description: string;
  readonly defaultSeverity: DiagnosticSeverity;
}

/** Every rule the validator can emit. */
export const VALIDATION_RULES: readonly ValidationRule[] = [
  {
    id: "ref.trip_route",
    category: "referential",
    description: "A trip names a route that routes.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.trip_service",
    category: "referential",
    description: "A trip names a service that no calendar table defines.",
    defaultSeverity: "error",
  },
  {
    id: "ref.trip_shape",
    category: "referential",
    description: "A trip names a shape that shapes.txt does not define.",
    defaultSeverity: "warning",
  },
  {
    id: "ref.call_stop",
    category: "referential",
    description: "A stop time names a stop that stops.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.call_not_boardable",
    category: "referential",
    description: "A stop time names a station or entrance rather than a boardable stop.",
    defaultSeverity: "error",
  },
  {
    id: "ref.route_agency",
    category: "referential",
    description: "A route names an agency that agency.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.parent_station",
    category: "referential",
    description: "A stop names a parent that is missing or is not a station.",
    defaultSeverity: "error",
  },
  {
    id: "ref.transfer_stop",
    category: "referential",
    description: "A transfer names a stop that stops.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.transfer_trip",
    category: "referential",
    description: "A transfer names a trip that trips.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.frequency_trip",
    category: "referential",
    description: "A frequency names a trip that trips.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.fare_rule_fare",
    category: "referential",
    description: "A fare rule names a fare that fare_attributes.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.fare_rule_route",
    category: "referential",
    description: "A fare rule names a route that routes.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.fare_rule_zone",
    category: "referential",
    description: "A fare rule names a fare zone that no stop belongs to.",
    defaultSeverity: "warning",
  },
  {
    id: "ref.pathway_stop",
    category: "referential",
    description: "A pathway names a stop that stops.txt does not define.",
    defaultSeverity: "error",
  },
  {
    id: "ref.stop_level",
    category: "referential",
    description: "A stop names a level that levels.txt does not define.",
    defaultSeverity: "warning",
  },
  {
    id: "time.service_never_active",
    category: "temporal",
    description: "A service runs on no date inside the calendar's own coverage.",
    defaultSeverity: "warning",
  },
  {
    id: "time.trip_never_runs",
    category: "temporal",
    description: "A trip's service is never active, so the trip can never be taken.",
    defaultSeverity: "warning",
  },
  {
    id: "time.feed_expired",
    category: "temporal",
    description: "The calendar's coverage ends before the declared feed range does.",
    defaultSeverity: "warning",
  },
  {
    id: "time.declared_range_mismatch",
    category: "temporal",
    description: "feed_info.txt declares a range the service calendar does not cover.",
    defaultSeverity: "warning",
  },
  {
    id: "time.trip_too_long",
    category: "temporal",
    description: "A trip runs for longer than a plausible single vehicle journey.",
    defaultSeverity: "warning",
  },
  {
    id: "time.zero_length_hop",
    category: "temporal",
    description: "Two consecutive calls share the same time, implying instant travel.",
    defaultSeverity: "warning",
  },
  {
    id: "geo.implausible_speed",
    category: "geometry",
    description: "The speed implied between two consecutive calls exceeds the mode's limit.",
    defaultSeverity: "warning",
  },
  {
    id: "geo.duplicate_position",
    category: "geometry",
    description: "Two distinct stops share the same coordinate.",
    defaultSeverity: "info",
  },
  {
    id: "geo.outlier_stop",
    category: "geometry",
    description: "A stop sits far outside the cluster the rest of the feed occupies.",
    defaultSeverity: "warning",
  },
  {
    id: "geo.antimeridian",
    category: "geometry",
    description: "The feed spans the antimeridian, which bounding box logic does not model.",
    defaultSeverity: "warning",
  },
  {
    id: "geo.shape_far_from_stop",
    category: "geometry",
    description: "A trip's shape passes far from one of the stops the trip calls at.",
    defaultSeverity: "warning",
  },
  {
    id: "cover.unserved_stop",
    category: "coverage",
    description: "A boardable stop that no trip calls at.",
    defaultSeverity: "info",
  },
  {
    id: "cover.route_without_trips",
    category: "coverage",
    description: "A route that no trip belongs to.",
    defaultSeverity: "warning",
  },
  {
    id: "cover.unused_service",
    category: "coverage",
    description: "A service that no trip references.",
    defaultSeverity: "info",
  },
  {
    id: "cover.unused_shape",
    category: "coverage",
    description: "A shape that no trip references.",
    defaultSeverity: "info",
  },
];

const BY_ID = new Map(VALIDATION_RULES.map((rule) => [rule.id, rule]));

/** Looks a rule up by id. */
export function findRule(id: string): ValidationRule | undefined {
  return BY_ID.get(id);
}

/** Every rule in a category, in declaration order. */
export function rulesInCategory(category: RuleCategory): ValidationRule[] {
  return VALIDATION_RULES.filter((rule) => rule.category === category);
}

/** A severity override, or `"off"` to suppress a rule entirely. */
export type SeverityOverride = DiagnosticSeverity | "off";

/**
 * Resolves each rule's effective severity.
 *
 * Overrides naming an unknown rule are rejected rather than ignored: a typo in
 * a configuration file that silently disables nothing is worse than one that
 * fails immediately.
 */
export class RuleRegistry {
  private readonly overrides = new Map<string, SeverityOverride>();

  /**
   * Builds a registry.
   *
   * @throws {Error} if an override names a rule that does not exist.
   */
  constructor(overrides: Readonly<Record<string, SeverityOverride>> = {}) {
    for (const [id, severity] of Object.entries(overrides)) {
      if (!BY_ID.has(id)) {
        throw new Error(`unknown validation rule "${id}"`);
      }
      this.overrides.set(id, severity);
    }
  }

  /** The severity a rule reports at, or `"off"` when it is suppressed. */
  severityOf(id: string): SeverityOverride {
    const override = this.overrides.get(id);
    if (override !== undefined) {
      return override;
    }
    return BY_ID.get(id)?.defaultSeverity ?? "error";
  }

  /** True when the rule reports at all. */
  isEnabled(id: string): boolean {
    return this.severityOf(id) !== "off";
  }

  /** Ids of every rule this registry suppresses, sorted. */
  suppressedRuleIds(): string[] {
    return Array.from(this.overrides.entries())
      .filter(([, severity]) => severity === "off")
      .map(([id]) => id)
      .sort();
  }
}
