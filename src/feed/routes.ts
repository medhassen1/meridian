/**
 * `routes.txt` — the named services a passenger recognises, such as "the 47"
 * or "the Circle line".
 *
 * A route is a labelling concept, not a routing one: the vehicles that carry
 * its name may follow several different stop sequences. Routing works on the
 * patterns derived in `src/model/route-pattern.ts`; routes supply the names,
 * colours, and modes that make a result readable.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, warnIfEmpty, type LoadedTable } from "./table.js";

/** The `route_type` enumeration, restricted to the basic set. */
export enum RouteType {
  Tram = 0,
  Subway = 1,
  Rail = 2,
  Bus = 3,
  Ferry = 4,
  CableTram = 5,
  AerialLift = 6,
  Funicular = 7,
  Trolleybus = 11,
  Monorail = 12,
}

/** The `continuous_pickup` and `continuous_drop_off` enumeration. */
export enum ContinuousService {
  /** Continuous stopping is available along the route. */
  Continuous = 0,
  /** No continuous stopping. */
  None = 1,
  /** Continuous stopping must be arranged by phone. */
  PhoneAgency = 2,
  /** Continuous stopping must be coordinated with the driver. */
  CoordinateWithDriver = 3,
}

/** One row of `routes.txt`. */
export interface Route {
  readonly routeId: string;
  /** Empty string when the feed declares a single unnamed agency. */
  readonly agencyId: string;
  readonly routeShortName: string | undefined;
  readonly routeLongName: string | undefined;
  readonly routeDesc: string | undefined;
  readonly routeType: RouteType;
  readonly routeUrl: string | undefined;
  /** Six digit hex, upper case. Defaults to white per the specification. */
  readonly routeColor: string;
  /** Six digit hex, upper case. Defaults to black per the specification. */
  readonly routeTextColor: string;
  readonly routeSortOrder: number | undefined;
  readonly continuousPickup: ContinuousService;
  readonly continuousDropOff: ContinuousService;
  readonly line: number;
}

/** Columns without which the table cannot be read. */
export const ROUTE_REQUIRED_COLUMNS: readonly string[] = ["route_id", "route_type"];

/** Rule identifiers emitted by this module. */
export const ROUTE_RULES = {
  nameRequired: "route.name_required",
  extendedType: "route.extended_type",
  redundantName: "route.redundant_name",
} as const;

/** Default `route_color`: white. */
export const DEFAULT_ROUTE_COLOR = "FFFFFF";

/** Default `route_text_color`: black. */
export const DEFAULT_ROUTE_TEXT_COLOR = "000000";

const BASIC_ROUTE_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12];
const CONTINUOUS_VALUES = [0, 1, 2, 3];

/**
 * Reads every route from a loaded table.
 *
 * Rows without an id or a usable type are dropped. Extended route types — the
 * 100-1700 range used by European rail feeds — are folded onto their basic
 * equivalent with an informational diagnostic, because routing only ever needs
 * the coarse mode.
 */
export function readRoutes(table: LoadedTable, sink: DiagnosticSink): Route[] {
  requireColumns(table, ROUTE_REQUIRED_COLUMNS, sink);
  warnIfEmpty(table, sink);

  const routes: Route[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const routeId = reader.requiredId("route_id");
    if (routeId === undefined) {
      continue;
    }

    const rawType = reader.requiredInteger("route_type", { min: 0, max: 1999 });
    if (rawType === undefined) {
      continue;
    }
    let routeType: RouteType;
    if (BASIC_ROUTE_TYPES.includes(rawType)) {
      routeType = rawType as RouteType;
    } else {
      const folded = foldExtendedRouteType(rawType);
      if (folded === undefined) {
        sink.error(
          ROUTE_RULES.extendedType,
          `route "${routeId}" declares an unrecognised route_type ${rawType}`,
          row.positionOf("route_type"),
        );
        continue;
      }
      sink.info(
        ROUTE_RULES.extendedType,
        `route "${routeId}" uses extended route_type ${rawType}, read as ${folded}`,
        row.positionOf("route_type"),
      );
      routeType = folded;
    }

    const shortName = reader.optionalText("route_short_name");
    const longName = reader.optionalText("route_long_name");
    if (shortName === undefined && longName === undefined) {
      sink.error(
        ROUTE_RULES.nameRequired,
        `route "${routeId}" needs a route_short_name or a route_long_name`,
        row.positionOf("route_short_name"),
      );
    }
    if (shortName !== undefined && shortName === longName) {
      sink.warn(
        ROUTE_RULES.redundantName,
        `route "${routeId}" repeats the same text in both name columns`,
        row.positionOf("route_long_name"),
      );
    }

    routes.push({
      routeId,
      agencyId: reader.optionalId("agency_id") ?? "",
      routeShortName: shortName,
      routeLongName: longName,
      routeDesc: reader.optionalText("route_desc"),
      routeType,
      routeUrl: reader.url("route_url"),
      routeColor: reader.colour("route_color") ?? DEFAULT_ROUTE_COLOR,
      routeTextColor: reader.colour("route_text_color") ?? DEFAULT_ROUTE_TEXT_COLOR,
      routeSortOrder: reader.integer("route_sort_order", { min: 0 }),
      continuousPickup: reader.enumerationOr(
        "continuous_pickup",
        CONTINUOUS_VALUES,
        ContinuousService.None,
      ) as ContinuousService,
      continuousDropOff: reader.enumerationOr(
        "continuous_drop_off",
        CONTINUOUS_VALUES,
        ContinuousService.None,
      ) as ContinuousService,
      line: row.line,
    });
  }
  return routes;
}

