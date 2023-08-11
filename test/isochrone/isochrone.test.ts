import { describe, expect, it } from "vitest";

import { GeometryError, QueryError } from "../../src/errors.js";
import { ServiceDate } from "../../src/time/date.js";
import { parseTimeOfDay } from "../../src/time/time-of-day.js";
import { coordinate } from "../../src/geo/coordinate.js";
import {
  DEFAULT_REACH_BOARDINGS,
  computeReach,
  furthestStop,
  reachProfile,
  within,
  type ReachResult,
} from "../../src/isochrone/reach.js";
import {
  DEFAULT_GRID_RESOLUTION,
  DEFAULT_INFLUENCE_METRES,
  bandsOf,
  cellsWithin,
  coverageRatio,
  rasterise,
  renderGrid,
  toGeoJson,
} from "../../src/isochrone/contour.js";
import { MONDAY, rivertownNetwork } from "../support/fixtures.js";

const network = rivertownNetwork();

const reach = (budgetSeconds: number, departAfter = "07:55:00"): ReachResult =>
  computeReach(network, {
    from: { kind: "stop", stopId: "CENTRAL_A" },
    date: MONDAY,
    departAfter,
    budgetSeconds,
  });

describe("computeReach", () => {
  it("finds stops inside the budget", () => {
    const result = reach(30 * 60);
    expect(result.reached.length).toBeGreaterThan(0);
    expect(result.reached.map((stop) => stop.stopId)).toContain("MARKET");
    expect(result.budgetSeconds).toBe(1800);
  });

  it("orders results by travel time", () => {
    const result = reach(60 * 60);
    for (let index = 1; index < result.reached.length; index += 1) {
      expect(result.reached[index]?.seconds).toBeGreaterThanOrEqual(
        result.reached[index - 1]?.seconds as number,
      );
    }
  });

  it("reaches more with a larger budget", () => {
    expect(reach(60 * 60).reached.length).toBeGreaterThan(reach(10 * 60).reached.length);
  });

  it("records boardings used and coordinates", () => {
    const stop = reach(60 * 60).reached.find((entry) => entry.stopId === "HARBOUR");
    expect(stop?.boardings).toBeGreaterThan(0);
    expect(stop?.latitude).toBeCloseTo(51.5, 4);
  });

  it("names its origin", () => {
    expect(reach(600).origin).toBe("CENTRAL_A");
  });

  it("names a multi-platform origin with a count", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL" },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 600,
    });
    expect(result.origin).toContain("more");
  });

  it("accepts a resolved time of day", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: parseTimeOfDay("07:55:00"),
      budgetSeconds: 600,
    });
    expect(result.departAfter).toBe(7 * 3600 + 55 * 60);
  });

  it("accepts an HH:MM time", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: "07:55",
      budgetSeconds: 600,
    });
    expect(result.departAfter).toBe(7 * 3600 + 55 * 60);
  });

  it("rejects a malformed departure time", () => {
    expect(() =>
      computeReach(network, {
        from: { kind: "stop", stopId: "CENTRAL_A" },
        date: MONDAY,
        departAfter: "quarter past",
        budgetSeconds: 600,
      }),
    ).toThrow(QueryError);
  });

  it("rejects an invalid budget", () => {
    expect(() => reach(0)).toThrow(QueryError);
    expect(() => reach(1.5)).toThrow(QueryError);
  });

  it("reaches nothing on a date with no service", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: ServiceDate.parse("20231001"),
      departAfter: "07:55:00",
      budgetSeconds: 3600,
    });
    expect(result.reached).toEqual([]);
  });

  it("honours a boarding limit", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 3600,
      maxBoardings: 1,
    });
    expect(result.reached.every((stop) => stop.boardings <= 1)).toBe(true);
  });

  it("uses a documented default boarding limit", () => {
    expect(DEFAULT_REACH_BOARDINGS).toBeGreaterThan(0);
  });

  it("profiles reach across several budgets", () => {
    const result = reach(60 * 60);
    const profile = reachProfile(result, [600, 1800, 3600, 1800]);
    expect(profile.map((entry) => entry.budgetSeconds)).toEqual([600, 1800, 3600]);
    expect(profile[0]?.stops).toBeLessThanOrEqual(profile[2]?.stops as number);
  });

  it("filters to a tighter budget", () => {
    const result = reach(60 * 60);
    expect(within(result, 600).length).toBeLessThanOrEqual(result.reached.length);
  });

  it("names the furthest stop reached", () => {
    const result = reach(60 * 60);
    expect(furthestStop(result)?.seconds).toBe(result.reached[result.reached.length - 1]?.seconds);
    expect(furthestStop({ ...result, reached: [] })).toBeUndefined();
  });
});

