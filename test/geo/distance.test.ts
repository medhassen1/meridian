import { describe, expect, it } from "vitest";

import { GeometryError } from "../../src/errors.js";
import { coordinate } from "../../src/geo/coordinate.js";
import {
  EARTH_RADIUS_METRES,
  approximateDistance,
  compassPoint,
  destinationPoint,
  haversineDistance,
  initialBearing,
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
  walkingSeconds,
} from "../../src/geo/distance.js";

describe("haversineDistance", () => {
  it("is zero between a point and itself", () => {
    const point = coordinate(51.5, -0.1);
    expect(haversineDistance(point, point)).toBe(0);
  });

  it("measures a degree of latitude at about 111 km", () => {
    const metres = haversineDistance(coordinate(0, 0), coordinate(1, 0));
    expect(metres).toBeGreaterThan(111_000);
    expect(metres).toBeLessThan(111_400);
  });

  it("measures a quarter of the globe from equator to pole", () => {
    const metres = haversineDistance(coordinate(0, 0), coordinate(90, 0));
    expect(metres).toBeCloseTo((Math.PI / 2) * EARTH_RADIUS_METRES, 0);
  });

  it("is symmetric", () => {
    const a = coordinate(51.5, -0.1);
    const b = coordinate(48.85, 2.35);
    expect(haversineDistance(a, b)).toBeCloseTo(haversineDistance(b, a), 6);
  });

  it("handles a short distance across the antimeridian", () => {
    const metres = haversineDistance(coordinate(0, 179.99), coordinate(0, -179.99));
    expect(metres).toBeLessThan(3000);
  });
});

describe("approximateDistance", () => {
  it("agrees with haversine within a fraction of a percent nearby", () => {
    const a = coordinate(51.5, -0.1);
    const b = coordinate(51.51, -0.11);
    const exact = haversineDistance(a, b);
    const approximate = approximateDistance(a, b);
    expect(Math.abs(exact - approximate) / exact).toBeLessThan(0.001);
  });

  it("is zero between a point and itself", () => {
    const point = coordinate(51.5, -0.1);
    expect(approximateDistance(point, point)).toBe(0);
  });
});

describe("initialBearing", () => {
  it("reports due north", () => {
    expect(initialBearing(coordinate(0, 0), coordinate(1, 0))).toBeCloseTo(0, 6);
  });

  it("reports due east", () => {
    expect(initialBearing(coordinate(0, 0), coordinate(0, 1))).toBeCloseTo(90, 6);
  });

  it("reports due south", () => {
    expect(initialBearing(coordinate(1, 0), coordinate(0, 0))).toBeCloseTo(180, 6);
  });

  it("reports due west", () => {
    expect(initialBearing(coordinate(0, 1), coordinate(0, 0))).toBeCloseTo(270, 6);
  });

  it("returns zero for two identical points", () => {
    const point = coordinate(51.5, -0.1);
    expect(initialBearing(point, point)).toBe(0);
  });
});

describe("compassPoint", () => {
  it("names the cardinal directions", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(270)).toBe("W");
  });

  it("names an intercardinal direction", () => {
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(22.5)).toBe("NNE");
  });

  it("wraps past a full turn", () => {
    expect(compassPoint(360)).toBe("N");
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
  });
});

describe("destinationPoint", () => {
  it("moves north by the requested distance", () => {
    const start = coordinate(51.5, -0.1);
    const end = destinationPoint(start, 0, 1000);
    expect(haversineDistance(start, end)).toBeCloseTo(1000, 3);
    expect(end.latitude).toBeGreaterThan(start.latitude);
  });

  it("returns the origin for a zero distance", () => {
    const start = coordinate(51.5, -0.1);
    const end = destinationPoint(start, 45, 0);
    expect(haversineDistance(start, end)).toBeCloseTo(0, 6);
  });

  it("round-trips through the bearing", () => {
    const start = coordinate(51.5, -0.1);
    const end = destinationPoint(start, 137, 2500);
    expect(initialBearing(start, end)).toBeCloseTo(137, 3);
  });

  it("rejects a negative or non-finite distance", () => {
    expect(() => destinationPoint(coordinate(0, 0), 0, -1)).toThrow(GeometryError);
    expect(() => destinationPoint(coordinate(0, 0), 0, Number.NaN)).toThrow(GeometryError);
  });
});

describe("degree scales", () => {
  it("gives a constant metres-per-degree of latitude", () => {
    expect(metresPerDegreeLatitude()).toBeGreaterThan(111_000);
    expect(metresPerDegreeLatitude()).toBeLessThan(111_400);
  });

  it("shrinks metres-per-degree of longitude towards the poles", () => {
    expect(metresPerDegreeLongitude(0)).toBeCloseTo(metresPerDegreeLatitude(), 3);
    expect(metresPerDegreeLongitude(60)).toBeCloseTo(metresPerDegreeLatitude() / 2, 0);
    expect(metresPerDegreeLongitude(90)).toBeCloseTo(0, 6);
  });
});

describe("walkingSeconds", () => {
  it("scales distance by the straightness factor and speed", () => {
    expect(walkingSeconds(1300, 1.3, 1)).toBe(1000);
    expect(walkingSeconds(1300, 1.3, 1.4)).toBe(1400);
  });

  it("rounds up, so no walk is free", () => {
    expect(walkingSeconds(1, 1.3, 1)).toBe(1);
  });

  it("uses a default straightness factor of 1.4", () => {
    expect(walkingSeconds(1300, 1.3)).toBe(walkingSeconds(1300, 1.3, 1.4));
  });

  it("rejects a non-positive speed", () => {
    expect(() => walkingSeconds(100, 0)).toThrow(/positive/);
    expect(() => walkingSeconds(100, -1)).toThrow(/positive/);
    expect(() => walkingSeconds(100, Number.NaN)).toThrow(/finite/);
  });

  it("rejects a straightness factor below 1", () => {
    expect(() => walkingSeconds(100, 1.3, 0.9)).toThrow(/at least 1/);
  });
});
