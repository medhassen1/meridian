/**
 * What every validator is handed, and how it reports.
 *
 * Validators are plain functions over a context rather than methods on a
 * class. That keeps each one independently testable, lets a caller run a
 * subset, and makes the set of things a check may touch explicit in its
 * signature.
 */

import { position, type SourcePosition } from "../csv/position.js";
import type { DiagnosticSink } from "../csv/sink.js";
import type { ServiceCalendar } from "../calendar/service-calendar.js";
import type { GtfsFeed } from "../feed/feed.js";
import { RuleRegistry } from "./rules.js";

/** Everything a validator may read. */
export interface ValidationContext {
  readonly feed: GtfsFeed;
  readonly calendar: ServiceCalendar;
  readonly registry: RuleRegistry;
  readonly sink: DiagnosticSink;
  /**
   * Stops reporting a rule once it has fired this many times.
   *
   * A feed with a systematically broken column produces one diagnostic per
   * row; after the first few they carry no further information, and the reader
   * needs the *other* rules to remain visible.
   */
  readonly perRuleLimit: number;
}

/** Default number of times a single rule reports before it falls silent. */
export const DEFAULT_PER_RULE_LIMIT = 50;

/**
 * A validator: reads the context, appends diagnostics through
 * {@link Reporter}.
 */
export type Validator = (context: ValidationContext, report: Reporter) => void;

/**
 * Applies rule severities and per-rule limits on the way to the sink.
 *
 * Validators call `report.emit(ruleId, message, at)` and never decide severity
 * themselves, so a caller's overrides are honoured uniformly.
 */
export class Reporter {
  private readonly context: ValidationContext;
  private readonly counts = new Map<string, number>();
  private readonly silenced = new Set<string>();

  constructor(context: ValidationContext) {
    this.context = context;
  }

  /**
   * Reports one occurrence of a rule.
   *
   * Returns true when the diagnostic reached the sink, so a caller doing
   * expensive work per occurrence can stop once the rule falls silent.
   */
  emit(ruleId: string, message: string, at?: SourcePosition): boolean {
    const severity = this.context.registry.severityOf(ruleId);
    if (severity === "off") {
      return false;
    }

    const seen = (this.counts.get(ruleId) ?? 0) + 1;
    this.counts.set(ruleId, seen);
    if (seen > this.context.perRuleLimit) {
      if (!this.silenced.has(ruleId)) {
        this.silenced.add(ruleId);
        this.context.sink.info(
          ruleId,
          `rule ${ruleId} has fired ${this.context.perRuleLimit} times and is now suppressed`,
          at,
        );
      }
      return false;
    }

    this.context.sink.add(severity, ruleId, message, at);
    return true;
  }

  /** True when the rule is enabled and has not yet been silenced. */
  isActive(ruleId: string): boolean {
    if (!this.context.registry.isEnabled(ruleId)) {
      return false;
    }
    return (this.counts.get(ruleId) ?? 0) <= this.context.perRuleLimit;
  }

  /** How many times a rule has fired, including suppressed occurrences. */
  timesFired(ruleId: string): number {
    return this.counts.get(ruleId) ?? 0;
  }

  /** Ids of rules that fired at least once, sorted. */
  firedRuleIds(): string[] {
    return Array.from(this.counts.keys()).sort();
  }
}

/** Builds a position inside a table, for validators that know a source line. */
export function at(file: string, line: number): SourcePosition {
  return position(file, line, 1);
}
