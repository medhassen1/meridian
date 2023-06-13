/**
 * `fare_attributes.txt` and `fare_rules.txt` — what a journey costs.
 *
 * This is the original GTFS fare model, not the newer Fares v2 tables. It is
 * coarse — a fare is selected by route and by fare zone, with a flat allowance
 * of onward transfers — but it is what the overwhelming majority of published
 * feeds carry, and it is expressive enough to price the zone-based systems it
 * was designed for.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** The `payment_method` enumeration. */
export enum PaymentMethod {
  /** Paid aboard the vehicle. */
  OnBoard = 0,
  /** Paid before boarding. */
  BeforeBoarding = 1,
}

/** One row of `fare_attributes.txt`. */
export interface FareAttribute {
  readonly fareId: string;
  /** Price in the currency's major unit. */
  readonly price: number;
  /** ISO 4217 code, upper case. */
  readonly currencyType: string;
  readonly paymentMethod: PaymentMethod;
  /**
   * Number of onward transfers the fare covers, or `undefined` for unlimited.
   *
   * GTFS encodes unlimited as an empty cell, which is indistinguishable from
   * "not stated"; the specification resolves the ambiguity in favour of
   * unlimited and meridian follows it.
   */
  readonly transfers: number | undefined;
  readonly agencyId: string | undefined;
  /** Seconds the fare stays valid for onward travel, when limited. */
  readonly transferDuration: number | undefined;
  readonly line: number;
}

/** One row of `fare_rules.txt`. */
export interface FareRule {
  readonly fareId: string;
  readonly routeId: string | undefined;
  readonly originId: string | undefined;
  readonly destinationId: string | undefined;
  readonly containsId: string | undefined;
  readonly line: number;
}

/** Columns without which `fare_attributes.txt` can be read. */
export const FARE_ATTRIBUTE_REQUIRED_COLUMNS: readonly string[] = [
  "fare_id",
  "price",
  "currency_type",
  "payment_method",
];

/** Columns without which `fare_rules.txt` can be read. */
export const FARE_RULE_REQUIRED_COLUMNS: readonly string[] = ["fare_id"];

/** Rule identifiers emitted by this module. */
export const FARE_RULES = {
  duplicateFare: "fare.duplicate",
  unconstrainedRule: "fare.unconstrained_rule",
  currencyMismatch: "fare.currency_mismatch",
} as const;

const PAYMENT_VALUES = [0, 1];

/**
 * Reads every fare definition.
 *
 * A duplicate `fare_id` keeps the first definition, matching the loader's
 * general duplicate-key policy.
 */
export function readFareAttributes(table: LoadedTable, sink: DiagnosticSink): FareAttribute[] {
  requireColumns(table, FARE_ATTRIBUTE_REQUIRED_COLUMNS, sink);

  const fares: FareAttribute[] = [];
  const seen = new Set<string>();

  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const fareId = reader.requiredId("fare_id");
    const price = reader.requiredNumber("price", { min: 0 });
    const currencyType = reader.currency("currency_type");
    const paymentMethod = reader.enumeration("payment_method", PAYMENT_VALUES);
    if (
      fareId === undefined ||
      price === undefined ||
      currencyType === undefined ||
      paymentMethod === undefined
    ) {
      continue;
    }

    if (seen.has(fareId)) {
      sink.error(
        FARE_RULES.duplicateFare,
        `duplicate fare "${fareId}"; the first definition is kept`,
        position(table.file, row.line, 1),
      );
      continue;
    }
    seen.add(fareId);

    fares.push({
      fareId,
      price,
      currencyType,
      paymentMethod: paymentMethod as PaymentMethod,
      transfers: reader.integer("transfers", { min: 0, max: 2 }),
      agencyId: reader.optionalId("agency_id"),
      transferDuration: reader.integer("transfer_duration", { min: 0 }),
      line: row.line,
    });
  }

  reportCurrencyDisagreement(table.file, fares, sink);
  return fares;
}

/**
 * Reads every fare rule.
 *
 * A rule with no constraint at all matches every leg, which makes any other
 * rule for the same fare unreachable; that is legal but almost always a
 * mistake, so it is reported.
 */
export function readFareRules(table: LoadedTable, sink: DiagnosticSink): FareRule[] {
  requireColumns(table, FARE_RULE_REQUIRED_COLUMNS, sink);

  const rules: FareRule[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const fareId = reader.requiredId("fare_id");
    if (fareId === undefined) {
      continue;
    }

    const routeId = reader.optionalId("route_id");
    const originId = reader.optionalId("origin_id");
    const destinationId = reader.optionalId("destination_id");
    const containsId = reader.optionalId("contains_id");

    if (
      routeId === undefined &&
      originId === undefined &&
      destinationId === undefined &&
      containsId === undefined
    ) {
      sink.info(
        FARE_RULES.unconstrainedRule,
        `fare rule for "${fareId}" constrains nothing and so matches every leg`,
        position(table.file, row.line, 1),
      );
    }

    rules.push({ fareId, routeId, originId, destinationId, containsId, line: row.line });
  }
  return rules;
}

/** True when the fare covers an unlimited number of onward transfers. */
export function allowsUnlimitedTransfers(fare: FareAttribute): boolean {
  return fare.transfers === undefined;
}

/**
 * How specific a rule is, used to choose between several that match one leg.
 *
 * A rule naming an origin, a destination, and a route is a deliberate
 * statement about one journey; a rule naming only a route is a default. The
 * more specific rule wins.
 */
export function fareRuleSpecificity(rule: FareRule): number {
  let score = 0;
  if (rule.routeId !== undefined) {
    score += 1;
  }
  if (rule.originId !== undefined) {
    score += 2;
  }
  if (rule.destinationId !== undefined) {
    score += 2;
  }
  if (rule.containsId !== undefined) {
    score += 4;
  }
  return score;
}

/**
 * Total ordering over rules: most specific first, then by fare id and source
 * line so that equally specific rules resolve deterministically.
 */
export function compareFareRules(a: FareRule, b: FareRule): number {
  const bySpecificity = fareRuleSpecificity(b) - fareRuleSpecificity(a);
  if (bySpecificity !== 0) {
    return bySpecificity;
  }
  const byFare = a.fareId.localeCompare(b.fareId);
  return byFare !== 0 ? byFare : a.line - b.line;
}

/**
 * Warns when fares are priced in more than one currency.
 *
 * meridian sums leg prices to produce a journey total, and summing across
 * currencies is meaningless. The fare calculator refuses to total such a
 * journey; this diagnostic surfaces the cause at load time.
 */
function reportCurrencyDisagreement(
  file: string,
  fares: readonly FareAttribute[],
  sink: DiagnosticSink,
): void {
  const currencies = new Set(fares.map((fare) => fare.currencyType));
  if (currencies.size > 1) {
    sink.warn(
      FARE_RULES.currencyMismatch,
      `fares are priced in ${currencies.size} currencies (${Array.from(currencies)
        .sort()
        .join(", ")}); journey totals cannot be computed across them`,
      position(file, 1, 1),
    );
  }
}
