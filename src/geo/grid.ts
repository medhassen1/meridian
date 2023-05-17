/**
 * A uniform spatial hash over geographic points.
 *
 * Footpath generation asks "which stops are within N metres of this one" for
 * every stop in the feed. Done naively that is quadratic, and a feed with
 * 40,000 stops makes it the dominant cost of building a network. A hash grid
 * reduces it to a scan of the cells overlapping the query radius.
 *
 * A grid, rather than a k-d tree, because the query radius is fixed and small:
 * cell lookup is constant time, insertion order does not affect the structure,
 * and the whole thing rebuilds from scratch in one pass.
 */

import { GeometryError } from "../errors.js";
import type { Coordinate } from "./coordinate.js";
import {
  approximateDistance,
  haversineDistance,
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
} from "./distance.js";

/** An entry returned by a radius query, with its exact distance. */
export interface GridMatch<T> {
  /** The stored value. */
  readonly value: T;
  /** Great circle distance from the query point, in metres. */
  readonly distanceMetres: number;
}

interface GridEntry<T> {
  readonly value: T;
  readonly point: Coordinate;
  /** Insertion index, used only to break distance ties deterministically. */
  readonly sequence: number;
}

/**
 * A spatial hash keyed by fixed-size latitude and longitude cells.
 *
 * Instances are append-only: values may be inserted at any time and every
 * query reflects everything inserted so far. Queries never mutate the grid, so
 * a fully built grid may be shared freely.
 */
export class SpatialGrid<T> {
  private readonly cells = new Map<string, GridEntry<T>[]>();
  private readonly latitudeCellDegrees: number;
  private readonly longitudeCellDegrees: number;
  private sequence = 0;

  /**
   * @param cellSizeMetres Approximate edge length of a cell. Queries whose
   * radius is close to this value touch a 3×3 block of cells; much smaller
   * cells increase bookkeeping without reducing candidates.
   * @param referenceLatitude Latitude at which the longitude cell width is
   * computed. Passing the centre of the feed keeps cells roughly square.
   */
  constructor(cellSizeMetres: number, referenceLatitude = 0) {
    if (!Number.isFinite(cellSizeMetres) || cellSizeMetres <= 0) {
      throw new GeometryError("grid cell size must be finite and positive", { cellSizeMetres });
    }
    if (!Number.isFinite(referenceLatitude) || Math.abs(referenceLatitude) > 90) {
      throw new GeometryError("grid reference latitude is out of range", { referenceLatitude });
    }
    this.latitudeCellDegrees = cellSizeMetres / metresPerDegreeLatitude();
    const perDegree = metresPerDegreeLongitude(referenceLatitude);
    // Near the poles longitude degrees carry almost no distance; fall back to a
    // single longitude column rather than producing an unbounded cell count.
    this.longitudeCellDegrees = perDegree < 1 ? 360 : cellSizeMetres / perDegree;
  }

  /** Number of values stored. */
  get size(): number {
    return this.sequence;
  }

  /** Number of occupied cells, exposed for diagnostics and tests. */
  get cellCount(): number {
    return this.cells.size;
  }

  /** Stores a value at a point. The same value may be inserted more than once. */
  insert(point: Coordinate, value: T): void {
    const key = this.cellKey(point.latitude, point.longitude);
    const bucket = this.cells.get(key);
    const entry: GridEntry<T> = { value, point, sequence: this.sequence };
    this.sequence += 1;
    if (bucket === undefined) {
      this.cells.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  /** Stores every value in one pass, using `locate` to read each point. */
  insertAll(values: Iterable<T>, locate: (value: T) => Coordinate): void {
    for (const value of values) {
      this.insert(locate(value), value);
    }
  }

  /**
   * Every stored value within `radiusMetres` of `point`, ordered by ascending
   * distance and then by insertion order.
   *
   * Ordering is total and independent of the internal cell layout, so two
   * grids built from the same values in the same order answer identically.
   */
  within(point: Coordinate, radiusMetres: number): GridMatch<T>[] {
    if (!Number.isFinite(radiusMetres) || radiusMetres < 0) {
      throw new GeometryError("query radius must be finite and non-negative", { radiusMetres });
    }
    const matches: Array<GridMatch<T> & { sequence: number }> = [];
    for (const entry of this.candidates(point, radiusMetres)) {
      // Reject with the cheap metric first; it never underestimates by enough
      // to discard a true match at these radii.
      if (approximateDistance(point, entry.point) > radiusMetres * 1.05) {
        continue;
      }
      const distanceMetres = haversineDistance(point, entry.point);
      if (distanceMetres <= radiusMetres) {
        matches.push({ value: entry.value, distanceMetres, sequence: entry.sequence });
      }
    }
    matches.sort((a, b) => a.distanceMetres - b.distanceMetres || a.sequence - b.sequence);
    return matches.map(({ value, distanceMetres }) => ({ value, distanceMetres }));
  }

  /**
   * The `count` nearest stored values to `point`, searching only inside
   * `maxRadiusMetres`.
   *
   * Returns fewer than `count` when the radius holds fewer values; it does not
   * widen the search, so the cost stays bounded.
   */
  nearest(point: Coordinate, count: number, maxRadiusMetres: number): GridMatch<T>[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new GeometryError("nearest count must be a non-negative integer", { count });
    }
    return this.within(point, maxRadiusMetres).slice(0, count);
  }

  /** Removes every stored value. */
  clear(): void {
    this.cells.clear();
    this.sequence = 0;
  }

  /**
   * Yields the entries of every cell overlapping the query disc.
   *
   * The cell block is computed from the radius rather than assumed to be 3×3,
   * so a query wider than one cell still returns every candidate.
   */
  private *candidates(point: Coordinate, radiusMetres: number): Generator<GridEntry<T>> {
    const latitudeSpan = Math.ceil(
      radiusMetres / metresPerDegreeLatitude() / this.latitudeCellDegrees,
    );
    const perDegree = metresPerDegreeLongitude(point.latitude);
    const longitudeSpan =
      perDegree < 1
        ? 0
        : Math.ceil(radiusMetres / perDegree / this.longitudeCellDegrees);

    const centreLat = Math.floor(point.latitude / this.latitudeCellDegrees);
    const centreLon = Math.floor(point.longitude / this.longitudeCellDegrees);

    for (let latOffset = -latitudeSpan; latOffset <= latitudeSpan; latOffset += 1) {
      for (let lonOffset = -longitudeSpan; lonOffset <= longitudeSpan; lonOffset += 1) {
        const bucket = this.cells.get(`${centreLat + latOffset}:${centreLon + lonOffset}`);
        if (bucket !== undefined) {
          yield* bucket;
        }
      }
    }
  }

  private cellKey(latitude: number, longitude: number): string {
    const latCell = Math.floor(latitude / this.latitudeCellDegrees);
    const lonCell = Math.floor(longitude / this.longitudeCellDegrees);
    return `${latCell}:${lonCell}`;
  }
}

/**
 * Builds a grid sized for a given query radius.
 *
 * Cells one query radius wide keep the candidate block at 3×3, which is the
 * point where cell bookkeeping and candidate filtering are balanced.
 */
export function gridForRadius<T>(radiusMetres: number, referenceLatitude = 0): SpatialGrid<T> {
  return new SpatialGrid<T>(Math.max(radiusMetres, 1), referenceLatitude);
}