describe("bandsOf", () => {
  const result = reach(60 * 60);

  it("partitions stops into tightest matching bands", () => {
    const bands = bandsOf(result, [600, 1800, 3600]);
    const total = bands.reduce((sum, band) => sum + band.stops.length, 0);
    expect(total).toBe(result.reached.length);
    expect(bands.map((band) => band.budgetSeconds)).toEqual([600, 1800, 3600]);
  });

  it("sorts and deduplicates budgets", () => {
    expect(bandsOf(result, [3600, 600, 600]).map((band) => band.budgetSeconds)).toEqual([600, 3600]);
  });

  it("drops stops beyond the widest band", () => {
    const bands = bandsOf(result, [1]);
    // Only the origin itself is reachable in a second.
    expect(bands[0]?.stops.every((stop) => stop.seconds <= 1)).toBe(true);
    expect(bands[0]?.stops.length).toBeLessThan(result.reached.length);
  });
});

describe("rasterise", () => {
  const result = reach(60 * 60);

  it("produces a square grid of cells", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(grid.rows).toBe(8);
    expect(grid.columns).toBe(8);
    expect(grid.cells).toHaveLength(64);
  });

  it("attributes a time to cells near a reached stop", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(grid.cells.some((cell) => cell.seconds !== undefined)).toBe(true);
  });

  it("leaves distant cells undefined", () => {
    const grid = rasterise(result, { resolution: 16, influenceMetres: 50 });
    expect(grid.cells.some((cell) => cell.seconds === undefined)).toBe(true);
  });

  it("uses documented defaults", () => {
    const grid = rasterise(result);
    expect(grid.rows).toBe(DEFAULT_GRID_RESOLUTION);
    expect(grid.influenceMetres).toBe(DEFAULT_INFLUENCE_METRES);
  });

  it("rejects an invalid resolution", () => {
    expect(() => rasterise(result, { resolution: 1 })).toThrow(GeometryError);
    expect(() => rasterise(result, { resolution: 8.5 })).toThrow(GeometryError);
  });

  it("rejects an invalid influence radius", () => {
    expect(() => rasterise(result, { influenceMetres: 0 })).toThrow(GeometryError);
    expect(() => rasterise(result, { influenceMetres: Number.NaN })).toThrow(GeometryError);
  });

  it("rejects a result that reached nothing", () => {
    expect(() => rasterise({ ...result, reached: [] })).toThrow(/reached no stops/);
  });

  it("reports which cells fall inside a budget", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(cellsWithin(grid, 60 * 60).length).toBeGreaterThanOrEqual(cellsWithin(grid, 600).length);
  });

  it("reports a coverage ratio between zero and one", () => {
    const grid = rasterise(result, { resolution: 8 });
    const ratio = coverageRatio(grid, 60 * 60);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("reports zero coverage for an empty grid", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(coverageRatio({ ...grid, cells: [] }, 3600)).toBe(0);
  });
});

describe("renderGrid", () => {
  const result = reach(60 * 60);

  it("renders one line per row", () => {
    const grid = rasterise(result, { resolution: 8 });
    const lines = renderGrid(grid, [600, 1800, 3600]).split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => line.length === 8)).toBe(true);
  });

  it("uses denser glyphs for tighter bands", () => {
    const grid = rasterise(result, { resolution: 8 });
    const rendered = renderGrid(grid, [600, 1800, 3600]);
    expect(rendered).toMatch(/[#+:.]/);
  });

  it("renders blanks for cells beyond every band", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(renderGrid(grid, [1])).toMatch(/^[\s\n]+$/);
  });

  it("renders deterministically", () => {
    const grid = rasterise(result, { resolution: 8 });
    expect(renderGrid(grid, [600, 3600])).toBe(renderGrid(grid, [600, 3600]));
  });
});

describe("toGeoJson", () => {
  it("emits a feature per reached stop", () => {
    const result = reach(30 * 60);
    const parsed = JSON.parse(toGeoJson(result)) as {
      type: string;
      features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }>;
    };
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features).toHaveLength(result.reached.length);
    expect(parsed.features[0]?.geometry.coordinates).toHaveLength(2);
    expect(parsed.features[0]?.properties["stop_id"]).toBeDefined();
  });

  it("emits longitude before latitude, as GeoJSON requires", () => {
    const result = reach(30 * 60);
    const parsed = JSON.parse(toGeoJson(result)) as {
      features: Array<{ geometry: { coordinates: number[] } }>;
    };
    const [longitude, latitude] = parsed.features[0]?.geometry.coordinates as [number, number];
    expect(latitude).toBeCloseTo(result.reached[0]?.latitude as number, 6);
    expect(longitude).toBeCloseTo(result.reached[0]?.longitude as number, 6);
  });

  it("renders deterministically", () => {
    const result = reach(30 * 60);
    expect(toGeoJson(result)).toBe(toGeoJson(result));
  });

  it("emits an empty collection when nothing was reached", () => {
    const result = reach(30 * 60);
    const parsed = JSON.parse(toGeoJson({ ...result, reached: [] })) as { features: unknown[] };
    expect(parsed.features).toEqual([]);
  });
});

describe("reach from a coordinate", () => {
  it("resolves an origin coordinate to nearby stops", () => {
    const result = computeReach(network, {
      from: { kind: "coordinate", at: coordinate(51.5, -0.1) },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 30 * 60,
    });
    expect(result.reached.length).toBeGreaterThan(0);
  });
});
