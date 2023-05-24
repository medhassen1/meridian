import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  CsvFormatError,
  CsvSchemaError,
  GeometryError,
  InvalidTableError,
  MeridianError,
  MissingTableError,
  NetworkBuildError,
  QueryError,
  ReferentialIntegrityError,
  RoutingError,
  TimeRangeError,
  UnknownServiceError,
  UnknownStopError,
  hasErrorCode,
  isMeridianError,
} from "../src/errors.js";

describe("MeridianError", () => {
  it("carries a code and structured details", () => {
    const error = new MeridianError("QUERY_INVALID", "bad query", { stopId: "A" });
    expect(error.code).toBe("QUERY_INVALID");
    expect(error.details).toEqual({ stopId: "A" });
    expect(error.message).toBe("bad query");
  });

  it("defaults details to an empty object", () => {
    expect(new MeridianError("ROUTING_FAILED", "x").details).toEqual({});
  });

  it("names itself after its subclass", () => {
    expect(new QueryError("x").name).toBe("QueryError");
    expect(new MeridianError("ROUTING_FAILED", "x").name).toBe("MeridianError");
  });

  it("preserves instanceof through the hierarchy", () => {
    const error = new QueryError("x");
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toBeInstanceOf(MeridianError);
    expect(error).toBeInstanceOf(Error);
  });

  it("serialises with sorted detail keys", () => {
    const error = new MeridianError("GEOMETRY", "x", { zebra: 1, alpha: 2, middle: 3 });
    expect(Object.keys(error.toJSON().details)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("serialises code, name, message, and details", () => {
    const json = new GeometryError("bad point", { latitude: 91 }).toJSON();
    expect(json).toEqual({
      code: "GEOMETRY",
      name: "GeometryError",
      message: "bad point",
      details: { latitude: 91 },
    });
  });
});

describe("subclasses", () => {
  it("assign the documented codes", () => {
    expect(new CsvFormatError("x").code).toBe("CSV_MALFORMED");
    expect(new CsvSchemaError("x").code).toBe("CSV_SCHEMA");
    expect(new MissingTableError("stops.txt").code).toBe("FEED_MISSING_TABLE");
    expect(new InvalidTableError("x").code).toBe("FEED_INVALID_TABLE");
    expect(new ReferentialIntegrityError("x").code).toBe("FEED_INTEGRITY");
    expect(new NetworkBuildError("x").code).toBe("NETWORK_BUILD");
    expect(new QueryError("x").code).toBe("QUERY_INVALID");
    expect(new RoutingError("x").code).toBe("ROUTING_FAILED");
    expect(new UnknownStopError("A").code).toBe("UNKNOWN_STOP");
    expect(new UnknownServiceError("S").code).toBe("UNKNOWN_SERVICE");
    expect(new TimeRangeError("x").code).toBe("TIME_RANGE");
    expect(new GeometryError("x").code).toBe("GEOMETRY");
    expect(new CliUsageError("x").code).toBe("CLI_USAGE");
  });

  it("build a message from their subject", () => {
    expect(new MissingTableError("stops.txt").message).toContain("stops.txt");
    expect(new UnknownStopError("CENTRAL").message).toContain("CENTRAL");
    expect(new UnknownServiceError("WEEKDAY").message).toContain("WEEKDAY");
  });

  it("include their subject in the details", () => {
    expect(new MissingTableError("stops.txt").details["table"]).toBe("stops.txt");
    expect(new UnknownStopError("CENTRAL").details["stopId"]).toBe("CENTRAL");
    expect(new UnknownServiceError("WEEKDAY").details["serviceId"]).toBe("WEEKDAY");
  });

  it("merge extra details alongside their subject", () => {
    const error = new UnknownStopError("A", { source: "query" });
    expect(error.details).toEqual({ stopId: "A", source: "query" });
  });
});

describe("narrowing helpers", () => {
  it("recognises a library error", () => {
    expect(isMeridianError(new QueryError("x"))).toBe(true);
    expect(isMeridianError(new Error("x"))).toBe(false);
    expect(isMeridianError("x")).toBe(false);
    expect(isMeridianError(undefined)).toBe(false);
  });

  it("matches a specific code", () => {
    const error = new QueryError("x");
    expect(hasErrorCode(error, "QUERY_INVALID")).toBe(true);
    expect(hasErrorCode(error, "ROUTING_FAILED")).toBe(false);
    expect(hasErrorCode(new Error("x"), "QUERY_INVALID")).toBe(false);
  });
});
