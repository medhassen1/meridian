/**
 * Diagnostic collection.
 *
 * Loading a feed must not stop at the first bad cell. An agency fixing an
 * export wants every problem in one pass, so readers append to a sink and keep
 * going, and the caller decides afterwards whether the error count is
 * tolerable.
 *
 * The sink also caps itself. A feed with a systematically broken column can
 * produce one diagnostic per row for a million rows; collecting them all turns
 * a validation run into an out-of-memory crash. Past the cap, counting
 * continues but storage stops.
 */

import {
  compareDiagnostics,
  diagnostic,
  type Diagnostic,
  type DiagnosticSeverity,
  type SourcePosition,
} from "./position.js";

/** Default number of diagnostics retained before truncation. */
export const DEFAULT_DIAGNOSTIC_LIMIT = 1_000;

/** Accumulates diagnostics, retaining at most a fixed number. */
export class DiagnosticSink {
  private readonly entries: Diagnostic[] = [];
  private readonly counts: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  private readonly limit: number;

  constructor(limit: number = DEFAULT_DIAGNOSTIC_LIMIT) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  /** Records a diagnostic of any severity. */
  add(
    severity: DiagnosticSeverity,
    rule: string,
    message: string,
    at?: SourcePosition,
  ): void {
    this.counts[severity] += 1;
    if (this.entries.length < this.limit) {
      this.entries.push(diagnostic(severity, rule, message, at));
    }
  }

  /** Records an error. */
  error(rule: string, message: string, at?: SourcePosition): void {
    this.add("error", rule, message, at);
  }

  /** Records a warning. */
  warn(rule: string, message: string, at?: SourcePosition): void {
    this.add("warning", rule, message, at);
  }

  /** Records an informational note. */
  info(rule: string, message: string, at?: SourcePosition): void {
    this.add("info", rule, message, at);
  }

  /** Copies every diagnostic from another sink into this one. */
  absorb(other: DiagnosticSink): void {
    for (const entry of other.all()) {
      this.add(entry.severity, entry.rule, entry.message, entry.position);
    }
  }

  /** True when at least one error was recorded. */
  hasErrors(): boolean {
    return this.counts.error > 0;
  }

  /** Number of diagnostics recorded at a severity, including truncated ones. */
  count(severity: DiagnosticSeverity): number {
    return this.counts[severity];
  }

  /** Total number recorded, including truncated ones. */
  total(): number {
    return this.counts.error + this.counts.warning + this.counts.info;
  }

  /** True when diagnostics were discarded because the retention cap was hit. */
  truncated(): boolean {
    return this.total() > this.entries.length;
  }

  /** The retained diagnostics, in insertion order. */
  all(): readonly Diagnostic[] {
    return this.entries;
  }

  /** The retained diagnostics in canonical severity-then-position order. */
  sorted(): Diagnostic[] {
    return this.entries.slice().sort(compareDiagnostics);
  }

  /** The retained diagnostics of one severity, in insertion order. */
  bySeverity(severity: DiagnosticSeverity): Diagnostic[] {
    return this.entries.filter((entry) => entry.severity === severity);
  }

  /** Discards every retained diagnostic and resets the counters. */
  clear(): void {
    this.entries.length = 0;
    this.counts.error = 0;
    this.counts.warning = 0;
    this.counts.info = 0;
  }
}
