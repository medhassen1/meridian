/**
 * Cross-table reference checks.
 *
 * A GTFS feed is a relational database with no foreign keys enforced by
 * anything. Every id in every table is a string that may or may not name a
 * real row, and a single broken reference — a trip pointing at a route that
 * was renamed — silently removes service from the network without any other
 * symptom.
 */

import { TABLES } from "../feed/source.js";
import { isBoardable, LocationType } from "../feed/stops.js";
import { at, type Validator } from "./context.js";

/**
 * Checks that every trip names a route, service, and shape that exist.
 */
export const validateTripReferences: Validator = ({ feed, calendar }, report) => {
  for (const trip of feed.trips) {
    if (!feed.routeById.has(trip.routeId)) {
      report.emit(
        "ref.trip_route",
        `trip "${trip.tripId}" names route "${trip.routeId}", which routes.txt does not define`,
        at(TABLES.trips, trip.line),
      );
    }
    if (!calendar.has(trip.serviceId)) {
      report.emit(
        "ref.trip_service",
        `trip "${trip.tripId}" names service "${trip.serviceId}", which no calendar table defines`,
        at(TABLES.trips, trip.line),
      );
    }
    if (trip.shapeId !== undefined && !feed.shapes.has(trip.shapeId)) {
      report.emit(
        "ref.trip_shape",
        `trip "${trip.tripId}" names shape "${trip.shapeId}", which shapes.txt does not define`,
        at(TABLES.trips, trip.line),
      );
    }
  }
};

/**
 * Checks that every call names a stop that exists and can be boarded.
 *
 * Calling at a station rather than one of its platforms is a common export
 * bug. It is reported separately from a missing stop because the fix differs:
 * one is a dangling reference, the other a wrong level of detail.
 */
export const validateCallReferences: Validator = ({ feed }, report) => {
  for (const trip of feed.trips) {
    for (const call of trip.calls) {
      const stop = feed.stopById.get(call.stopId);
      if (stop === undefined) {
        report.emit(
          "ref.call_stop",
          `trip "${trip.tripId}" calls at stop "${call.stopId}", which stops.txt does not define`,
          at(TABLES.stopTimes, call.line),
        );
        continue;
      }
      if (!isBoardable(stop)) {
        report.emit(
          "ref.call_not_boardable",
          `trip "${trip.tripId}" calls at "${call.stopId}", which is a location_type ${stop.locationType} and cannot be boarded`,
          at(TABLES.stopTimes, call.line),
        );
      }
    }
  }
};

/** Checks that every route names an agency that exists. */
export const validateRouteReferences: Validator = ({ feed }, report) => {
  const agencyIds = new Set(feed.agencies.map((agency) => agency.agencyId));
  // A feed with a single agency may leave route.agency_id blank, which the
  // loader normalises to the empty string; that resolves against the agency's
  // own normalised id without any special case here.
  for (const route of feed.routes) {
    if (!agencyIds.has(route.agencyId)) {
      report.emit(
        "ref.route_agency",
        `route "${route.routeId}" names agency "${route.agencyId}", which agency.txt does not define`,
        at(TABLES.routes, route.line),
      );
    }
  }
};

/** Checks parent stations and level references on stops. */
export const validateStopReferences: Validator = ({ feed }, report) => {
  const levelIds = new Set(feed.levels.map((level) => level.levelId));

  for (const stop of feed.stops) {
    if (stop.parentStation !== undefined) {
      const parent = feed.stopById.get(stop.parentStation);
      if (parent === undefined) {
        report.emit(
          "ref.parent_station",
          `stop "${stop.stopId}" names parent "${stop.parentStation}", which stops.txt does not define`,
          at(TABLES.stops, stop.line),
        );
      } else if (parent.locationType !== LocationType.Station) {
        report.emit(
          "ref.parent_station",
          `stop "${stop.stopId}" names parent "${stop.parentStation}", which is a location_type ${parent.locationType} rather than a station`,
          at(TABLES.stops, stop.line),
        );
      }
    }

    if (stop.levelId !== undefined && !levelIds.has(stop.levelId)) {
      report.emit(
        "ref.stop_level",
        `stop "${stop.stopId}" names level "${stop.levelId}", which levels.txt does not define`,
        at(TABLES.stops, stop.line),
      );
    }
  }
};

