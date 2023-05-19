/**
 * Geographic primitives: coordinates, distance, bounding boxes, spatial
 * indexing, and polyline geometry.
 */

export {
  type Coordinate,
  MAX_LATITUDE,
  MAX_LONGITUDE,
  coordinate,
  coordinateNormalised,
  normaliseLongitude,
  coordinatesEqual,
  compareCoordinates,
  isNullIsland,
  formatCoordinate,
  parseCoordinate,
  centroid,
  toRadians,
  toDegrees,
} from "./coordinate.js";

export {
  EARTH_RADIUS_METRES,
  haversineDistance,
  approximateDistance,
  initialBearing,
  compassPoint,
  destinationPoint,
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
  walkingSeconds,
} from "./distance.js";

export {
  type BoundingBox,
  boundingBox,
  boundingBoxOf,
  boxContains,
  boxesIntersect,
  unionBoxes,
  intersectBoxes,
  boxCentre,
  padBox,
  boxHeightDegrees,
  boxWidthDegrees,
  isDegenerateBox,
  formatBoundingBox,
} from "./bbox.js";

export { type GridMatch, SpatialGrid, gridForRadius } from "./grid.js";

export {
  type MeasuredPoint,
  type Projection,
  cumulativeDistances,
  polylineLength,
  interpolateAt,
  sliceByDistance,
  projectOnto,
  encodePolyline,
  decodePolyline,
  simplifyPolyline,
} from "./polyline.js";
