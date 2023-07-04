/**
 * Running the validators and rendering what they found.
 *
 * A validation report is meant to be read by a person fixing a feed and by a
 * pipeline deciding whether to publish it, so it has to be both legible and
 * machine-comparable. Every rendering here is deterministic: diagnostics come
 * out in canonical order and counts are computed from the same source.
 */

import {
  compareDiagnostics,
  formatDiagnostic,
  type Diagnostic,
  type DiagnosticSeverity,
} from "../csv/position.js";
import { DiagnosticSink } from "../csv/sink.js";
import { summariseFeed, type FeedSummary, type GtfsFeed } from "../feed/feed.js";
import { ServiceCalendar } from "../calendar/service-calendar.js";
import {
  DEFAULT_PER_RULE_LIMIT,
  Reporter,
  type ValidationContext,
  type Validator,
} from "./context.js";
import { GEOMETRY_VALIDATORS } from "./geometry.js";
import { REFERENTIAL_VALIDATORS } from "./referential.js";
import { RuleRegistry, type SeverityOverride } from "./rules.js";
import { TEMPORAL_VALIDATORS, validateFeedExpiry } from "./temporal.js";

/** Options controlling a validation run. */
export interface ValidateOptions {
  /** Per-rule severity overrides; `"off"` suppresses a rule. */
  readonly severities?: Readonly<Record<string, SeverityOverride>>;
  /** Times one rule may fire before falling silent. */
  readonly perRuleLimit?: number;
  /** Maximum diagnostics retained overall. */
  readonly diagnosticLimit?: number;
  /**
   * `YYYYMMDD` date against which feed expiry is judged. Omitted means the
   * expiry check does not run — meridian never reads the system clock.
   */
  readonly referenceDate?: string;
  /** Validators to run instead of the built-in set. */
  readonly validators?: readonly Validator[];
}

/** What a validation run produced. */
export interface ValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** True when diagnostics were dropped because a retention cap was hit. */
  readonly truncated: boolean;
  /** Ids of the rules that fired at least once, sorted. */
  readonly firedRules: readonly string[];
  readonly summary: FeedSummary;
}

/** The built-in validators, in the order a report reads best. */
export const DEFAULT_VALIDATORS: readonly Validator[] = [
  ...REFERENTIAL_VALIDATORS,
  ...TEMPORAL_VALIDATORS,
  ...GEOMETRY_VALIDATORS,
];

/**
 * Validates a feed.
 *
 * Diagnostics carried over from loading are not included; a caller wanting one
 * combined report merges the sinks itself, which keeps "the feed did not
 * parse" distinguishable from "the feed parsed but is wrong".
 */
export function validateFeed(
  feed: GtfsFeed,
  options: ValidateOptions = {},
): ValidationReport {
  const calendar = ServiceCalendar.build(feed.calendars, feed.calendarExceptions);
  const sink = new DiagnosticSink(options.diagnosticLimit);
  const registry = new RuleRegistry(options.severities ?? {});

  const context: ValidationContext = {
    feed,
    calendar,
    registry,
    sink,
    perRuleLimit: options.perRuleLimit ?? DEFAULT_PER_RULE_LIMIT,
  };
  const reporter = new Reporter(context);

  const validators =
    options.validators ??
    (options.referenceDate === undefined
      ? DEFAULT_VALIDATORS
      : [...DEFAULT_VALIDATORS, validateFeedExpiry(options.referenceDate)]);

  for (const validator of validators) {
    validator(context, reporter);
  }

  return {
    diagnostics: sink.sorted(),
    errors: sink.count("error"),
    warnings: sink.count("warning"),
    infos: sink.count("info"),
    truncated: sink.truncated(),
    firedRules: reporter.firedRuleIds(),
    summary: summariseFeed(feed),
  };
}

/** True when the report contains no diagnostic at or above `threshold`. */
export function isClean(
  report: ValidationReport,
  threshold: DiagnosticSeverity = "error",
): boolean {
  switch (threshold) {
    case "error":
      return report.errors === 0;
    case "warning":
      return report.errors === 0 && report.warnings === 0;
    case "info":
      return report.errors === 0 && report.warnings === 0 && report.infos === 0;
  }
}

/**
 * Renders the report as text.
 *
 * One diagnostic per line in canonical order, then a count line. Suitable for
 * a terminal and for a diff between two runs.
 */
export function formatReport(report: ValidationReport, maxLines = 200): string {
  const lines: string[] = [];
  const shown = report.diagnostics.slice(0, maxLines);
  for (const entry of shown) {
    lines.push(formatDiagnostic(entry));
  }
  if (report.diagnostics.length > shown.length) {
    lines.push(`… ${report.diagnostics.length - shown.length} more diagnostic(s) not shown`);
  }
  if (report.truncated) {
    lines.push("… some diagnostics were discarded because the retention limit was reached");
  }
  lines.push(
    `${report.errors} error(s), ${report.warnings} warning(s), ${report.infos} note(s) across ${report.firedRules.length} rule(s)`,
  );
  return lines.join("\n");
}

/**
 * Renders the report as JSON with deterministic key order.
 *
 * Written by hand rather than through `JSON.stringify` on a nested object so
 * that key order is a stated property of the format rather than an accident of
 * object construction.
 */
export function reportToJson(report: ValidationReport): string {
  const diagnostics = report.diagnostics.slice().sort(compareDiagnostics).map((entry) => ({
    column: entry.position?.column ?? null,
    file: entry.position?.file ?? null,
    line: entry.position?.line ?? null,
    message: entry.message,
    rule: entry.rule,
    severity: entry.severity,
  }));

  return JSON.stringify(
    {
      counts: {
        errors: report.errors,
        infos: report.infos,
        warnings: report.warnings,
      },
      diagnostics,
      firedRules: report.firedRules,
      summary: {
        agencies: report.summary.agencies,
        boardableStops: report.summary.boardableStops,
        calls: report.summary.calls,
        fares: report.summary.fares,
        routes: report.summary.routes,
        services: report.summary.services,
        shapes: report.summary.shapes,
        stops: report.summary.stops,
        transfers: report.summary.transfers,
        trips: report.summary.trips,
      },
      truncated: report.truncated,
    },
    null,
    2,
  );
}

/** Groups a report's diagnostics by rule id, in canonical order within groups. */
export function groupByRule(report: ValidationReport): Map<string, Diagnostic[]> {
  const grouped = new Map<string, Diagnostic[]>();
  for (const entry of report.diagnostics) {
    const existing = grouped.get(entry.rule);
    if (existing === undefined) {
      grouped.set(entry.rule, [entry]);
    } else {
      existing.push(entry);
    }
  }
  for (const entries of grouped.values()) {
    entries.sort(compareDiagnostics);
  }
  return new Map(Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)));
}
