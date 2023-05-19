/**
 * Polylines: encoded geometry, cumulative measurement, and point projection.
 *
 * GTFS publishes vehicle paths in `shapes.txt` as an ordered list of points
 * with an optional distance measure. meridian needs three things from them:
 * a compact wire form for reports, the distance travelled between two stops
 * along the path, and the ability to place a stop on the path so a leg can be
 * clipped to its own portion of the shape.
 */

import { GeometryError } from "../errors.js";
import { coordinate, type Coordinate } from "./coordinate.js";
import { haversineDistance } from "./distance.js";

/** A point on a polyline, with the distance travelled to reach it. */
export interface MeasuredPoint {
  readonly point: Coordinate;
  /** Metres travelled along the polyline from its first point. */
  readonly distanceMetres: number;
}

/** The result of projecting an arbitrary coordinate onto a polyline. */
export interface Projection {
  /** The closest point on the polyline. */
  readonly point: Coordinate;
  /** Metres along the polyline at which that point sits. */
  readonly distanceAlongMetres: number;
  /** Metres between the query point and the polyline. */
  readonly offsetMetres: number;
  /** Index of the segment the projection landed on. */
  readonly segmentIndex: number;
}

/** Precision used by the Google encoded polyline format: five decimal places. */
const ENCODING_PRECISION = 1e5;

/**
 * Cumulative distance to each point, starting at zero.
 *
 * The returned array always has the same length as the input, so it can be
 * indexed alongside it.
 *
 * @throws {GeometryError} if the input is empty.
 */
export function cumulativeDistances(points: readonly Coordinate[]): number[] {
  if (points.length === 0) {
    throw new GeometryError("cannot measure an empty polyline");
  }
  const distances: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as Coordinate;
    const current = points[index] as Coordinate;
    distances.push((distances[index - 1] as number) + haversineDistance(previous, current));
  }
  return distances;
}

/** Total length of the polyline in metres. */
export function polylineLength(points: readonly Coordinate[]): number {
  const distances = cumulativeDistances(points);
  return distances[distances.length - 1] as number;
}

/**
 * The point sitting `distanceMetres` along the polyline.
 *
 * Distances before the start or past the end clamp to the endpoints rather
 * than extrapolating, because a stop measured slightly off the end of its
 * shape is a data quality issue, not a request to invent geometry.
 */
export function interpolateAt(points: readonly Coordinate[], distanceMetres: number): Coordinate {
  if (points.length === 0) {
    throw new GeometryError("cannot interpolate along an empty polyline");
  }
  if (points.length === 1 || distanceMetres <= 0) {
    return points[0] as Coordinate;
  }
  const distances = cumulativeDistances(points);
  const total = distances[distances.length - 1] as number;
  if (distanceMetres >= total) {
    return points[points.length - 1] as Coordinate;
  }

  // Binary search for the segment containing the requested distance.
  let low = 0;
  let high = distances.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((distances[mid] as number) <= distanceMetres) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const segmentStart = distances[low] as number;
  const segmentEnd = distances[high] as number;
  const span = segmentEnd - segmentStart;
  const fraction = span === 0 ? 0 : (distanceMetres - segmentStart) / span;
  return lerp(points[low] as Coordinate, points[high] as Coordinate, fraction);
}

/**
 * The portion of the polyline between two distances along it, inclusive of
 * interpolated endpoints.
 *
 * Used to clip a shape down to a single leg of a journey.
 */
export function sliceByDistance(
  points: readonly Coordinate[],
  fromMetres: number,
  toMetres: number,
): Coordinate[] {
  if (points.length === 0) {
    throw new GeometryError("cannot slice an empty polyline");
  }
  if (toMetres < fromMetres) {
    throw new GeometryError("slice end precedes its start", { fromMetres, toMetres });
  }
  const distances = cumulativeDistances(points);
  const total = distances[distances.length - 1] as number;
  const start = Math.max(0, Math.min(fromMetres, total));
  const end = Math.max(0, Math.min(toMetres, total));

  const sliced: Coordinate[] = [interpolateAt(points, start)];
  for (let index = 0; index < points.length; index += 1) {
    const at = distances[index] as number;
    if (at > start && at < end) {
      sliced.push(points[index] as Coordinate);
    }
  }
  sliced.push(interpolateAt(points, end));
  return sliced;
}

/**
 * Projects a coordinate onto the polyline, returning the nearest point on it.
 *
 * Each segment is treated as a straight line in an equirectangular projection
 * centred on the query point. Over the tens of metres that separate a stop
 * from its shape the distortion is negligible, and the flat-earth maths keeps
 * the search cheap enough to run for every stop of every trip.
 */
