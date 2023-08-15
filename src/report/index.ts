/**
 * Rendering: aligned text tables, human-readable journeys, and stable JSON.
 */

export {
  type Alignment,
  type Column,
  type TableOptions,
  ELLIPSIS,
  renderTable,
  renderPairs,
  indent,
  wrap,
  displayWidth,
} from "./table.js";

export {
  type TextOptions,
  renderJourney,
  renderPlan,
  renderDepartureBoard,
  renderLeg,
  renderFeedSummary,
  renderNetworkStatistics,
} from "./text.js";

export {
  type JsonOptions,
  planToJson,
  journeyToJson,
  reachToJson,
  itineraryToJson,
  timeObject,
  sortKeys,
} from "./json.js";
