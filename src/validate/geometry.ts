/**
 * Checks over coordinates and implied vehicle motion.
 *
 * Geometry catches the errors that times alone cannot. A stop whose latitude
 * and longitude were swapped still parses; it just sits in the sea. A trip
 * whose calls are in the wrong order still has increasing times; it just
 * implies a bus doing 400 km/h.
 */

import { boundingBoxOf, boxWidthDegrees } from "../geo/bbox.js";
import { haversineDistance } from "../geo/distance.js";
import { projectOnto } from "../geo/polyline.js";
import { RouteType, routeTypeName } from "../feed/routes.js";
import { TABLES } from "../feed/source.js";
import { isBoardable } from "../feed/stops.js";
import type { Coordinate } from "../geo/coordinate.js";
import { at, type Validator } from "./context.js";

/**
 * Top speed considered plausible for each mode, in metres per second.
 *
 * Generous on purpose: these catch swapped coordinates and misordered calls,
 * not marginal timetable optimism. Straight line distance always understates
 * the real path, so a violation here is a strong signal.
 */
export const MAX_SPEED_BY_MODE: Readonly<Record<RouteType, number>> = {
  [RouteType.Tram]: 30,
  [RouteType.Subway]: 45,
  [RouteType.Rail]: 100,
  [RouteType.Bus]: 40,
  [RouteType.Ferry]: 30,
  [RouteType.CableTram]: 15,
  [RouteType.AerialLift]: 15,
  [RouteType.Funicular]: 15,
  [RouteType.Trolleybus]: 35,
  [RouteType.Monorail]: 40,
};

/** Metres a stop may sit from its trip's shape before it is reported. */
export const MAX_SHAPE_OFFSET_METRES = 250;

/**
 * Multiple of the median stop-to-centroid distance beyond which a stop counts
 * as an outlier.
 */
export const OUTLIER_FACTOR = 12;