/** Checks that transfers name stops and trips that exist. */
export const validateTransferReferences: Validator = ({ feed }, report) => {
  for (const transfer of feed.transfers) {
    for (const [label, stopId] of [
      ["from_stop_id", transfer.fromStopId],
      ["to_stop_id", transfer.toStopId],
    ] as const) {
      if (stopId !== undefined && !feed.stopById.has(stopId)) {
        report.emit(
          "ref.transfer_stop",
          `transfer ${label} "${stopId}" does not name a stop in stops.txt`,
          at(TABLES.transfers, transfer.line),
        );
      }
    }
    for (const [label, tripId] of [
      ["from_trip_id", transfer.fromTripId],
      ["to_trip_id", transfer.toTripId],
    ] as const) {
      if (tripId !== undefined && !feed.tripById.has(tripId)) {
        report.emit(
          "ref.transfer_trip",
          `transfer ${label} "${tripId}" does not name a trip in trips.txt`,
          at(TABLES.transfers, transfer.line),
        );
      }
    }
  }
};

/** Checks that every frequency names a trip that exists. */
export const validateFrequencyReferences: Validator = ({ feed }, report) => {
  for (const frequency of feed.frequencies) {
    if (!feed.tripById.has(frequency.tripId)) {
      report.emit(
        "ref.frequency_trip",
        `frequency names trip "${frequency.tripId}", which trips.txt does not define`,
        at(TABLES.frequencies, frequency.line),
      );
    }
  }
};

/** Checks that fare rules name fares, routes, and zones that exist. */
export const validateFareReferences: Validator = ({ feed }, report) => {
  const fareIds = new Set(feed.fareAttributes.map((fare) => fare.fareId));
  const zoneIds = new Set<string>();
  for (const stop of feed.stops) {
    if (stop.zoneId !== undefined) {
      zoneIds.add(stop.zoneId);
    }
  }

  for (const rule of feed.fareRules) {
    if (!fareIds.has(rule.fareId)) {
      report.emit(
        "ref.fare_rule_fare",
        `fare rule names fare "${rule.fareId}", which fare_attributes.txt does not define`,
        at(TABLES.fareRules, rule.line),
      );
    }
    if (rule.routeId !== undefined && !feed.routeById.has(rule.routeId)) {
      report.emit(
        "ref.fare_rule_route",
        `fare rule names route "${rule.routeId}", which routes.txt does not define`,
        at(TABLES.fareRules, rule.line),
      );
    }
    for (const [label, zoneId] of [
      ["origin_id", rule.originId],
      ["destination_id", rule.destinationId],
      ["contains_id", rule.containsId],
    ] as const) {
      if (zoneId !== undefined && !zoneIds.has(zoneId)) {
        report.emit(
          "ref.fare_rule_zone",
          `fare rule ${label} "${zoneId}" names a zone no stop belongs to`,
          at(TABLES.fareRules, rule.line),
        );
      }
    }
  }
};

/** Checks that pathways name stops that exist. */
export const validatePathwayReferences: Validator = ({ feed }, report) => {
  for (const pathway of feed.pathways) {
    for (const [label, stopId] of [
      ["from_stop_id", pathway.fromStopId],
      ["to_stop_id", pathway.toStopId],
    ] as const) {
      if (!feed.stopById.has(stopId)) {
        report.emit(
          "ref.pathway_stop",
          `pathway "${pathway.pathwayId}" ${label} "${stopId}" does not name a stop in stops.txt`,
          at(TABLES.pathways, pathway.line),
        );
      }
    }
  }
};

/** Every referential validator, in the order a report reads best. */
export const REFERENTIAL_VALIDATORS: readonly Validator[] = [
  validateTripReferences,
  validateCallReferences,
  validateRouteReferences,
  validateStopReferences,
  validateTransferReferences,
  validateFrequencyReferences,
  validateFareReferences,
  validatePathwayReferences,
];
