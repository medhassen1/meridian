/**
 * `pathways.txt` and `levels.txt` — the walkable structure inside a station.
 *
 * Pathways describe how a passenger gets from a platform to a concourse to a
 * street entrance: stairs, escalators, lifts, corridors, fare gates. meridian
 * uses them for two things — a realistic in-station transfer time, and an
 * accessibility filter that can exclude a route no wheelchair user could take.
 */

import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** The `pathway_mode` enumeration. */
export enum PathwayMode {
  Walkway = 1,
  Stairs = 2,
  MovingSidewalk = 3,
  Escalator = 4,
  Elevator = 5,
  /** A gate requiring payment or a ticket check. */
  FareGate = 6,
  /** A gate that can only be passed in the exit direction. */
  ExitGate = 7,
}

/** One row of `pathways.txt`. */
export interface Pathway {
  readonly pathwayId: string;
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly pathwayMode: PathwayMode;
  readonly isBidirectional: boolean;
  readonly lengthMetres: number | undefined;
  readonly traversalTimeSeconds: number | undefined;
  readonly stairCount: number | undefined;
  readonly maxSlope: number | undefined;
  readonly minWidthMetres: number | undefined;
  readonly signpostedAs: string | undefined;
  readonly reversedSignpostedAs: string | undefined;
  readonly line: number;
}

/** One row of `levels.txt`. */
export interface Level {
  readonly levelId: string;
  /** Storey number; 0 is ground level and negative values are below it. */
  readonly levelIndex: number;
  readonly levelName: string | undefined;
  readonly line: number;
}

/** Columns without which `pathways.txt` can be read. */
export const PATHWAY_REQUIRED_COLUMNS: readonly string[] = [
  "pathway_id",
  "from_stop_id",
  "to_stop_id",
  "pathway_mode",
  "is_bidirectional",
];

/** Columns without which `levels.txt` can be read. */
export const LEVEL_REQUIRED_COLUMNS: readonly string[] = ["level_id", "level_index"];

/** Rule identifiers emitted by this module. */
export const PATHWAY_RULES = {
  exitGateBidirectional: "pathway.exit_gate_bidirectional",
  selfLoop: "pathway.self_loop",
  stairsWithoutCount: "pathway.stairs_without_count",
} as const;

/**
 * Default walking speed inside a station, in metres per second.
 *
 * Slower than open-air walking: concourses are crowded, and the figure is used
 * only when a pathway states a length but no traversal time.
 */
export const STATION_WALK_SPEED = 1.1;

/** Seconds added per stair, when a pathway states a stair count but no time. */
export const SECONDS_PER_STAIR = 1.5;

const PATHWAY_MODE_VALUES = [1, 2, 3, 4, 5, 6, 7];

/** Reads every pathway. */
export function readPathways(table: LoadedTable, sink: DiagnosticSink): Pathway[] {
  requireColumns(table, PATHWAY_REQUIRED_COLUMNS, sink);

  const pathways: Pathway[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const pathwayId = reader.requiredId("pathway_id");
    const fromStopId = reader.requiredId("from_stop_id");
    const toStopId = reader.requiredId("to_stop_id");
    const pathwayModeRaw = reader.enumeration("pathway_mode", PATHWAY_MODE_VALUES);
    const isBidirectional = reader.flag("is_bidirectional");
    if (
      pathwayId === undefined ||
      fromStopId === undefined ||
      toStopId === undefined ||
      pathwayModeRaw === undefined ||
      isBidirectional === undefined
    ) {
      continue;
    }
    const pathwayMode = pathwayModeRaw as PathwayMode;

    if (fromStopId === toStopId) {
      sink.error(
        PATHWAY_RULES.selfLoop,
        `pathway "${pathwayId}" connects stop "${fromStopId}" to itself`,
        row.positionOf("to_stop_id"),
      );
      continue;
    }
    if (pathwayMode === PathwayMode.ExitGate && isBidirectional) {
      sink.error(
        PATHWAY_RULES.exitGateBidirectional,
        `pathway "${pathwayId}" is an exit gate and cannot be bidirectional`,
        row.positionOf("is_bidirectional"),
      );
      continue;
    }

    const stairCount = reader.integer("stair_count");
    if (pathwayMode === PathwayMode.Stairs && stairCount === undefined) {
      sink.info(
        PATHWAY_RULES.stairsWithoutCount,
        `pathway "${pathwayId}" is stairs but states no stair_count, so its traversal time is estimated from length alone`,
        row.positionOf("stair_count"),
      );
    }

    pathways.push({
      pathwayId,
      fromStopId,
      toStopId,
      pathwayMode,
      isBidirectional,
      lengthMetres: reader.number("length", { min: 0 }),
      traversalTimeSeconds: reader.integer("traversal_time", { min: 0 }),
      stairCount,
      maxSlope: reader.number("max_slope"),
      minWidthMetres: reader.number("min_width", { min: 0 }),
      signpostedAs: reader.optionalText("signposted_as"),
      reversedSignpostedAs: reader.optionalText("reversed_signposted_as"),
      line: row.line,
    });
  }
  return pathways;
}

