/**
 * Source positions and diagnostics for CSV input.
 *
 * A GTFS feed is frequently produced by a script nobody maintains, and the
 * only actionable bug report is one that names the file, line, and column of
 * the offending cell. Every parse and coercion failure in meridian therefore
 * carries a {@link SourcePosition}, and diagnostics render as
 * `stops.txt:412:3` so an editor can jump straight to it.
 */

/** A one-based position inside a named source file. */
export interface SourcePosition {
  /** Name of the table, for example `stop_times.txt`. */
  readonly file: string;
  /** One-based physical line number. */
  readonly line: number;
  /** One-based field index within the line. */
  readonly column: number;
}

/** Severity of a diagnostic. */
export type DiagnosticSeverity = "error" | "warning" | "info";

/** A single problem found while reading a table. */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable identifier for the rule that produced this diagnostic. */
  readonly rule: string;
  readonly message: string;
  readonly position: SourcePosition | undefined;
}

/** Builds a source position. */
export function position(file: string, line: number, column: number): SourcePosition {
  return Object.freeze({ file, line, column });
}

/** Renders `file:line:column`. */
export function formatPosition(value: SourcePosition): string {
  return `${value.file}:${value.line}:${value.column}`;
}

/** Builds a diagnostic. */
export function diagnostic(
  severity: DiagnosticSeverity,
  rule: string,
  message: string,
  at?: SourcePosition,
): Diagnostic {
  return Object.freeze({ severity, rule, message, position: at });
}

/** Renders `severity file:line:column rule: message`, omitting absent parts. */
export function formatDiagnostic(value: Diagnostic): string {
  const where = value.position === undefined ? "" : ` ${formatPosition(value.position)}`;
  return `${value.severity}${where} ${value.rule}: ${value.message}`;
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Total ordering over diagnostics: severity first, then source position, then
 * rule and message.
 *
 * Sorting by position before rule means a reader working through a file sees
 * its problems in the order they appear, which is how a compiler reports and
 * how people read.
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byFile = (a.position?.file ?? "").localeCompare(b.position?.file ?? "");
  if (byFile !== 0) {
    return byFile;
  }
  const byLine = (a.position?.line ?? 0) - (b.position?.line ?? 0);
  if (byLine !== 0) {
    return byLine;
  }
  const byColumn = (a.position?.column ?? 0) - (b.position?.column ?? 0);
  if (byColumn !== 0) {
    return byColumn;
  }
  const byRule = a.rule.localeCompare(b.rule);
  return byRule !== 0 ? byRule : a.message.localeCompare(b.message);
}
