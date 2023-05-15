/**
 * WGS 84 geographic coordinates.
 *
 * Coordinates are stored exactly as the feed supplies them. meridian does not
 * round or snap them on ingest: a stop's published position is part of the
 * agency's data, and quantising it would silently change walking distances and
 * therefore routing results.
 */

import { GeometryError } from "../errors.js";

/** A point on the WGS 84 ellipsoid. */
export interface Coordinate {
  /** Degrees north of the equator, -90 to 90. */
  readonly latitude: number;
  /** Degrees east of Greenwich, -180 to 180. */
  readonly longitude: number;
}

/** Latitude bound, in degrees. */
export const MAX_LATITUDE = 90;

/** Longitude bound, in degrees. */
export const MAX_LONGITUDE = 180;

/**
 * Builds a validated coordinate.
 *
 * @throws {GeometryError} if either component is not finite or falls outside
 * its valid range.
 */
export function coordinate(latitude: number, longitude: number): Coordinate {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeometryError("coordinate components must be finite", { latitude, longitude });
  }
  if (Math.abs(latitude) > MAX_LATITUDE) {
    throw new GeometryError(`latitude ${latitude} is outside ±90`, { latitude });
  }
  if (Math.abs(longitude) > MAX_LONGITUDE) {
    throw new GeometryError(`longitude ${longitude} is outside ±180`, { longitude });
  }
  return Object.freeze({ latitude, longitude });
}

/**
 * Wraps a longitude into `[-180, 180]`.
 *
 * Feeds occasionally publish longitudes past the antimeridian as values such
 * as 190; normalising them keeps distance computation correct instead of
 * rejecting an otherwise usable stop.
 */
export function normaliseLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) {
    throw new GeometryError("longitude must be finite", { longitude });
  }
  if (longitude >= -180 && longitude <= 180) {
    return longitude;
  }
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  // A value landing exactly on -180 is reported as 180 so that the two
  // representations of the antimeridian do not both appear in one feed.
  return wrapped === -180 ? 180 : wrapped;
}

/** Builds a coordinate, wrapping an out of range longitude rather than failing. */
export function coordinateNormalised(latitude: number, longitude: number): Coordinate {
  return coordinate(latitude, normaliseLongitude(longitude));
}

/**
 * True when two coordinates agree to within `epsilon` degrees on both axes.
 *
 * The default tolerance of 1e-7 degrees is roughly one centimetre, well below
 * the precision any feed publishes, so it compares "the same published point"
 * rather than "the same physical place".
 */
export function coordinatesEqual(a: Coordinate, b: Coordinate, epsilon = 1e-7): boolean {
  return (
    Math.abs(a.latitude - b.latitude) <= epsilon && Math.abs(a.longitude - b.longitude) <= epsilon
  );
}

/**
 * Total ordering by latitude then longitude.
 *
 * Used wherever a set of stops must be emitted in a stable order that does not
 * depend on insertion sequence.
 */
export function compareCoordinates(a: Coordinate, b: Coordinate): number {
  if (a.latitude !== b.latitude) {
    return a.latitude - b.latitude;
  }
  return a.longitude - b.longitude;
}

/** True when the coordinate sits at exactly 0°N 0°E. */
export function isNullIsland(value: Coordinate): boolean {
  return value.latitude === 0 && value.longitude === 0;
}

/**
 * Renders `lat,lon` with six decimal places, which is about 11 cm and is the
 * precision GTFS exporters conventionally publish.
 */
export function formatCoordinate(value: Coordinate): string {
  return `${value.latitude.toFixed(6)},${value.longitude.toFixed(6)}`;
}

/**
 * Parses the `lat,lon` form produced by {@link formatCoordinate}, tolerating
 * whitespace around either component.
 *
 * @throws {GeometryError} if the text is not two comma separated numbers.
 */
export function parseCoordinate(text: string): Coordinate {
  const parts = text.split(",");
  if (parts.length !== 2) {
    throw new GeometryError(`"${text}" is not a "lat,lon" pair`, { text });
  }
  const latitude = Number((parts[0] as string).trim());
  const longitude = Number((parts[1] as string).trim());
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new GeometryError(`"${text}" contains a non numeric component`, { text });
  }
  return coordinate(latitude, longitude);
}

/**
 * The midpoint of a set of coordinates, computed on the unit sphere.
 *
 * Averaging degrees directly would place the centroid of two points straddling
 * the antimeridian in the wrong hemisphere; converting to Cartesian vectors
 * first avoids that.
 *
 * @throws {GeometryError} if the input is empty.
 */
export function centroid(coordinates: readonly Coordinate[]): Coordinate {
  if (coordinates.length === 0) {
    throw new GeometryError("cannot take the centroid of an empty coordinate set");
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of coordinates) {
    const lat = toRadians(point.latitude);
    const lon = toRadians(point.longitude);
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon);
    y += cosLat * Math.sin(lon);
    z += Math.sin(lat);
  }
  const count = coordinates.length;
  x /= count;
  y /= count;
  z /= count;
  const hypotenuse = Math.sqrt(x * x + y * y);
  if (hypotenuse < 1e-12 && Math.abs(z) < 1e-12) {
    // The points cancel out — antipodal pairs have no meaningful midpoint, so
    // fall back to the first input rather than returning an arbitrary pole.
    return coordinates[0] as Coordinate;
  }
  return coordinateNormalised(
    toDegrees(Math.atan2(z, hypotenuse)),
    toDegrees(Math.atan2(y, x)),
  );
}

/** Degrees to radians. */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Radians to degrees. */
export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
