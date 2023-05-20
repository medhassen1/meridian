import { describe, expect, it } from "vitest";

import { GeometryError } from "../../src/errors.js";
import {
  centroid,
  compareCoordinates,
  coordinate,
  coordinateNormalised,
  coordinatesEqual,
  formatCoordinate,
  isNullIsland,
  normaliseLongitude,
  parseCoordinate,
  toDegrees,
  toRadians,
} from "../../src/geo/coordinate.js";

describe("coordinate", () => {
  it("builds a valid point", () => {
    const point = coordinate(51.5, -0.1);
    expect(point.latitude).toBe(51.5);
    expect(point.longitude).toBe(-0.1);
  });

  it("accepts the extremes", () => {
    expect(() => coordinate(90, 180)).not.toThrow();
    expect(() => coordinate(-90, -180)).not.toThrow();
  });

  it("rejects a non-finite component", () => {
    expect(() => coordinate(Number.NaN, 0)).toThrow(GeometryError);
    expect(() => coordinate(0, Number.POSITIVE_INFINITY)).toThrow(GeometryError);
  });

  it("rejects an out of range latitude", () => {
    expect(() => coordinate(90.1, 0)).toThrow(/latitude/);
  });

  it("rejects an out of range longitude", () => {
    expect(() => coordinate(0, 180.1)).toThrow(/longitude/);
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(coordinate(0, 0))).toBe(true);
  });
});

describe("normaliseLongitude", () => {
  it("leaves an in-range value alone", () => {
    expect(normaliseLongitude(0)).toBe(0);
    expect(normaliseLongitude(-179)).toBe(-179);
    expect(normaliseLongitude(180)).toBe(180);
  });

  it("wraps a value past the antimeridian", () => {
    expect(normaliseLongitude(190)).toBe(-170);
    expect(normaliseLongitude(-190)).toBe(170);
    expect(normaliseLongitude(540)).toBe(180);
  });

  it("reports the antimeridian as +180 rather than -180", () => {
    expect(normaliseLongitude(-540)).toBe(180);
  });

  it("rejects a non-finite value", () => {
    expect(() => normaliseLongitude(Number.NaN)).toThrow(/finite/);
  });

  it("is applied by coordinateNormalised", () => {
    expect(coordinateNormalised(0, 190).longitude).toBe(-170);
  });
});

describe("coordinatesEqual", () => {
  it("accepts a difference below the tolerance", () => {
    expect(coordinatesEqual(coordinate(51.5, -0.1), coordinate(51.50000001, -0.1))).toBe(true);
  });

  it("rejects a difference above the tolerance", () => {
    expect(coordinatesEqual(coordinate(51.5, -0.1), coordinate(51.6, -0.1))).toBe(false);
    expect(coordinatesEqual(coordinate(51.5, -0.1), coordinate(51.5, -0.2))).toBe(false);
  });

  it("honours an explicit tolerance", () => {
    expect(coordinatesEqual(coordinate(51.5, -0.1), coordinate(51.6, -0.1), 0.2)).toBe(true);
  });
});

describe("compareCoordinates", () => {
  it("orders by latitude first", () => {
    expect(compareCoordinates(coordinate(1, 5), coordinate(2, 0))).toBeLessThan(0);
  });

  it("falls back to longitude", () => {
    expect(compareCoordinates(coordinate(1, 5), coordinate(1, 6))).toBeLessThan(0);
    expect(compareCoordinates(coordinate(1, 5), coordinate(1, 5))).toBe(0);
  });

  it("gives a total order for sorting", () => {
    const points = [coordinate(2, 1), coordinate(1, 2), coordinate(1, 1)];
    const sorted = points.slice().sort(compareCoordinates).map(formatCoordinate);
    expect(sorted).toEqual([
      formatCoordinate(coordinate(1, 1)),
      formatCoordinate(coordinate(1, 2)),
      formatCoordinate(coordinate(2, 1)),
    ]);
  });
});

describe("isNullIsland", () => {
  it("recognises 0,0", () => {
    expect(isNullIsland(coordinate(0, 0))).toBe(true);
  });

  it("does not flag a nearby point", () => {
    expect(isNullIsland(coordinate(0, 0.0001))).toBe(false);
    expect(isNullIsland(coordinate(0.0001, 0))).toBe(false);
  });
});

describe("formatting and parsing", () => {
  it("renders six decimal places", () => {
    expect(formatCoordinate(coordinate(51.5, -0.1))).toBe("51.500000,-0.100000");
  });

  it("round-trips through the parser", () => {
    const point = coordinate(51.500123, -0.100456);
    expect(parseCoordinate(formatCoordinate(point))).toEqual(point);
  });

  it("tolerates whitespace around components", () => {
    expect(parseCoordinate(" 51.5 , -0.1 ")).toEqual(coordinate(51.5, -0.1));
  });

  it("rejects the wrong number of components", () => {
    expect(() => parseCoordinate("51.5")).toThrow(/lat,lon/);
    expect(() => parseCoordinate("51.5,-0.1,3")).toThrow(/lat,lon/);
  });

  it("rejects a non-numeric component", () => {
    expect(() => parseCoordinate("north,-0.1")).toThrow(/non numeric/);
  });

  it("rejects an out of range value", () => {
    expect(() => parseCoordinate("100,0")).toThrow(GeometryError);
  });
});

describe("centroid", () => {
  it("returns the only point of a singleton", () => {
    const point = coordinate(51.5, -0.1);
    const middle = centroid([point]);
    expect(middle.latitude).toBeCloseTo(51.5, 6);
    expect(middle.longitude).toBeCloseTo(-0.1, 6);
  });

  it("averages two nearby points", () => {
    const middle = centroid([coordinate(51.5, -0.1), coordinate(51.6, -0.1)]);
    expect(middle.latitude).toBeCloseTo(51.55, 3);
    expect(middle.longitude).toBeCloseTo(-0.1, 6);
  });

  it("stays in the right hemisphere across the antimeridian", () => {
    const middle = centroid([coordinate(0, 179), coordinate(0, -179)]);
    expect(Math.abs(middle.longitude)).toBeCloseTo(180, 3);
  });

  it("falls back to the first point for antipodal input", () => {
    const first = coordinate(0, 0);
    expect(centroid([first, coordinate(0, 180)])).toBe(first);
  });

  it("rejects an empty set", () => {
    expect(() => centroid([])).toThrow(/empty/);
  });
});

describe("angle conversion", () => {
  it("converts degrees to radians and back", () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toDegrees(Math.PI)).toBeCloseTo(180, 12);
    expect(toDegrees(toRadians(37.5))).toBeCloseTo(37.5, 12);
  });
});
