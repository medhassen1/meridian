/**
 * CSV reading: tokenising, header-keyed records, typed field coercion, and
 * positional diagnostics.
 */

export {
  type SourcePosition,
  type Diagnostic,
  type DiagnosticSeverity,
  position,
  formatPosition,
  diagnostic,
  formatDiagnostic,
  compareDiagnostics,
} from "./position.js";

export {
  type Field,
  type Row,
  type LexerOptions,
  BYTE_ORDER_MARK,
  tokenise,
  tokeniseAll,
  escapeField,
  formatRow,
} from "./lexer.js";

export {
  type RaggedRowPolicy,
  type ParserOptions,
  type ParsedTable,
  TableRow,
  parseTable,
  parseTableRows,
} from "./parser.js";

export { DEFAULT_DIAGNOSTIC_LIMIT, DiagnosticSink } from "./sink.js";

export { type NumericBounds, SCHEMA_RULES, RowReader } from "./schema.js";
