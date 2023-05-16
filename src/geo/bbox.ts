/**
 * Axis-aligned geographic bounding boxes.
 *
 * Boxes are used to describe a feed's spatial extent, to clip isochrone grids,
 * and to reject obviously-wrong stop coordinates. They deliberately do not
 * support wrapping across the antimeridian: a feed spanning it is rare enough,
 * and silently splitting a box in two would make `contains` ambiguous. The
 * validator reports such feeds instead.
 */

import { GeometryError } from "../errors.js";
import { coordinate, type Coordinate } from "./coordinate.js";
import { metresPerDegreeLatitude, metresPerDegreeLongitude } from "./distance.js";

/** An axis-aligned box in degrees, inclusive on every edge. */
export interface BoundingBox {
  readonly minLatitude: number;
  readonly minLongitude: number;
  readonly maxLatitude: number;
  readonly maxLongitude: number;
}

/**
 * Builds a box from its edges.
 *
 * @throws {GeometryError} if any edge is out of range or a minimum exceeds its
 * maximum.
 */
export function boundingBox(
  minLatitude: number,
  minLongitude: number,
  maxLatitude: number,
  maxLongitude: number,
): BoundingBox {
  // Validate the corners as coordinates so range checks live in one place.
  coordinate(minLatitude, minLongitude);
  coordinate(maxLatitude, maxLongitude);
  if (minLatitude > maxLatitude) {
    throw new GeometryError("bounding box minimum latitude exceeds its maximum", {
      minLatitude,
      maxLatitude,
    });
  }
  if (minLongitude > maxLongitude) {
    throw new GeometryError("bounding box minimum longitude exceeds its maximum", {
      minLongitude,
      maxLongitude,
    });
  }
  return Object.freeze({ minLatitude, minLongitude, maxLatitude, maxLongitude });
}

/**
 * The smallest box containing every input coordinate.
 *
 * @throws {GeometryError} if the input is empty.
 */
export function boundingBoxOf(coordinates: readonly Coordinate[]): BoundingBox {
  if (coordinates.length === 0) {
    throw new GeometryError("cannot take the bounding box of an empty coordinate set");
  }
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const point of coordinates) {
    if (point.latitude < minLat) {
      minLat = point.latitude;
    }
    if (point.latitude > maxLat) {
      maxLat = point.latitude;
    }
    if (point.longitude < minLon) {
      minLon = point.longitude;
    }
    if (point.longitude > maxLon) {
      maxLon = point.longitude;
    }
  }
  return boundingBox(minLat, minLon, maxLat, maxLon);
}

/** True when the coordinate lies inside the box or on its boundary. */
export function boxContains(box: BoundingBox, point: Coordinate): boolean {
  return (
    point.latitude >= box.minLatitude &&
    point.latitude <= box.maxLatitude &&
    point.longitude >= box.minLongitude &&
    point.longitude <= box.maxLongitude
  );
}

/** True when the two boxes share any area, including a shared edge. */
export function boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.minLatitude <= b.maxLatitude &&
    b.minLatitude <= a.maxLatitude &&
    a.minLongitude <= b.maxLongitude &&
    b.minLongitude <= a.maxLongitude
  );
}

/** The smallest box containing both inputs. */
export function unionBoxes(a: BoundingBox, b: BoundingBox): BoundingBox {
  return boundingBox(
    Math.min(a.minLatitude, b.minLatitude),
    Math.min(a.minLongitude, b.minLongitude),
    Math.max(a.maxLatitude, b.maxLatitude),
    Math.max(a.maxLongitude, b.maxLongitude),
  );
}

/** The shared area of two boxes, or `undefined` when they are disjoint. */
export function intersectBoxes(a: BoundingBox, b: BoundingBox): BoundingBox | undefined {
  if (!boxesIntersect(a, b)) {
    return undefined;
  }
  return boundingBox(
    Math.max(a.minLatitude, b.minLatitude),
    Math.max(a.minLongitude, b.minLongitude),
    Math.min(a.maxLatitude, b.maxLatitude),
    Math.min(a.maxLongitude, b.maxLongitude),
  );
}

/** The geometric centre of the box. */
export function boxCentre(box: BoundingBox): Coordinate {
  return coordinate(
    (box.minLatitude + box.maxLatitude) / 2,
    (box.minLongitude + box.maxLongitude) / 2,
  );
}

/**
 * Grows the box by `metres` on every side, clamped to the valid coordinate
 * range.
 *
 * Longitude padding is computed at the latitude furthest from the equator, so
 * the padded box is never narrower than requested anywhere along its height.
 */
export function padBox(box: BoundingBox, metres: number): BoundingBox {
  if (!Number.isFinite(metres) || metres < 0) {
    throw new GeometryError("padding must be finite and non-negative", { metres });
  }
  const latitudePad = metres / metresPerDegreeLatitude();
  const worstLatitude = Math.max(Math.abs(box.minLatitude), Math.abs(box.maxLatitude));
  const perDegree = metresPerDegreeLongitude(worstLatitude);
  // Near the poles a degree of longitude collapses; widen to the whole range
  // rather than dividing by an effectively zero denominator.
  const longitudePad = perDegree < 1 ? 360 : metres / perDegree;

  return boundingBox(
    Math.max(-90, box.minLatitude - latitudePad),
    Math.max(-180, box.minLongitude - longitudePad),
    Math.min(90, box.maxLatitude + latitudePad),
    Math.min(180, box.maxLongitude + longitudePad),
  );
}

/** Height of the box in degrees of latitude. */
export function boxHeightDegrees(box: BoundingBox): number {
  return box.maxLatitude - box.minLatitude;
}

/** Width of the box in degrees of longitude. */
export function boxWidthDegrees(box: BoundingBox): number {
  return box.maxLongitude - box.minLongitude;
}

/** True when the box encloses no area. */
export function isDegenerateBox(box: BoundingBox): boolean {
  return boxHeightDegrees(box) === 0 || boxWidthDegrees(box) === 0;
}

/** Renders `minLat,minLon,maxLat,maxLon` with six decimal places. */
export function formatBoundingBox(box: BoundingBox): string {
  return [box.minLatitude, box.minLongitude, box.maxLatitude, box.maxLongitude]
    .map((value) => value.toFixed(6))
    .join(",");
}