/** Reports vehicle speeds no vehicle of that mode could reach. */
export const validateImpliedSpeeds: Validator = ({ feed }, report) => {
  for (const trip of feed.trips) {
    const route = feed.routeById.get(trip.routeId);
    const limit = route === undefined ? MAX_SPEED_BY_MODE[RouteType.Rail] : MAX_SPEED_BY_MODE[route.routeType];

    for (let index = 1; index < trip.calls.length; index += 1) {
      const previous = trip.calls[index - 1];
      const current = trip.calls[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      const from = feed.stopById.get(previous.stopId)?.coordinate;
      const to = feed.stopById.get(current.stopId)?.coordinate;
      if (from === undefined || to === undefined) {
        continue;
      }
      const seconds = current.arrivalTime - previous.departureTime;
      if (seconds <= 0) {
        // Reported by the temporal zero-length-hop rule; skipping avoids a
        // division by zero and a duplicate complaint about the same row.
        continue;
      }
      const metres = haversineDistance(from, to);
      const speed = metres / seconds;
      if (speed > limit) {
        const mode = route === undefined ? "unknown mode" : routeTypeName(route.routeType);
        report.emit(
          "geo.implausible_speed",
          `trip "${trip.tripId}" implies ${speed.toFixed(1)} m/s between "${previous.stopId}" and "${current.stopId}", above the ${limit} m/s limit for ${mode}`,
          at(TABLES.stopTimes, current.line),
        );
      }
    }
  }
};

/**
 * Reports distinct stops sharing one coordinate.
 *
 * Usually harmless — two platforms genuinely at the same point — but it also
 * marks the case where a whole block of stops was exported with a placeholder
 * position, which breaks footpath generation completely.
 */
export const validateDuplicatePositions: Validator = ({ feed }, report) => {
  const byPosition = new Map<string, string[]>();
  for (const stop of feed.stops) {
    if (stop.coordinate === undefined || !isBoardable(stop)) {
      continue;
    }
    const key = `${stop.coordinate.latitude.toFixed(6)},${stop.coordinate.longitude.toFixed(6)}`;
    const existing = byPosition.get(key);
    if (existing === undefined) {
      byPosition.set(key, [stop.stopId]);
    } else {
      existing.push(stop.stopId);
    }
  }

  for (const [key, stopIds] of Array.from(byPosition.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (stopIds.length > 1) {
      report.emit(
        "geo.duplicate_position",
        `${stopIds.length} stops share the position ${key}: ${stopIds.slice(0, 5).join(", ")}${
          stopIds.length > 5 ? ", …" : ""
        }`,
        at(TABLES.stops, 1),
      );
    }
  }
};

/**
 * Reports stops far outside the cluster the rest of the feed occupies.
 *
 * Both the reference point and the threshold are medians rather than means,
 * and that matters twice over. A single stop at 0,0 drags a centroid hundreds
 * of kilometres towards itself, far enough that it no longer looks unusual
 * against the others — the outlier hides inside the statistic meant to catch
 * it. A component-wise median position barely moves, and a threshold taken as
 * a multiple of the median distance from it stays anchored to where the
 * network actually is.
 */
export const validateOutlierStops: Validator = ({ feed }, report) => {
  const located = feed.stops.filter(
    (stop) => stop.coordinate !== undefined && isBoardable(stop),
  );
  if (located.length < 4) {
    return;
  }

  const points = located.map((stop) => stop.coordinate as Coordinate);
  const centre = medianPosition(points);
  const distances = points.map((point) => haversineDistance(centre, point));
  const median = medianOf(distances);
  if (median <= 0) {
    return;
  }
  const threshold = median * OUTLIER_FACTOR;

  for (let index = 0; index < located.length; index += 1) {
    const distance = distances[index] as number;
    if (distance > threshold) {
      const stop = located[index];
      if (stop === undefined) {
        continue;
      }
      report.emit(
        "geo.outlier_stop",
        `stop "${stop.stopId}" sits ${(distance / 1000).toFixed(1)} km from the feed centre, far outside the rest of the network`,
        at(TABLES.stops, stop.line),
      );
    }
  }
};

/**
 * Reports a feed whose bounding box spans most of the globe, which is what an
 * antimeridian crossing looks like to an axis-aligned box.
 */
export const validateAntimeridian: Validator = ({ feed }, report) => {
  const points = feed.stops
    .map((stop) => stop.coordinate)
    .filter((point): point is Coordinate => point !== undefined);
  if (points.length === 0) {
    return;
  }
  const box = boundingBoxOf(points);
  if (boxWidthDegrees(box) > 180) {
    report.emit(
      "geo.antimeridian",
      "the feed's stops span more than 180° of longitude; bounding box and spatial index results will be wrong",
      at(TABLES.stops, 1),
    );
  }
};

/**
 * Reports stops that sit far from the shape their trip is supposed to follow.
 *
 * Checked once per (shape, stop) pair rather than once per trip: a feed with
 * ten thousand trips on fifty shapes would otherwise repeat the same finding
 * thousands of times.
 */
export const validateShapeProximity: Validator = ({ feed }, report) => {
  const checked = new Set<string>();

  for (const trip of feed.trips) {
    if (trip.shapeId === undefined) {
      continue;
    }
    const shape = feed.shapes.get(trip.shapeId);
    if (shape === undefined) {
      continue;
    }

    for (const call of trip.calls) {
      const key = `${trip.shapeId},${call.stopId}`;
      if (checked.has(key)) {
        continue;
      }
      checked.add(key);

      const point = feed.stopById.get(call.stopId)?.coordinate;
      if (point === undefined) {
        continue;
      }
      const projection = projectOnto(shape.points, point);
      if (projection.offsetMetres > MAX_SHAPE_OFFSET_METRES) {
        report.emit(
          "geo.shape_far_from_stop",
          `stop "${call.stopId}" sits ${Math.round(
            projection.offsetMetres,
          )} m from shape "${trip.shapeId}"`,
          at(TABLES.stopTimes, call.line),
        );
      }
    }
  }
};

/** Reports boardable stops that no trip calls at. */
export const validateStopCoverage: Validator = ({ feed }, report) => {
  const served = new Set<string>();
  for (const trip of feed.trips) {
    for (const call of trip.calls) {
      served.add(call.stopId);
    }
  }
  for (const stop of feed.stops) {
    if (isBoardable(stop) && !served.has(stop.stopId)) {
      report.emit(
        "cover.unserved_stop",
        `stop "${stop.stopId}" is boardable but no trip calls at it`,
        at(TABLES.stops, stop.line),
      );
    }
  }
};

/** Every geometry validator, in the order a report reads best. */
export const GEOMETRY_VALIDATORS: readonly Validator[] = [
  validateImpliedSpeeds,
  validateDuplicatePositions,
  validateOutlierStops,
  validateAntimeridian,
  validateShapeProximity,
  validateStopCoverage,
];

/** The median of a non-empty list, taking the lower of two middles. */
function medianOf(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle] ?? 0;
}

/**
 * The component-wise median of a set of points.
 *
 * Not a true geometric median, but it needs no iteration and it is resistant
 * to outliers in exactly the way this check requires. A feed spanning the
 * antimeridian would confuse it; that case has its own rule.
 */
function medianPosition(points: readonly Coordinate[]): Coordinate {
  return {
    latitude: medianOf(points.map((point) => point.latitude)),
    longitude: medianOf(points.map((point) => point.longitude)),
  };
}
