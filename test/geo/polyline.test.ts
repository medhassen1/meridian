import { describe, expect, it } from "vitest";

import { GeometryError } from "../../src/errors.js";
import { coordinate, coordinatesEqual, type Coordinate } from "../../src/geo/coordinate.js";
import { haversineDistance } from "../../src/geo/distance.js";
import {
  cumulativeDistances,
  decodePolyline,
  encodePolyline,
  interpolateAt,
  polylineLength,
  projectOnto,
  simplifyPolyline,
  sliceByDistance,
} from "../../src/geo/polyline.js";

/** A straight north-south line of four points, roughly 111 m apart. */
const LINE: Coordinate[] = [
  coordinate(51.5, -0.1),
  coordinate(51.501, -0.1),
  coordinate(51.502, -0.1),
  coordinate(51.503, -0.1),
];

describe("cumulativeDistances", () => {
  it("starts at zero and increases", () => {
    const distances = cumulativeDistances(LINE);
    expect(distances).toHaveLength(LINE.length);
    expect(distances[0]).toBe(0);
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index] as number).toBeGreaterThan(distances[index - 1] as number);
    }
  });

  it("returns a single zero for a one point line", () => {
    expect(cumulativeDistances([coordinate(0, 0)])).toEqual([0]);
  });

  it("rejects an empty line", () => {
    expect(() => cumulativeDistances([])).toThrow(/empty/);
  });

  it("agrees with the total length", () => {
    const distances = cumulativeDistances(LINE);
    expect(polylineLength(LINE)).toBe(distances[distances.length - 1]);
  });
});

describe("interpolateAt", () => {
  it("returns the first point at zero", () => {
    expect(interpolateAt(LINE, 0)).toEqual(LINE[0]);
  });

  it("clamps a negative distance to the start", () => {
    expect(interpolateAt(LINE, -100)).toEqual(LINE[0]);
  });

  it("clamps a distance past the end to the last point", () => {
    expect(interpolateAt(LINE, 1_000_000)).toEqual(LINE[LINE.length - 1]);
  });

  it("lands between the surrounding points at a midpoint", () => {
    const half = polylineLength(LINE) / 2;
    const middle = interpolateAt(LINE, half);
    expect(middle.latitude).toBeGreaterThan((LINE[1] as Coordinate).latitude - 0.0002);
    expect(middle.latitude).toBeLessThan((LINE[2] as Coordinate).latitude + 0.0002);
  });

  it("returns the only point of a singleton", () => {
    const only = coordinate(1, 2);
    expect(interpolateAt([only], 500)).toEqual(only);
  });

  it("handles a line whose points repeat", () => {
    const repeated = [coordinate(0, 0), coordinate(0, 0), coordinate(0, 1)];
    expect(() => interpolateAt(repeated, 1)).not.toThrow();
  });

  it("rejects an empty line", () => {
    expect(() => interpolateAt([], 0)).toThrow(/empty/);
  });
});

describe("sliceByDistance", () => {
  it("keeps the interior points inside the range", () => {
    const total = polylineLength(LINE);
    const sliced = sliceByDistance(LINE, total * 0.2, total * 0.8);
    expect(sliced.length).toBeGreaterThanOrEqual(2);
    expect(sliced.length).toBeLessThanOrEqual(LINE.length);
  });

  it("clamps a range wider than the line", () => {
    const sliced = sliceByDistance(LINE, -100, 1_000_000);
    expect(coordinatesEqual(sliced[0] as Coordinate, LINE[0] as Coordinate)).toBe(true);
    expect(
      coordinatesEqual(sliced[sliced.length - 1] as Coordinate, LINE[LINE.length - 1] as Coordinate),
    ).toBe(true);
  });

  it("produces two coincident points for a zero-length slice", () => {
    const sliced = sliceByDistance(LINE, 100, 100);
    expect(sliced).toHaveLength(2);
    expect(coordinatesEqual(sliced[0] as Coordinate, sliced[1] as Coordinate)).toBe(true);
  });

  it("rejects an inverted range", () => {
    expect(() => sliceByDistance(LINE, 200, 100)).toThrow(/precedes/);
  });

  it("rejects an empty line", () => {
    expect(() => sliceByDistance([], 0, 1)).toThrow(/empty/);
  });
});

