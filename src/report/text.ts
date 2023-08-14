/**
 * Human-readable rendering.
 *
 * Written for someone reading a terminal, which means the shape of the output
 * carries meaning: one line per leg, times on the left where the eye scans for
 * them, and a summary line first so a reader can skip a journey that does not
 * suit. Every rendering is deterministic, so these outputs are also what the
 * tests assert against.
 */

import { duration, formatDuration } from "../time/duration.js";
import { describeFare } from "../fares/compute.js";
import { formatAbsoluteTime, isRide, type JourneyLeg } from "../journey/leg.js";
import { summariseJourney, type JourneyMetrics } from "../journey/metrics.js";
import type { Itinerary } from "../journey/itinerary.js";
import type { NetworkStatistics } from "../model/network.js";
import type { FeedSummary } from "../feed/feed.js";
import type { PlannedJourney, PlanResult } from "../planner.js";
import { indent, renderPairs, renderTable } from "./table.js";

/** Options controlling text rendering. */
export interface TextOptions {
  /** When true, stops passed through are listed under each ride. */
  readonly showIntermediateStops?: boolean;
  /** When true, the fare line is included. Defaults to true. */
  readonly showFare?: boolean;
  /** Prefix placed before every line, for nesting in a larger report. */
  readonly prefix?: string;
}

/** Renders one journey. */
export function renderJourney(
  journey: PlannedJourney,
  options: TextOptions = {},
): string {
  const lines: string[] = [];
  lines.push(headlineOf(journey.itinerary, journey.metrics));

  for (const leg of journey.itinerary.legs) {
    lines.push(`  ${renderLeg(leg)}`);
    if ((options.showIntermediateStops ?? false) && isRide(leg)) {
      for (const call of leg.intermediateStops) {
        lines.push(`      ${formatAbsoluteTime(call.arrival)}  ${call.stopName}`);
      }
    }
  }

  if (options.showFare ?? true) {
    lines.push(`  fare: ${describeFare(journey.fare)}`);
  }

  const text = lines.join("\n");
  return options.prefix === undefined ? text : indent(text, options.prefix.length);
}

/** Renders every journey in a plan, separated by blank lines. */
export function renderPlan(result: PlanResult, options: TextOptions = {}): string {
  if (result.journeys.length === 0) {
    return "No journey found.";
  }
  const blocks = result.journeys.map((journey, index) => {
    const heading = `Option ${index + 1}`;
    return `${heading}\n${renderJourney(journey, options)}`;
  });
  return blocks.join("\n\n");
}

/**
 * Renders a plan as a compact departure board.
 *
 * One row per journey: when to leave, when to arrive, how long, how many
 * changes, and which routes. This is the view a passenger scanning options
 * actually reads.
 */
export function renderDepartureBoard(result: PlanResult): string {
  const rows = result.journeys.map((journey) => {
    const routes = journey.itinerary.legs
      .filter(isRide)
      .map((leg) => leg.routeName)
      .join(" → ");
    return [
      formatAbsoluteTime(journey.itinerary.departure),
      formatAbsoluteTime(journey.itinerary.arrival),
      formatDuration(duration(Math.max(0, journey.itinerary.totalSeconds))),
      String(journey.itinerary.transfers),
      routes.length === 0 ? "walk" : routes,
    ];
  });

  return renderTable(
    [
      { header: "Depart" },
      { header: "Arrive" },
      { header: "Time", align: "right" },
      { header: "Changes", align: "right" },
      { header: "Routes", maxWidth: 48 },
    ],
    rows,
    { emptyText: "No journey found." },
  );
}

/** Renders one leg. */
export function renderLeg(leg: JourneyLeg): string {
  const window = `${formatAbsoluteTime(leg.departure)} → ${formatAbsoluteTime(leg.arrival)}`;
  const elapsed = formatDuration(duration(Math.max(0, leg.seconds)));

  switch (leg.kind) {
    case "access":
      return `${window}  walk ${elapsed} to ${leg.toStopName}`;
    case "ride": {
      const towards = leg.headsign === undefined ? "" : ` towards ${leg.headsign}`;
      const stops =
        leg.intermediateStops.length === 0
          ? "non-stop"
          : `${leg.intermediateStops.length} stop${leg.intermediateStops.length === 1 ? "" : "s"}`;
      return `${window}  ${leg.routeName}${towards}: ${leg.fromStopName} → ${leg.toStopName} (${elapsed}, ${stops})`;
    }
    case "walk": {
      const source = leg.published ? "published transfer" : "walk";
      return `${window}  ${source} ${elapsed}: ${leg.fromStopName} → ${leg.toStopName}`;
    }
    case "egress":
      return `${window}  walk ${elapsed} from ${leg.fromStopName}`;
  }
}

/** Renders a feed summary as a key/value block. */
export function renderFeedSummary(summary: FeedSummary): string {
  return renderPairs([
    ["agencies", String(summary.agencies)],
    ["stops", `${summary.stops} (${summary.boardableStops} boardable)`],
    ["routes", String(summary.routes)],
    ["trips", String(summary.trips)],
    ["calls", String(summary.calls)],
    ["services", String(summary.services)],
    ["shapes", String(summary.shapes)],
    ["transfers", String(summary.transfers)],
    ["fares", String(summary.fares)],
  ]);
}

/** Renders network statistics as a key/value block. */
export function renderNetworkStatistics(statistics: NetworkStatistics): string {
  const pairs: Array<readonly [string, string]> = [
    ["stops", `${statistics.stops} (${statistics.boardableStops} boardable)`],
    ["patterns", String(statistics.patterns)],
    ["trips", String(statistics.trips)],
    ["footpaths", String(statistics.footpaths)],
    ["overhang", `${statistics.overhangDays} day(s) past midnight`],
  ];
  if (statistics.overtakingPatterns > 0) {
    pairs.push([
      "overtaking",
      `${statistics.overtakingPatterns} pattern(s) use a linear trip search`,
    ]);
  }
  return renderPairs(pairs);
}

/** The one-line headline shown above a journey's legs. */
function headlineOf(itinerary: Itinerary, metrics: JourneyMetrics): string {
  const window = `${formatAbsoluteTime(itinerary.departure)} → ${formatAbsoluteTime(
    itinerary.arrival,
  )}`;
  return `${window}  ${summariseJourney(metrics)}`;
}