export function projectOnto(points: readonly Coordinate[], query: Coordinate): Projection {
  if (points.length === 0) {
    throw new GeometryError("cannot project onto an empty polyline");
  }
  if (points.length === 1) {
    const only = points[0] as Coordinate;
    return {
      point: only,
      distanceAlongMetres: 0,
      offsetMetres: haversineDistance(query, only),
      segmentIndex: 0,
    };
  }

  const distances = cumulativeDistances(points);
  let best: Projection | undefined;

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index] as Coordinate;
    const to = points[index + 1] as Coordinate;
    const fraction = segmentFraction(from, to, query);
    const candidate = lerp(from, to, fraction);
    const offsetMetres = haversineDistance(query, candidate);
    if (best === undefined || offsetMetres < best.offsetMetres) {
      const segmentStart = distances[index] as number;
      const segmentEnd = distances[index + 1] as number;
      best = {
        point: candidate,
        distanceAlongMetres: segmentStart + (segmentEnd - segmentStart) * fraction,
        offsetMetres,
        segmentIndex: index,
      };
    }
  }

  // The loop runs at least once because the single-point case returned early.
  return best as Projection;
}

/**
 * Encodes a polyline in the Google encoded polyline algorithm, precision 5.
 *
 * The algorithm is exercised here for its determinism as much as its size: the
 * same points always produce the same string, which makes report output
 * directly comparable.
 */
export function encodePolyline(points: readonly Coordinate[]): string {
  let previousLat = 0;
  let previousLon = 0;
  let encoded = "";
  for (const point of points) {
    const lat = Math.round(point.latitude * ENCODING_PRECISION);
    const lon = Math.round(point.longitude * ENCODING_PRECISION);
    encoded += encodeSignedNumber(lat - previousLat);
    encoded += encodeSignedNumber(lon - previousLon);
    previousLat = lat;
    previousLon = lon;
  }
  return encoded;
}

/**
 * Decodes a string produced by {@link encodePolyline}.
 *
 * @throws {GeometryError} if the string ends mid-value or decodes to an out of
 * range coordinate.
 */
export function decodePolyline(encoded: string): Coordinate[] {
  const points: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    const latResult = decodeSignedNumber(encoded, index);
    lat += latResult.value;
    const lonResult = decodeSignedNumber(encoded, latResult.nextIndex);
    lon += lonResult.value;
    index = lonResult.nextIndex;
    points.push(coordinate(lat / ENCODING_PRECISION, lon / ENCODING_PRECISION));
  }
  return points;
}

/**
 * Removes points that lie within `toleranceMetres` of the line joining their
 * neighbours, using the Douglas-Peucker algorithm.
 *
 * Shapes published at one point per second are far denser than any report
 * needs; simplifying them keeps output readable without moving the path.
 */
export function simplifyPolyline(
  points: readonly Coordinate[],
  toleranceMetres: number,
): Coordinate[] {
  if (!Number.isFinite(toleranceMetres) || toleranceMetres < 0) {
    throw new GeometryError("simplification tolerance must be finite and non-negative", {
      toleranceMetres,
    });
  }
  if (points.length <= 2) {
    return points.slice();
  }
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  simplifySegment(points, 0, points.length - 1, toleranceMetres, keep);
  return points.filter((_, index) => keep[index] === true);
}

function simplifySegment(
  points: readonly Coordinate[],
  first: number,
  last: number,
  tolerance: number,
  keep: boolean[],
): void {
  if (last <= first + 1) {
    return;
  }
  const from = points[first] as Coordinate;
  const to = points[last] as Coordinate;
  let worstIndex = -1;
  let worstOffset = tolerance;

  for (let index = first + 1; index < last; index += 1) {
    const candidate = points[index] as Coordinate;
    const fraction = segmentFraction(from, to, candidate);
    const offset = haversineDistance(candidate, lerp(from, to, fraction));
    if (offset > worstOffset) {
      worstOffset = offset;
      worstIndex = index;
    }
  }

  if (worstIndex === -1) {
    return;
  }
  keep[worstIndex] = true;
  simplifySegment(points, first, worstIndex, tolerance, keep);
  simplifySegment(points, worstIndex, last, tolerance, keep);
}

/**
 * Where along the segment `from`→`to` the perpendicular from `query` lands,
 * clamped to `[0, 1]`.
 */
function segmentFraction(from: Coordinate, to: Coordinate, query: Coordinate): number {
  // Scale longitude by cos(latitude) so the two axes carry comparable
  // distance, then do plain 2D vector projection.
  const scale = Math.cos((query.latitude * Math.PI) / 180);
  const dx = (to.longitude - from.longitude) * scale;
  const dy = to.latitude - from.latitude;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return 0;
  }
  const qx = (query.longitude - from.longitude) * scale;
  const qy = query.latitude - from.latitude;
  const fraction = (qx * dx + qy * dy) / lengthSquared;
  return Math.max(0, Math.min(1, fraction));
}

function lerp(from: Coordinate, to: Coordinate, fraction: number): Coordinate {
  return coordinate(
    from.latitude + (to.latitude - from.latitude) * fraction,
    from.longitude + (to.longitude - from.longitude) * fraction,
  );
}

function encodeSignedNumber(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";
  while (shifted >= 0x20) {
    encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  encoded += String.fromCharCode(shifted + 63);
  return encoded;
}

function decodeSignedNumber(encoded: string, start: number): { value: number; nextIndex: number } {
  let index = start;
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    if (index >= encoded.length) {
      throw new GeometryError("encoded polyline ended mid-value", { index: start });
    }
    byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);

  const value = result & 1 ? ~(result >> 1) : result >> 1;
  return { value, nextIndex: index };
}
