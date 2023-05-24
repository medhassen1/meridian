import { describe, expect, it } from "vitest";

import { coordinate, type Coordinate } from "../../src/geo/coordinate.js";
import { destinationPoint, haversineDistance } from "../../src/geo/distance.js";
import { SpatialGrid, gridForRadius } from "../../src/geo/grid.js";

const ORIGIN = coordinate(51.5, -0.1);

/** A deterministic ring of points at a fixed distance from the origin. */
function ring(count: number, metres: number): Coordinate[] {
  return Array.from({ length: count }, (_, index) =>
    destinationPoint(ORIGIN, (index * 360) / count, metres),
  );
}

describe("SpatialGrid construction", () => {
  it("rejects a non-positive cell size", () => {
    expect(() => new SpatialGrid<number>(0)).toThrow(/positive/);
    expect(() => new SpatialGrid<number>(-1)).toThrow(/positive/);
    expect(() => new SpatialGrid<number>(Number.NaN)).toThrow(/finite/);
  });

  it("rejects an out of range reference latitude", () => {
    expect(() => new SpatialGrid<number>(100, 91)).toThrow(/reference latitude/);
    expect(() => new SpatialGrid<number>(100, Number.NaN)).toThrow(/reference latitude/);
  });

  it("starts empty", () => {
    const grid = new SpatialGrid<number>(100);
    expect(grid.size).toBe(0);
    expect(grid.cellCount).toBe(0);
  });

  it("collapses to one longitude column near the pole", () => {
    const grid = new SpatialGrid<number>(100, 90);
    grid.insert(coordinate(89.9, 0), 1);
    grid.insert(coordinate(89.9, 120), 2);
    expect(grid.cellCount).toBeGreaterThan(0);
  });
});

describe("insertion", () => {
  it("counts every insertion, including duplicates", () => {
    const grid = new SpatialGrid<string>(100, 51.5);
    grid.insert(ORIGIN, "a");
    grid.insert(ORIGIN, "a");
    expect(grid.size).toBe(2);
  });

  it("groups nearby points into one cell", () => {
    const grid = new SpatialGrid<string>(1000, 51.5);
    grid.insert(ORIGIN, "a");
    grid.insert(destinationPoint(ORIGIN, 0, 10), "b");
    expect(grid.cellCount).toBe(1);
  });

  it("inserts a whole collection in one call", () => {
    const grid = new SpatialGrid<Coordinate>(200, 51.5);
    const points = ring(8, 100);
    grid.insertAll(points, (point) => point);
    expect(grid.size).toBe(8);
  });

  it("clears everything", () => {
    const grid = new SpatialGrid<string>(100, 51.5);
    grid.insert(ORIGIN, "a");
    grid.clear();
    expect(grid.size).toBe(0);
    expect(grid.cellCount).toBe(0);
    expect(grid.within(ORIGIN, 1000)).toEqual([]);
  });
});