/**
 * Maps an extended route type onto the basic type it most closely matches, or
 * `undefined` when it falls in no recognised block.
 *
 * The blocks come from the Google extended route type proposal, which feeds in
 * Europe use widely. Only the leading digit matters for the coarse mode, so
 * the mapping is by hundreds.
 */
export function foldExtendedRouteType(value: number): RouteType | undefined {
  if (value >= 100 && value <= 199) {
    return RouteType.Rail;
  }
  if (value >= 200 && value <= 299) {
    return RouteType.Bus;
  }
  if (value >= 400 && value <= 499) {
    return RouteType.Subway;
  }
  if (value >= 700 && value <= 799) {
    return RouteType.Bus;
  }
  if (value >= 800 && value <= 899) {
    return RouteType.Trolleybus;
  }
  if (value >= 900 && value <= 999) {
    return RouteType.Tram;
  }
  if (value >= 1000 && value <= 1099) {
    return RouteType.Ferry;
  }
  if (value >= 1100 && value <= 1199) {
    return RouteType.AerialLift;
  }
  if (value >= 1200 && value <= 1299) {
    return RouteType.Ferry;
  }
  if (value >= 1300 && value <= 1399) {
    return RouteType.AerialLift;
  }
  if (value >= 1400 && value <= 1499) {
    return RouteType.Funicular;
  }
  return undefined;
}

/**
 * A route's display label: its short name when it has one, otherwise its long
 * name, otherwise its id.
 */
export function routeLabel(route: Route): string {
  return route.routeShortName ?? route.routeLongName ?? route.routeId;
}

/** A human readable name for a route type, used in reports. */
export function routeTypeName(type: RouteType): string {
  switch (type) {
    case RouteType.Tram:
      return "tram";
    case RouteType.Subway:
      return "subway";
    case RouteType.Rail:
      return "rail";
    case RouteType.Bus:
      return "bus";
    case RouteType.Ferry:
      return "ferry";
    case RouteType.CableTram:
      return "cable tram";
    case RouteType.AerialLift:
      return "aerial lift";
    case RouteType.Funicular:
      return "funicular";
    case RouteType.Trolleybus:
      return "trolleybus";
    case RouteType.Monorail:
      return "monorail";
  }
}

/**
 * Total ordering for display: by `route_sort_order` when present, then by
 * short name compared numerically where possible, then by id.
 *
 * Numeric-aware comparison keeps "9" before "10", which plain lexicographic
 * ordering gets wrong and which readers notice immediately.
 */
export function compareRoutesForDisplay(a: Route, b: Route): number {
  if (a.routeSortOrder !== undefined || b.routeSortOrder !== undefined) {
    const left = a.routeSortOrder ?? Number.MAX_SAFE_INTEGER;
    const right = b.routeSortOrder ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) {
      return left - right;
    }
  }
  const byName = compareNumericAware(routeLabel(a), routeLabel(b));
  return byName !== 0 ? byName : a.routeId.localeCompare(b.routeId);
}

function compareNumericAware(a: string, b: string): number {
  const leftNumber = Number(a);
  const rightNumber = Number(b);
  const leftIsNumber = a.length > 0 && Number.isFinite(leftNumber);
  const rightIsNumber = b.length > 0 && Number.isFinite(rightNumber);
  if (leftIsNumber && rightIsNumber && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  if (leftIsNumber !== rightIsNumber) {
    // Numbered routes sort before named ones.
    return leftIsNumber ? -1 : 1;
  }
  return a.localeCompare(b);
}
