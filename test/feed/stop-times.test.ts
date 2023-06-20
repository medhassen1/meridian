import { describe, expect, it } from "vitest";

import { DiagnosticSink } from "../../src/csv/sink.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { readTable } from "../../src/feed/table.js";
import {
  BoardingRule,
  Timepoint,
  allowsAlighting,
  allowsBoarding,
  dwellSeconds,
  groupStopTimes,
  interpolateStopTimes,
  readStopTimes,
  type RawStopTime,
} from "../../src/feed/stop-times.js";
import { table } from "../support/csv.js";

const HEADER = [
  "trip_id",
  "arrival_time",
  "departure_time",
  "stop_id",
  "stop_sequence",
  "pickup_type",
  "drop_off_type",
  "timepoint",
];

function read(rows: string[][], header: readonly string[] = HEADER) {
  const sink = new DiagnosticSink();
  const loaded = readTable(
    new MemoryFeedSource({ "stop_times.txt": table(header, rows) }),
    "stop_times.txt",
    sink,
  );
  if (loaded === undefined) {
    throw new Error("fixture failed to tokenise");
  }
  return { stopTimes: readStopTimes(loaded, sink), sink };
}

describe("readStopTimes", () => {
  it("reads a call with its boarding rules", () => {
    const { stopTimes, sink } = read([["T", "08:00:00", "08:01:00", "A", "1", "0", "1", "1"]]);
    const call = stopTimes[0] as RawStopTime;
    expect(call.tripId).toBe("T");
    expect(call.arrivalTime).toBe(8 * 3600);
    expect(call.departureTime).toBe(8 * 3600 + 60);
    expect(call.pickupType).toBe(BoardingRule.Regular);
    expect(call.dropOffType).toBe(BoardingRule.None);
    expect(call.timepoint).toBe(Timepoint.Exact);
    expect(sink.hasErrors()).toBe(false);
  });

  it("treats every time as exact when the timepoint column is absent", () => {
    const { stopTimes } = read(
      [["T", "08:00:00", "08:00:00", "A", "1"]],
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
    );
    expect(stopTimes[0]?.timepoint).toBe(Timepoint.Exact);
  });

  it("drops a row missing a required field", () => {
    const { stopTimes } = read([
      ["", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "08:00:00", "08:00:00", "", "1", "0", "0", "1"],
      ["T", "08:00:00", "08:00:00", "A", "", "0", "0", "1"],
    ]);
    expect(stopTimes).toEqual([]);
  });

  it("drops a call departing before it arrives", () => {
    const { stopTimes, sink } = read([["T", "08:05:00", "08:00:00", "A", "1", "0", "0", "1"]]);
    expect(stopTimes).toEqual([]);
    expect(
      sink.bySeverity("error").some((entry) => entry.rule === "stop_time.departure_before_arrival"),
    ).toBe(true);
  });

  it("allows a blank time", () => {
    const { stopTimes, sink } = read([["T", "", "", "A", "2", "0", "0", "0"]]);
    expect(stopTimes[0]?.arrivalTime).toBeUndefined();
    expect(sink.hasErrors()).toBe(false);
  });

  it("reports boarding permissions", () => {
    const { stopTimes } = read([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "1", "1"],
      ["T", "08:10:00", "08:10:00", "B", "2", "1", "0", "1"],
    ]);
    expect(allowsBoarding(stopTimes[0] as RawStopTime)).toBe(true);
    expect(allowsAlighting(stopTimes[0] as RawStopTime)).toBe(false);
    expect(allowsBoarding(stopTimes[1] as RawStopTime)).toBe(false);
    expect(allowsAlighting(stopTimes[1] as RawStopTime)).toBe(true);
  });
});

describe("groupStopTimes", () => {
  it("groups by trip and sorts by sequence", () => {
    const { stopTimes, sink } = read([
      ["T", "08:10:00", "08:10:00", "B", "2", "0", "0", "1"],
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["U", "09:00:00", "09:00:00", "C", "1", "0", "0", "1"],
    ]);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    expect(grouped.get("T")?.map((call) => call.stopId)).toEqual(["A", "B"]);
    expect(grouped.get("U")).toHaveLength(1);
  });

  it("accepts non-contiguous sequence numbers", () => {
    const { stopTimes, sink } = read([
      ["T", "08:00:00", "08:00:00", "A", "10", "0", "0", "1"],
      ["T", "08:10:00", "08:10:00", "B", "30", "0", "0", "1"],
    ]);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    expect(grouped.get("T")).toHaveLength(2);
    expect(sink.hasErrors()).toBe(false);
  });

  it("drops a repeated sequence number and reports it", () => {
    const { stopTimes, sink } = read([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "08:10:00", "08:10:00", "B", "1", "0", "0", "1"],
    ]);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    expect(grouped.get("T")).toHaveLength(1);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop_time.duplicate_sequence")).toBe(true);
  });
});

