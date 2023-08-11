/**
 * Reachability: where a passenger can get to inside a time budget, and how to
 * put that on a map.
 */

export {
  type ReachRequest,
  type ReachedStop,
  type ReachResult,
  DEFAULT_REACH_BOARDINGS,
  computeReach,
  reachProfile,
  within,
  furthestStop,
} from "./reach.js";

export {
  type ContourBand,
  type GridCell,
  type ContourGrid,
  DEFAULT_INFLUENCE_METRES,
  DEFAULT_GRID_RESOLUTION,
  bandsOf,
  rasterise,
  cellsWithin,
  coverageRatio,
  renderGrid,
  toGeoJson,
} from "./contour.js";
