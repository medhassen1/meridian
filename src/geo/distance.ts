/**
 * Distance and bearing on a spherical earth.
 *
 * A sphere, not an ellipsoid: the ~0.3% error against WGS 84 is far smaller
 * than the error already introduced by treating a walking transfer as a
 * straight line, and the spherical formulae are cheap enough to run inside the
 * footpath generator's inner loop.
 */

import { GeometryError } from "../errors.js";
import { toDegrees, toRadians, type Coordinate } from "./coordinate.js";

/** Mean earth radius in metres, as used by the IUGG. */
export const EARTH_RADIUS_METRES = 6_371_008.8;

/**
 * Great circle distance in metres.
 *
 * Uses the haversine form, which stays numerically stable for the short
 * distances that dominate transfer generation, where the law of cosines loses
 * precision.
 */
export function haversineDistance(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b.longitude - a.longitude);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Equirectangular approximation of the distance in metres.
 *
 * Roughly four times cheaper than haversine and accurate to better than 0.1%
 * within a few kilometres. The spatial grid uses it to reject candidates
 * before paying for the exact computation.
 */
export function approximateDistance(a: Coordinate, b: Coordinate): number {
  const meanLat = toRadians((a.latitude + b.latitude) / 2);
  const x = toRadians(b.longitude - a.longitude) * Math.cos(meanLat);
  const y = toRadians(b.latitude - a.latitude);
  return EARTH_RADIUS_METRES * Math.sqrt(x * x + y * y);
}

/**
 * Initial bearing from `a` to `b`, in degrees clockwise from true north,
 * normalised to `[0, 360)`.
 *
 * Two identical points have no defined bearing; zero is returned so that
 * callers rendering a compass label do not have to special case it.
 */
export function initialBearing(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  if (y === 0 && x === 0) {
    return 0;
  }
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** The sixteen point compass label nearest to a bearing in degrees. */
export function compassPoint(bearingDegrees: number): string {
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const normalised = ((bearingDegrees % 360) + 360) % 360;
  const index = Math.round(normalised / 22.5) % 16;
  return points[index] as string;
}

/**
 * The point reached by travelling `distanceMetres` from `origin` along
 * `bearingDegrees`.
 *
 * Used to build the corner points of a padded bounding box and to generate
 * deterministic synthetic feeds in tests.
 */
export function destinationPoint(
  origin: Coordinate,
  bearingDegrees: number,
  distanceMetres: number,
): Coordinate {
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) {
    throw new GeometryError("distance must be finite and non-negative", { distanceMetres });
  }
  const angular = distanceMetres / EARTH_RADIUS_METRES;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(origin.latitude);
  const lon1 = toRadians(origin.longitude);

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * sinLat2,
    );

  return {
    latitude: toDegrees(lat2),
    longitude: (((toDegrees(lon2) + 540) % 360) - 180),
  };
}

/**
 * Metres of latitude per degree, constant to the precision this library needs.
 */
export function metresPerDegreeLatitude(): number {
  return (Math.PI * EARTH_RADIUS_METRES) / 180;
}

/**
 * Metres of longitude per degree at a given latitude.
 *
 * Collapses to zero at the poles, so callers dividing by it must guard. The
 * spatial grid does, by clamping its cell width.
 */
export function metresPerDegreeLongitude(latitude: number): number {
  return metresPerDegreeLatitude() * Math.cos(toRadians(latitude));
}

/**
 * Walking time in seconds for a straight line distance, at a fixed speed.
 *
 * A constant speed with a straightness factor is intentionally crude: without
 * a street network there is no honest way to model real walking routes, and a
 * documented constant is easier to reason about than a false precision. The
 * factor of 1.4 is the ratio commonly observed between street distance and
 * straight line distance in dense urban grids.
 */
export function walkingSeconds(
  distanceMetres: number,
  metresPerSecond: number,
  straightnessFactor = 1.4,
): number {
  if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) {
    throw new GeometryError("walking speed must be finite and positive", { metresPerSecond });
  }
  if (!Number.isFinite(straightnessFactor) || straightnessFactor < 1) {
    throw new GeometryError("straightness factor must be at least 1", { straightnessFactor });
  }
  return Math.ceil((distanceMetres * straightnessFactor) / metresPerSecond);
}