describe("interpolateStopTimes", () => {
  const interpolate = (rows: string[][]) => {
    const { stopTimes, sink } = read(rows);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    const calls = grouped.get("T") ?? [];
    return { result: interpolateStopTimes("T", calls, "stop_times.txt", sink), sink };
  };

  it("leaves fully specified times alone", () => {
    const { result } = interpolate([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "08:10:00", "08:12:00", "B", "2", "0", "0", "1"],
      ["T", "08:20:00", "08:20:00", "C", "3", "0", "0", "1"],
    ]);
    expect(result?.map((call) => call.arrivalTime)).toEqual([
      8 * 3600,
      8 * 3600 + 600,
      8 * 3600 + 1200,
    ]);
    expect(result?.every((call) => !call.interpolated)).toBe(true);
  });

  it("distributes elapsed time evenly across unanchored stops", () => {
    const { result } = interpolate([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "", "", "B", "2", "0", "0", "0"],
      ["T", "", "", "C", "3", "0", "0", "0"],
      ["T", "08:30:00", "08:30:00", "D", "4", "0", "0", "1"],
    ]);
    expect(result?.map((call) => call.arrivalTime)).toEqual([
      8 * 3600,
      8 * 3600 + 600,
      8 * 3600 + 1200,
      8 * 3600 + 1800,
    ]);
    expect(result?.map((call) => call.interpolated)).toEqual([false, true, true, false]);
  });

  it("interpolates from the anchor's departure to the next anchor's arrival", () => {
    const { result } = interpolate([
      ["T", "08:00:00", "08:02:00", "A", "1", "0", "0", "1"],
      ["T", "", "", "B", "2", "0", "0", "0"],
      ["T", "08:12:00", "08:12:00", "C", "3", "0", "0", "1"],
    ]);
    expect(result?.[1]?.arrivalTime).toBe(8 * 3600 + 7 * 60);
  });

  it("fills a single missing time from its partner", () => {
    const { result } = interpolate([
      ["T", "08:00:00", "", "A", "1", "0", "0", "1"],
      ["T", "", "08:10:00", "B", "2", "0", "0", "1"],
    ]);
    expect(result?.[0]?.departureTime).toBe(8 * 3600);
    expect(result?.[1]?.arrivalTime).toBe(8 * 3600 + 600);
  });

  it("rejects a trip with fewer than two calls", () => {
    const { result, sink } = interpolate([["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"]]);
    expect(result).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop_time.too_few_stops")).toBe(true);
  });

  it("rejects a trip whose first stop has no published time", () => {
    const { result, sink } = interpolate([
      ["T", "", "", "A", "1", "0", "0", "0"],
      ["T", "08:10:00", "08:10:00", "B", "2", "0", "0", "1"],
    ]);
    expect(result).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop_time.unanchored")).toBe(true);
  });

  it("rejects a trip whose last stop has no published time", () => {
    const { result, sink } = interpolate([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "", "", "B", "2", "0", "0", "0"],
    ]);
    expect(result).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop_time.unanchored")).toBe(true);
  });

  it("rejects a trip whose times go backwards", () => {
    const { result, sink } = interpolate([
      ["T", "08:10:00", "08:10:00", "A", "1", "0", "0", "1"],
      ["T", "08:00:00", "08:00:00", "B", "2", "0", "0", "1"],
    ]);
    expect(result).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "stop_time.time_travel")).toBe(true);
  });

  it("accepts a trip running past midnight", () => {
    const { result } = interpolate([
      ["T", "23:50:00", "23:50:00", "A", "1", "0", "0", "1"],
      ["T", "24:20:00", "24:20:00", "B", "2", "0", "0", "1"],
    ]);
    expect(result?.[1]?.arrivalTime).toBe(24 * 3600 + 1200);
  });

  it("reports dwell time at a stop", () => {
    const { result } = interpolate([
      ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1"],
      ["T", "08:10:00", "08:12:00", "B", "2", "0", "0", "1"],
      ["T", "08:20:00", "08:20:00", "C", "3", "0", "0", "1"],
    ]);
    expect(dwellSeconds(result?.[1] as never)).toBe(120);
    expect(dwellSeconds(result?.[0] as never)).toBe(0);
  });

  it("warns about a decreasing shape distance", () => {
    const header = [...HEADER, "shape_dist_traveled"];
    const sink = new DiagnosticSink();
    const loaded = readTable(
      new MemoryFeedSource({
        "stop_times.txt": table(header, [
          ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1", "0"],
          ["T", "08:10:00", "08:10:00", "B", "2", "0", "0", "1", "500"],
          ["T", "08:20:00", "08:20:00", "C", "3", "0", "0", "1", "200"],
        ]),
      }),
      "stop_times.txt",
      sink,
    );
    const stopTimes = readStopTimes(loaded as never, sink);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    interpolateStopTimes("T", grouped.get("T") ?? [], "stop_times.txt", sink);
    expect(
      sink.bySeverity("warning").some((entry) => entry.rule === "stop_time.distance_not_increasing"),
    ).toBe(true);
  });

  it("does not warn about an increasing shape distance", () => {
    const header = [...HEADER, "shape_dist_traveled"];
    const sink = new DiagnosticSink();
    const loaded = readTable(
      new MemoryFeedSource({
        "stop_times.txt": table(header, [
          ["T", "08:00:00", "08:00:00", "A", "1", "0", "0", "1", "0"],
          ["T", "08:10:00", "08:10:00", "B", "2", "0", "0", "1", "500"],
        ]),
      }),
      "stop_times.txt",
      sink,
    );
    const stopTimes = readStopTimes(loaded as never, sink);
    const grouped = groupStopTimes(stopTimes, "stop_times.txt", sink);
    interpolateStopTimes("T", grouped.get("T") ?? [], "stop_times.txt", sink);
    expect(sink.count("warning")).toBe(0);
  });
});