/** Reads every level. */
export function readLevels(table: LoadedTable, sink: DiagnosticSink): Level[] {
  requireColumns(table, LEVEL_REQUIRED_COLUMNS, sink);

  const levels: Level[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const levelId = reader.requiredId("level_id");
    const levelIndex = reader.requiredNumber("level_index");
    if (levelId === undefined || levelIndex === undefined) {
      continue;
    }
    levels.push({
      levelId,
      levelIndex,
      levelName: reader.optionalText("level_name"),
      line: row.line,
    });
  }
  return levels;
}

/**
 * Seconds needed to traverse a pathway.
 *
 * A published `traversal_time` is authoritative. Otherwise the time is
 * estimated from length at a station walking pace, plus a per-stair penalty,
 * with a floor of one second so that no pathway is free.
 */
export function traversalSeconds(pathway: Pathway): number {
  if (pathway.traversalTimeSeconds !== undefined) {
    return pathway.traversalTimeSeconds;
  }
  const walking =
    pathway.lengthMetres === undefined ? 0 : pathway.lengthMetres / STATION_WALK_SPEED;
  const stairs = pathway.stairCount === undefined ? 0 : Math.abs(pathway.stairCount) * SECONDS_PER_STAIR;
  return Math.max(1, Math.ceil(walking + stairs));
}

/**
 * True when a wheelchair user can traverse the pathway.
 *
 * Stairs are impassable. A pathway with a declared slope steeper than 1 in 12
 * — the gradient most accessibility codes cap ramps at — is also excluded.
 */
export function isStepFree(pathway: Pathway): boolean {
  if (pathway.pathwayMode === PathwayMode.Stairs) {
    return false;
  }
  if (pathway.stairCount !== undefined && pathway.stairCount !== 0) {
    return false;
  }
  if (pathway.maxSlope !== undefined && Math.abs(pathway.maxSlope) > 1 / 12) {
    return false;
  }
  return true;
}

/** True when the pathway can be traversed in the given direction. */
export function allowsDirection(pathway: Pathway, fromStopId: string): boolean {
  if (pathway.fromStopId === fromStopId) {
    return true;
  }
  return pathway.isBidirectional && pathway.toStopId === fromStopId;
}

/** A human readable name for a pathway mode, used in reports. */
export function pathwayModeName(mode: PathwayMode): string {
  switch (mode) {
    case PathwayMode.Walkway:
      return "walkway";
    case PathwayMode.Stairs:
      return "stairs";
    case PathwayMode.MovingSidewalk:
      return "moving walkway";
    case PathwayMode.Escalator:
      return "escalator";
    case PathwayMode.Elevator:
      return "lift";
    case PathwayMode.FareGate:
      return "fare gate";
    case PathwayMode.ExitGate:
      return "exit gate";
  }
}