describe("projectOnto", () => {
  it("projects a point beside the line onto it", () => {
    const query = coordinate(51.5015, -0.1005);
    const projection = projectOnto(LINE, query);
    expect(projection.offsetMetres).toBeLessThan(60);
    expect(projection.distanceAlongMetres).toBeGreaterThan(0);
    expect(projection.segmentIndex).toBe(1);
  });

  it("projects a point beyond the start onto the first point", () => {
    const projection = projectOnto(LINE, coordinate(51.49, -0.1));
    expect(projection.segmentIndex).toBe(0);
    expect(projection.distanceAlongMetres).toBeCloseTo(0, 3);
  });

  it("projects a point beyond the end onto the last point", () => {
    const projection = projectOnto(LINE, coordinate(51.51, -0.1));
    expect(projection.distanceAlongMetres).toBeCloseTo(polylineLength(LINE), 3);
  });

  it("handles a single point line", () => {
    const only = coordinate(51.5, -0.1);
    const projection = projectOnto([only], coordinate(51.51, -0.1));
    expect(projection.point).toEqual(only);
    expect(projection.segmentIndex).toBe(0);
    expect(projection.offsetMetres).toBeGreaterThan(0);
  });

  it("handles a degenerate segment", () => {
    const degenerate = [coordinate(0, 0), coordinate(0, 0)];
    const projection = projectOnto(degenerate, coordinate(0, 1));
    expect(projection.distanceAlongMetres).toBe(0);
  });

  it("rejects an empty line", () => {
    expect(() => projectOnto([], coordinate(0, 0))).toThrow(/empty/);
  });
});

describe("polyline encoding", () => {
  it("round-trips a line to five decimal places", () => {
    const decoded = decodePolyline(encodePolyline(LINE));
    expect(decoded).toHaveLength(LINE.length);
    for (let index = 0; index < LINE.length; index += 1) {
      expect(haversineDistance(decoded[index] as Coordinate, LINE[index] as Coordinate)).toBeLessThan(2);
    }
  });

  it("is deterministic", () => {
    expect(encodePolyline(LINE)).toBe(encodePolyline(LINE));
  });

  it("encodes an empty line as an empty string", () => {
    expect(encodePolyline([])).toBe("");
    expect(decodePolyline("")).toEqual([]);
  });

  it("matches the reference encoding of the format's own example", () => {
    const example = [
      coordinate(38.5, -120.2),
      coordinate(40.7, -120.95),
      coordinate(43.252, -126.453),
    ];
    expect(encodePolyline(example)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  });

  it("decodes the reference example", () => {
    const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decoded).toHaveLength(3);
    expect(decoded[0]?.latitude).toBeCloseTo(38.5, 5);
    expect(decoded[2]?.longitude).toBeCloseTo(-126.453, 5);
  });

  it("handles negative deltas", () => {
    const descending = [coordinate(10, 10), coordinate(5, 5), coordinate(0, 0)];
    expect(decodePolyline(encodePolyline(descending))[2]?.latitude).toBeCloseTo(0, 5);
  });

  it("rejects a string that ends mid-value", () => {
    expect(() => decodePolyline("_p~iF")).toThrow(/mid-value/);
  });
});

describe("simplifyPolyline", () => {
  it("removes a collinear midpoint", () => {
    const straight = [coordinate(0, 0), coordinate(0, 0.5), coordinate(0, 1)];
    expect(simplifyPolyline(straight, 100)).toHaveLength(2);
  });

  it("keeps a point that deviates beyond the tolerance", () => {
    const bent = [coordinate(0, 0), coordinate(0.05, 0.5), coordinate(0, 1)];
    expect(simplifyPolyline(bent, 100)).toHaveLength(3);
  });

  it("keeps both endpoints", () => {
    const simplified = simplifyPolyline(LINE, 1_000_000);
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toEqual(LINE[0]);
    expect(simplified[1]).toEqual(LINE[LINE.length - 1]);
  });

  it("returns short lines unchanged", () => {
    expect(simplifyPolyline([], 10)).toEqual([]);
    const pair = [coordinate(0, 0), coordinate(1, 1)];
    expect(simplifyPolyline(pair, 10)).toEqual(pair);
  });

  it("keeps everything at a zero tolerance when points deviate at all", () => {
    const bent = [coordinate(0, 0), coordinate(0.0001, 0.5), coordinate(0, 1)];
    expect(simplifyPolyline(bent, 0)).toHaveLength(3);
  });

  it("rejects a negative or non-finite tolerance", () => {
    expect(() => simplifyPolyline(LINE, -1)).toThrow(GeometryError);
    expect(() => simplifyPolyline(LINE, Number.NaN)).toThrow(GeometryError);
  });
});
