import { describe, expect, it } from "vitest";

import { GeometryError } from "../../src/errors.js";
import { coordinate } from "../../src/geo/coordinate.js";
import {
  boundingBox,
  boundingBoxOf,
  boxCentre,
  boxContains,
  boxesIntersect,
  boxHeightDegrees,
  boxWidthDegrees,
  formatBoundingBox,
  intersectBoxes,
  isDegenerateBox,
  padBox,
  unionBoxes,
} from "../../src/geo/bbox.js";

describe("boundingBox", () => {
  it("builds a box from its edges", () => {
    const box = boundingBox(0, 0, 1, 1);
    expect(box.minLatitude).toBe(0);
    expect(box.maxLongitude).toBe(1);
  });

  it("permits a degenerate box", () => {
    expect(isDegenerateBox(boundingBox(1, 1, 1, 1))).toBe(true);
    expect(isDegenerateBox(boundingBox(1, 1, 1, 2))).toBe(true);
    expect(isDegenerateBox(boundingBox(1, 1, 2, 2))).toBe(false);
  });

  it("rejects an inverted latitude range", () => {
    expect(() => boundingBox(2, 0, 1, 1)).toThrow(/latitude exceeds/);
  });

  it("rejects an inverted longitude range", () => {
    expect(() => boundingBox(0, 2, 1, 1)).toThrow(/longitude exceeds/);
  });

  it("rejects an out of range edge", () => {
    expect(() => boundingBox(0, 0, 91, 1)).toThrow(GeometryError);
  });

  it("freezes the instance", () => {
    expect(Object.isFrozen(boundingBox(0, 0, 1, 1))).toBe(true);
  });
});

describe("boundingBoxOf", () => {
  it("encloses every point", () => {
    const box = boundingBoxOf([coordinate(1, 2), coordinate(-1, 5), coordinate(3, 0)]);
    expect(box).toEqual(boundingBox(-1, 0, 3, 5));
  });

  it("produces a degenerate box for a single point", () => {
    const box = boundingBoxOf([coordinate(1, 2)]);
    expect(box).toEqual(boundingBox(1, 2, 1, 2));
  });

  it("rejects an empty set", () => {
    expect(() => boundingBoxOf([])).toThrow(/empty/);
  });
});

describe("containment and intersection", () => {
  const box = boundingBox(0, 0, 10, 10);

  it("includes points on the boundary", () => {
    expect(boxContains(box, coordinate(0, 0))).toBe(true);
    expect(boxContains(box, coordinate(10, 10))).toBe(true);
    expect(boxContains(box, coordinate(5, 5))).toBe(true);
  });

  it("excludes points outside", () => {
    expect(boxContains(box, coordinate(-1, 5))).toBe(false);
    expect(boxContains(box, coordinate(5, 11))).toBe(false);
    expect(boxContains(box, coordinate(11, 5))).toBe(false);
    expect(boxContains(box, coordinate(5, -1))).toBe(false);
  });

  it("treats a shared edge as an intersection", () => {
    expect(boxesIntersect(box, boundingBox(10, 10, 20, 20))).toBe(true);
  });

  it("reports disjoint boxes", () => {
    expect(boxesIntersect(box, boundingBox(11, 11, 20, 20))).toBe(false);
    expect(boxesIntersect(box, boundingBox(0, 11, 10, 20))).toBe(false);
  });

  it("intersects overlapping boxes", () => {
    expect(intersectBoxes(box, boundingBox(5, 5, 20, 20))).toEqual(boundingBox(5, 5, 10, 10));
  });

  it("returns undefined for disjoint boxes", () => {
    expect(intersectBoxes(box, boundingBox(11, 11, 20, 20))).toBeUndefined();
  });

  it("unions two boxes", () => {
    expect(unionBoxes(box, boundingBox(-5, -5, 5, 5))).toEqual(boundingBox(-5, -5, 10, 10));
  });
});

describe("boxCentre", () => {
  it("takes the midpoint of both axes", () => {
    expect(boxCentre(boundingBox(0, 0, 10, 20))).toEqual(coordinate(5, 10));
  });

  it("returns the point itself for a degenerate box", () => {
    expect(boxCentre(boundingBox(3, 4, 3, 4))).toEqual(coordinate(3, 4));
  });
});

describe("padBox", () => {
  it("grows the box on every side", () => {
    const padded = padBox(boundingBox(51.5, -0.1, 51.6, 0), 1000);
    expect(padded.minLatitude).toBeLessThan(51.5);
    expect(padded.maxLatitude).toBeGreaterThan(51.6);
    expect(padded.minLongitude).toBeLessThan(-0.1);
    expect(padded.maxLongitude).toBeGreaterThan(0);
  });

  it("leaves the box unchanged for zero padding", () => {
    const box = boundingBox(51.5, -0.1, 51.6, 0);
    expect(padBox(box, 0)).toEqual(box);
  });

  it("clamps to the valid coordinate range", () => {
    const padded = padBox(boundingBox(-90, -180, 90, 180), 100_000);
    expect(padded).toEqual(boundingBox(-90, -180, 90, 180));
  });

  it("widens to every longitude near the pole", () => {
    const padded = padBox(boundingBox(89.999, 0, 89.999, 0), 1000);
    expect(padded.minLongitude).toBe(-180);
    expect(padded.maxLongitude).toBe(180);
  });

  it("rejects negative or non-finite padding", () => {
    expect(() => padBox(boundingBox(0, 0, 1, 1), -1)).toThrow(GeometryError);
    expect(() => padBox(boundingBox(0, 0, 1, 1), Number.NaN)).toThrow(GeometryError);
  });
});

describe("measurement and rendering", () => {
  it("measures both axes in degrees", () => {
    const box = boundingBox(0, 0, 10, 20);
    expect(boxHeightDegrees(box)).toBe(10);
    expect(boxWidthDegrees(box)).toBe(20);
  });

  it("renders four values with six decimal places", () => {
    expect(formatBoundingBox(boundingBox(0, 0, 1, 2))).toBe(
      "0.000000,0.000000,1.000000,2.000000",
    );
  });
});
