/**
 * Turning reachable stops into a map layer.
 *
 * A list of stops with travel times is the honest result of a reachability
 * search, but it is not what a map wants. This module bins the stops into
 * travel-time bands and rasterises them onto a regular grid, so that a caller
 * can render bands of colour without meridian pretending to know where the
 * streets are.
 *
 * The grid is deliberately coarse and the interpolation deliberately simple.
 * Drawing a smooth polygon around a set of transit stops implies knowledge of
 * the walking network between them, which no GTFS feed contains; a visible
 * grid is honest about the resolution of its input.
 */

import { GeometryError } from "../errors.js";
import { boundingBoxOf, padBox, type BoundingBox } from "../geo/bbox.js";
import { coordinate, type Coordinate } from "../geo/coordinate.js";
import { haversineDistance } from "../geo/distance.js";
import type { ReachedStop, ReachResult } from "./reach.js";

/** One travel-time band. */
export interface ContourBand {
  /** Upper bound of the band, in seconds. */
  readonly budgetSeconds: number;
  /** Stops falling inside this band and no tighter one. */
  readonly stops: readonly ReachedStop[];
}

/** One cell of a rasterised isochrone. */
export interface GridCell {
  readonly row: number;
  readonly column: number;
  readonly centre: Coordinate;
  /**
   * Travel time attributed to the cell, or `undefined` when no stop is close
   * enough to attribute one.
   */
  readonly seconds: number | undefined;
}

/** A rasterised isochrone. */
export interface ContourGrid {
  readonly bounds: BoundingBox;
  readonly rows: number;
  readonly columns: number;
  /** Cells in row-major order. */
  readonly cells: readonly GridCell[];
  /** Metres a cell centre may sit from a stop and still take its time. */
  readonly influenceMetres: number;
}

/** Default distance a stop's travel time is attributed over, in metres. */
export const DEFAULT_INFLUENCE_METRES = 500;

/** Default number of rows and columns in a rasterised isochrone. */
export const DEFAULT_GRID_RESOLUTION = 32;

/**
 * Groups reached stops into travel-time bands.
 *
 * Each stop lands in exactly the tightest band that contains it, so bands
 * partition the result rather than nesting. Budgets are sorted ascending and
 * deduplicated; stops beyond the widest band are dropped.
 */
export function bandsOf(result: ReachResult, budgets: readonly number[]): ContourBand[] {
  const sorted = Array.from(new Set(budgets)).sort((a, b) => a - b);
  const buckets: ReachedStop[][] = sorted.map(() => []);

  for (const stop of result.reached) {
    const index = sorted.findIndex((budget) => stop.seconds <= budget);
    if (index === -1) {
      continue;
    }
    (buckets[index] as ReachedStop[]).push(stop);
  }

  return sorted.map((budgetSeconds, index) => ({
    budgetSeconds,
    stops: buckets[index] as ReachedStop[],
  }));
}

/**
 * Rasterises a reachability result onto a regular grid.
 *
 * Each cell takes the travel time of the nearest reached stop within
 * `influenceMetres`, plus the time it would take to walk from that stop to the
 * cell. Cells with no stop in range are left undefined rather than
 * extrapolated.
 *
 * @throws {GeometryError} if the resolution or influence radius is not
 * positive, or the result reached no stop at all.
 */
export function rasterise(
  result: ReachResult,
  options: {
    resolution?: number;
    influenceMetres?: number;
    walkSpeed?: number;
  } = {},
): ContourGrid {
  const resolution = options.resolution ?? DEFAULT_GRID_RESOLUTION;
  const influenceMetres = options.influenceMetres ?? DEFAULT_INFLUENCE_METRES;
  const walkSpeed = options.walkSpeed ?? 1.3;

  if (!Number.isInteger(resolution) || resolution < 2) {
    throw new GeometryError("grid resolution must be an integer of at least 2", { resolution });
  }
  if (!Number.isFinite(influenceMetres) || influenceMetres <= 0) {
    throw new GeometryError("influence radius must be finite and positive", { influenceMetres });
  }
  if (result.reached.length === 0) {
    throw new GeometryError("cannot rasterise a result that reached no stops");
  }

  const points = result.reached.map((stop) => coordinate(stop.latitude, stop.longitude));
  const bounds = padBox(boundingBoxOf(points), influenceMetres);

  const latitudeStep = (bounds.maxLatitude - bounds.minLatitude) / resolution;
  const longitudeStep = (bounds.maxLongitude - bounds.minLongitude) / resolution;
  const cells: GridCell[] = [];

  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const centre = coordinate(
        bounds.minLatitude + latitudeStep * (row + 0.5),
        bounds.minLongitude + longitudeStep * (column + 0.5),
      );

      let best: number | undefined;
      for (let index = 0; index < result.reached.length; index += 1) {
        const stop = result.reached[index] as ReachedStop;
        const distance = haversineDistance(centre, points[index] as Coordinate);
        if (distance > influenceMetres) {
          continue;
        }
        const total = stop.seconds + Math.ceil(distance / walkSpeed);
        if (best === undefined || total < best) {
          best = total;
        }
      }

      cells.push({ row, column, centre, seconds: best });
    }
  }

  return { bounds, rows: resolution, columns: resolution, cells, influenceMetres };
}

/** The cells of a grid whose time falls inside a budget, in row-major order. */
export function cellsWithin(grid: ContourGrid, budgetSeconds: number): GridCell[] {
  return grid.cells.filter(
    (cell) => cell.seconds !== undefined && cell.seconds <= budgetSeconds,
  );
}

/**
 * The proportion of the grid covered within a budget.
 *
 * A crude accessibility figure, but a comparable one: two origins rasterised
 * over the same bounds can be ranked by it.
 */
export function coverageRatio(grid: ContourGrid, budgetSeconds: number): number {
  if (grid.cells.length === 0) {
    return 0;
  }
  return cellsWithin(grid, budgetSeconds).length / grid.cells.length;
}

/**
 * Renders the grid as ASCII, one character per cell, tightest band densest.
 *
 * Intended for a terminal and for test assertions, where a picture of the
 * result is far more legible than a list of cell times.
 */
export function renderGrid(grid: ContourGrid, budgets: readonly number[]): string {
  const sorted = Array.from(new Set(budgets)).sort((a, b) => a - b);
  const glyphs = ["#", "+", ":", ".", " "];
  const lines: string[] = [];

  // Rows are emitted north first, so the picture matches a map.
  for (let row = grid.rows - 1; row >= 0; row -= 1) {
    let line = "";
    for (let column = 0; column < grid.columns; column += 1) {
      const cell = grid.cells[row * grid.columns + column] as GridCell;
      if (cell.seconds === undefined) {
        line += " ";
        continue;
      }
      const band = sorted.findIndex((budget) => (cell.seconds as number) <= budget);
      line += band === -1 ? " " : (glyphs[Math.min(band, glyphs.length - 1)] as string);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Serialises the reachable stops as GeoJSON points.
 *
 * Points rather than polygons, for the reason given at the top of this file:
 * a polygon would claim knowledge of the space between stops that the input
 * does not contain. Keys are emitted in a fixed order so output is stable.
 */
export function toGeoJson(result: ReachResult): string {
  const features = result.reached.map((stop) => ({
    geometry: {
      coordinates: [stop.longitude, stop.latitude],
      type: "Point",
    },
    properties: {
      boardings: stop.boardings,
      seconds: stop.seconds,
      stop_id: stop.stopId,
      stop_name: stop.stopName,
    },
    type: "Feature",
  }));

  return JSON.stringify({ features, type: "FeatureCollection" }, null, 2);
}