describe("radius queries", () => {
  it("finds points inside the radius and excludes those outside", () => {
    const grid = new SpatialGrid<string>(200, 51.5);
    grid.insert(destinationPoint(ORIGIN, 0, 100), "near");
    grid.insert(destinationPoint(ORIGIN, 0, 5000), "far");

    const matches = grid.within(ORIGIN, 500);
    expect(matches.map((match) => match.value)).toEqual(["near"]);
    expect(matches[0]?.distanceMetres).toBeCloseTo(100, 0);
  });

  it("orders results by ascending distance", () => {
    const grid = new SpatialGrid<number>(200, 51.5);
    for (const metres of [400, 100, 250]) {
      grid.insert(destinationPoint(ORIGIN, 0, metres), metres);
    }
    expect(grid.within(ORIGIN, 1000).map((match) => match.value)).toEqual([100, 250, 400]);
  });

  it("breaks distance ties by insertion order", () => {
    const grid = new SpatialGrid<string>(200, 51.5);
    const point = destinationPoint(ORIGIN, 0, 100);
    grid.insert(point, "first");
    grid.insert(point, "second");
    expect(grid.within(ORIGIN, 500).map((match) => match.value)).toEqual(["first", "second"]);
  });

  it("finds points spread across several cells", () => {
    const grid = new SpatialGrid<number>(100, 51.5);
    const points = ring(12, 300);
    points.forEach((point, index) => grid.insert(point, index));
    expect(grid.within(ORIGIN, 400)).toHaveLength(12);
  });

  it("searches a radius wider than one cell", () => {
    const grid = new SpatialGrid<number>(50, 51.5);
    const points = ring(6, 900);
    points.forEach((point, index) => grid.insert(point, index));
    expect(grid.within(ORIGIN, 1000)).toHaveLength(6);
  });

  it("returns nothing for a zero radius when no point coincides", () => {
    const grid = new SpatialGrid<string>(200, 51.5);
    grid.insert(destinationPoint(ORIGIN, 0, 100), "near");
    expect(grid.within(ORIGIN, 0)).toEqual([]);
  });

  it("finds a coincident point at a zero radius", () => {
    const grid = new SpatialGrid<string>(200, 51.5);
    grid.insert(ORIGIN, "here");
    expect(grid.within(ORIGIN, 0).map((match) => match.value)).toEqual(["here"]);
  });

  it("rejects a negative or non-finite radius", () => {
    const grid = new SpatialGrid<string>(200, 51.5);
    expect(() => grid.within(ORIGIN, -1)).toThrow(/non-negative/);
    expect(() => grid.within(ORIGIN, Number.NaN)).toThrow(/finite/);
  });

  it("agrees with a brute force scan", () => {
    const grid = new SpatialGrid<number>(150, 51.5);
    const points = [...ring(20, 120), ...ring(20, 480), ...ring(20, 1500)];
    points.forEach((point, index) => grid.insert(point, index));

    const expected = points
      .map((point, index) => ({ index, metres: haversineDistance(ORIGIN, point) }))
      .filter((entry) => entry.metres <= 500)
      .sort((a, b) => a.metres - b.metres || a.index - b.index)
      .map((entry) => entry.index);

    expect(grid.within(ORIGIN, 500).map((match) => match.value)).toEqual(expected);
  });
});

describe("nearest", () => {
  it("returns at most the requested count", () => {
    const grid = new SpatialGrid<number>(200, 51.5);
    for (const metres of [100, 200, 300, 400]) {
      grid.insert(destinationPoint(ORIGIN, 0, metres), metres);
    }
    expect(grid.nearest(ORIGIN, 2, 1000).map((match) => match.value)).toEqual([100, 200]);
  });

  it("returns fewer when the radius holds fewer", () => {
    const grid = new SpatialGrid<number>(200, 51.5);
    grid.insert(destinationPoint(ORIGIN, 0, 100), 100);
    expect(grid.nearest(ORIGIN, 5, 1000)).toHaveLength(1);
  });

  it("returns nothing for a count of zero", () => {
    const grid = new SpatialGrid<number>(200, 51.5);
    grid.insert(ORIGIN, 1);
    expect(grid.nearest(ORIGIN, 0, 1000)).toEqual([]);
  });

  it("rejects a negative or non-integer count", () => {
    const grid = new SpatialGrid<number>(200, 51.5);
    expect(() => grid.nearest(ORIGIN, -1, 100)).toThrow(/non-negative integer/);
    expect(() => grid.nearest(ORIGIN, 1.5, 100)).toThrow(/non-negative integer/);
  });
});

describe("gridForRadius", () => {
  it("sizes cells to the query radius", () => {
    const grid = gridForRadius<number>(400, 51.5);
    grid.insert(destinationPoint(ORIGIN, 45, 350), 1);
    expect(grid.within(ORIGIN, 400)).toHaveLength(1);
  });

  it("never produces a zero cell size", () => {
    const grid = gridForRadius<number>(0, 0);
    grid.insert(ORIGIN, 1);
    expect(grid.within(ORIGIN, 1)).toHaveLength(1);
  });
});
