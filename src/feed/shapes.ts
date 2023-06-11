/**
 * `shapes.txt` — the path a vehicle physically takes between stops.
 *
 * Shapes affect no routing decision. They exist so that a rendered journey
 * follows the road rather than cutting across a river, and so that the
 * distance reported for a leg is the distance travelled rather than the
 * straight line between its endpoints.
 */

import { coordinate, type Coordinate } from "../geo/coordinate.js";
import { cumulativeDistances, polylineLength } from "../geo/polyline.js";
import { RowReader } from "../csv/schema.js";
import type { DiagnosticSink } from "../csv/sink.js";
import { position } from "../csv/position.js";
import { requireColumns, type LoadedTable } from "./table.js";

/** One row of `shapes.txt`. */
export interface ShapePoint {
  readonly shapeId: string;
  readonly coordinate: Coordinate;
  readonly sequence: number;
  /** The agency's own measure along the shape, when published. */
  readonly distTraveled: number | undefined;
  readonly line: number;
}

/** A complete shape: its points in order, with distances computed. */
export interface Shape {
  readonly shapeId: string;
  readonly points: readonly Coordinate[];
  /**
   * Metres from the first point to each point, computed by meridian.
   *
   * The feed's own `shape_dist_traveled` is kept separately in
   * {@link Shape.publishedDistances} because its unit is not specified — feeds
   * publish metres, kilometres, miles, and arbitrary counters — so it cannot
   * be compared against a computed distance.
   */
  readonly distances: readonly number[];
  /** The feed's own measure, when every point carried one. */
  readonly publishedDistances: readonly number[] | undefined;
  /** Total length in metres. */
  readonly lengthMetres: number;
}

/** Columns without which the table cannot be read. */
export const SHAPE_REQUIRED_COLUMNS: readonly string[] = [
  "shape_id",
  "shape_pt_lat",
  "shape_pt_lon",
  "shape_pt_sequence",
];

/** Rule identifiers emitted by this module. */
export const SHAPE_RULES = {
  duplicateSequence: "shape.duplicate_sequence",
  tooFewPoints: "shape.too_few_points",
  distanceNotIncreasing: "shape.distance_not_increasing",
  partialDistances: "shape.partial_distances",
} as const;

/** Reads every shape point, in file order. */
export function readShapePoints(table: LoadedTable, sink: DiagnosticSink): ShapePoint[] {
  requireColumns(table, SHAPE_REQUIRED_COLUMNS, sink);

  const points: ShapePoint[] = [];
  for (const row of table.rows) {
    const reader = new RowReader(row, sink);
    const shapeId = reader.requiredId("shape_id");
    const latitude = reader.latitude("shape_pt_lat");
    const longitude = reader.longitude("shape_pt_lon");
    const sequence = reader.requiredInteger("shape_pt_sequence", { min: 0 });
    if (
      shapeId === undefined ||
      latitude === undefined ||
      longitude === undefined ||
      sequence === undefined
    ) {
      continue;
    }

    points.push({
      shapeId,
      coordinate: coordinate(latitude, longitude),
      sequence,
      distTraveled: reader.number("shape_dist_traveled", { min: 0 }),
      line: row.line,
    });
  }
  return points;
}

/**
 * Assembles shape points into shapes, ordered by sequence.
 *
 * A shape with fewer than two distinct points is dropped: it cannot describe a
 * path, and keeping it would make every geometry consumer guard for the case.
 */
export function buildShapes(
  points: readonly ShapePoint[],
  file: string,
  sink: DiagnosticSink,
): Map<string, Shape> {
  const grouped = new Map<string, ShapePoint[]>();
  for (const point of points) {
    const existing = grouped.get(point.shapeId);
    if (existing === undefined) {
      grouped.set(point.shapeId, [point]);
    } else {
      existing.push(point);
    }
  }

  const shapes = new Map<string, Shape>();
  for (const [shapeId, group] of grouped) {
    group.sort((a, b) => a.sequence - b.sequence || a.line - b.line);

    const ordered: ShapePoint[] = [];
    for (const point of group) {
      const previous = ordered[ordered.length - 1];
      if (previous !== undefined && previous.sequence === point.sequence) {
        sink.error(
          SHAPE_RULES.duplicateSequence,
          `shape "${shapeId}" repeats shape_pt_sequence ${point.sequence}`,
          position(file, point.line, 1),
        );
        continue;
      }
      ordered.push(point);
    }

    if (ordered.length < 2) {
      sink.error(
        SHAPE_RULES.tooFewPoints,
        `shape "${shapeId}" has ${ordered.length} point(s); at least 2 are needed`,
        position(file, (ordered[0] ?? group[0] as ShapePoint).line, 1),
      );
      continue;
    }

    const coordinates = ordered.map((point) => point.coordinate);
    const published = collectPublishedDistances(shapeId, ordered, file, sink);

    shapes.set(shapeId, {
      shapeId,
      points: coordinates,
      distances: cumulativeDistances(coordinates),
      publishedDistances: published,
      lengthMetres: polylineLength(coordinates),
    });
  }
  return shapes;
}

/**
 * The feed's own distance measure, when every point carries one and the values
 * do not decrease.
 *
 * A partially populated column is discarded entirely rather than filled in:
 * interpolating a measure whose unit is unknown would produce numbers that
 * look authoritative and are not.
 */
function collectPublishedDistances(
  shapeId: string,
  points: readonly ShapePoint[],
  file: string,
  sink: DiagnosticSink,
): readonly number[] | undefined {
  const withDistance = points.filter((point) => point.distTraveled !== undefined);
  if (withDistance.length === 0) {
    return undefined;
  }
  if (withDistance.length !== points.length) {
    sink.warn(
      SHAPE_RULES.partialDistances,
      `shape "${shapeId}" publishes shape_dist_traveled for ${withDistance.length} of ${points.length} points; the measure is ignored`,
      position(file, (points[0] as ShapePoint).line, 1),
    );
    return undefined;
  }

  const distances = points.map((point) => point.distTraveled as number);
  for (let index = 1; index < distances.length; index += 1) {
    if ((distances[index] as number) < (distances[index - 1] as number)) {
      sink.warn(
        SHAPE_RULES.distanceNotIncreasing,
        `shape "${shapeId}" has a shape_dist_traveled that decreases at sequence ${
          (points[index] as ShapePoint).sequence
        }; the measure is ignored`,
        position(file, (points[index] as ShapePoint).line, 1),
      );
      return undefined;
    }
  }
  return distances;
}
