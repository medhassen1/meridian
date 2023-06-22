import { describe, expect, it } from "vitest";

import { DiagnosticSink } from "../../src/csv/sink.js";
import { ServiceDate } from "../../src/time/date.js";
import { MemoryFeedSource } from "../../src/feed/source.js";
import { readTable, type LoadedTable } from "../../src/feed/table.js";
import {
  ExactTimes,
  MAX_GENERATED_DEPARTURES,
  expectedWaitSeconds,
  frequencyWindow,
  generateDepartures,
  readFrequencies,
  type Frequency,
} from "../../src/feed/frequencies.js";
import {
  TransferType,
  forbidsTransfer,
  isInSeatTransfer,
  isTimedTransfer,
  readTransfers,
  requiredTransferSeconds,
  transferSpecificity,
} from "../../src/feed/transfers.js";
import { buildShapes, readShapePoints } from "../../src/feed/shapes.js";
import {
  allowsUnlimitedTransfers,
  compareFareRules,
  fareRuleSpecificity,
  readFareAttributes,
  readFareRules,
} from "../../src/feed/fares.js";
import {
  PathwayMode,
  allowsDirection,
  isStepFree,
  pathwayModeName,
  readLevels,
  readPathways,
  traversalSeconds,
  type Pathway,
} from "../../src/feed/pathways.js";
import { coversDate, describeRange, readFeedInfo } from "../../src/feed/feed-info.js";
import { table } from "../support/csv.js";

function loadTable(file: string, header: readonly string[], rows: string[][]) {
  const sink = new DiagnosticSink();
  const loaded = readTable(new MemoryFeedSource({ [file]: table(header, rows) }), file, sink);
  return { loaded: loaded as LoadedTable, sink };
}

describe("readFrequencies", () => {
  const header = ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"];

  it("reads a window", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["T", "06:00:00", "07:00:00", "600", "1"],
    ]);
    const frequency = readFrequencies(loaded, sink)[0] as Frequency;
    expect(frequency.headwaySecs).toBe(600);
    expect(frequency.exactTimes).toBe(ExactTimes.Exact);
    expect(sink.hasErrors()).toBe(false);
  });

  it("defaults exact_times to headway-based", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header.slice(0, 4), [
      ["T", "06:00:00", "07:00:00", "600"],
    ]);
    expect(readFrequencies(loaded, sink)[0]?.exactTimes).toBe(ExactTimes.Headway);
  });

  it("drops a row with an inverted window", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["T", "07:00:00", "06:00:00", "600", "0"],
    ]);
    expect(readFrequencies(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "frequency.window_inverted")).toBe(true);
  });

  it("drops a row missing a required field", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["", "06:00:00", "07:00:00", "600", "0"],
      ["T", "", "07:00:00", "600", "0"],
      ["T", "06:00:00", "", "600", "0"],
      ["T", "06:00:00", "07:00:00", "", "0"],
    ]);
    expect(readFrequencies(loaded, sink)).toEqual([]);
  });

  it("rejects a headway that would generate too many departures", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["T", "00:00:00", "24:00:00", "1", "0"],
    ]);
    expect(readFrequencies(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "frequency.headway_too_long")).toBe(true);
  });

  it("warns about overlapping windows for one trip", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["T", "06:00:00", "08:00:00", "600", "0"],
      ["T", "07:00:00", "09:00:00", "600", "0"],
    ]);
    readFrequencies(loaded, sink);
    expect(
      sink.bySeverity("warning").some((entry) => entry.rule === "frequency.overlapping_windows"),
    ).toBe(true);
  });

  it("accepts adjacent windows for one trip", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["T", "06:00:00", "08:00:00", "600", "0"],
      ["T", "08:00:00", "09:00:00", "600", "0"],
    ]);
    readFrequencies(loaded, sink);
    expect(sink.count("warning")).toBe(0);
  });

  it("accepts overlapping windows for different trips", () => {
    const { loaded, sink } = loadTable("frequencies.txt", header, [
      ["A", "06:00:00", "08:00:00", "600", "0"],
      ["B", "06:00:00", "08:00:00", "600", "0"],
    ]);
    readFrequencies(loaded, sink);
    expect(sink.count("warning")).toBe(0);
  });

  it("keeps the generation limit above any realistic feed", () => {
    expect(MAX_GENERATED_DEPARTURES).toBeGreaterThan(500);
  });
});

describe("generateDepartures", () => {
  const build = (start: string, end: string, headway: string, exact = "1"): Frequency => {
    const { loaded, sink } = loadTable(
      "frequencies.txt",
      ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"],
      [["T", start, end, headway, exact]],
    );
    return readFrequencies(loaded, sink)[0] as Frequency;
  };

  it("steps by the headway and stops before the end", () => {
    const departures = generateDepartures(build("06:00:00", "06:30:00", "600"));
    expect(departures).toEqual([6 * 3600, 6 * 3600 + 600, 6 * 3600 + 1200]);
  });

  it("emits one departure for a zero-length window", () => {
    expect(generateDepartures(build("06:00:00", "06:00:00", "600"))).toEqual([6 * 3600]);
  });

  it("emits one departure when the window is shorter than a headway", () => {
    expect(generateDepartures(build("06:00:00", "06:05:00", "600"))).toEqual([6 * 3600]);
  });

  it("reports the window as a half-open interval", () => {
    const window = frequencyWindow(build("06:00:00", "07:00:00", "600"));
    expect(window.start).toBe(6 * 3600);
    expect(window.end).toBe(7 * 3600);
  });

  it("expects half a headway of waiting for headway-based service", () => {
    expect(expectedWaitSeconds(build("06:00:00", "07:00:00", "600", "0"))).toBe(300);
  });

  it("expects no wait for exact times", () => {
    expect(expectedWaitSeconds(build("06:00:00", "07:00:00", "600", "1"))).toBe(0);
  });

  it("rounds an odd headway up", () => {
    expect(expectedWaitSeconds(build("06:00:00", "07:00:00", "601", "0"))).toBe(301);
  });
});

describe("readTransfers", () => {
  const header = [
    "from_stop_id",
    "to_stop_id",
    "transfer_type",
    "min_transfer_time",
    "from_trip_id",
    "to_trip_id",
  ];

  it("reads a minimum time transfer", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "2", "120", "", ""]]);
    const transfer = readTransfers(loaded, sink)[0];
    expect(transfer?.transferType).toBe(TransferType.MinimumTime);
    expect(requiredTransferSeconds(transfer as never)).toBe(120);
    expect(sink.hasErrors()).toBe(false);
  });

  it("requires stop endpoints for a stop-scoped rule", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "", "0", "", "", ""]]);
    expect(readTransfers(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "transfer.endpoints_required")).toBe(true);
  });

  it("requires trip endpoints for an in-seat rule", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "4", "", "", ""]]);
    expect(readTransfers(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "transfer.trip_required")).toBe(true);
  });

  it("accepts an in-seat rule with trip endpoints", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["", "", "4", "", "T1", "T2"]]);
    const transfer = readTransfers(loaded, sink)[0];
    expect(isInSeatTransfer(transfer as never)).toBe(true);
    expect(sink.hasErrors()).toBe(false);
  });

  it("requires a minimum time for type 2", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "2", "", "", ""]]);
    expect(readTransfers(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "transfer.min_time_required")).toBe(true);
  });

  it("warns about a minimum time on a forbidden transfer", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "3", "60", "", ""]]);
    const transfer = readTransfers(loaded, sink)[0];
    expect(forbidsTransfer(transfer as never)).toBe(true);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "transfer.min_time_ignored")).toBe(true);
  });

  it("rejects an unrecognised transfer type", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "9", "", "", ""]]);
    expect(readTransfers(loaded, sink)).toEqual([]);
  });

  it("keeps the first of two identical rules", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [
      ["A", "B", "2", "60", "", ""],
      ["A", "B", "2", "90", "", ""],
    ]);
    const transfers = readTransfers(loaded, sink);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.minTransferTime).toBe(60);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "transfer.duplicate")).toBe(true);
  });

  it("reports a timed transfer as requiring no slack", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "1", "", "", ""]]);
    const transfer = readTransfers(loaded, sink)[0];
    expect(isTimedTransfer(transfer as never)).toBe(true);
    expect(requiredTransferSeconds(transfer as never)).toBe(0);
  });

  it("leaves other types unconstrained", () => {
    const { loaded, sink } = loadTable("transfers.txt", header, [["A", "B", "0", "", "", ""]]);
    expect(requiredTransferSeconds(readTransfers(loaded, sink)[0] as never)).toBeUndefined();
  });

  it("scores specificity by how narrowly a rule is scoped", () => {
    const { loaded, sink } = loadTable(
      "transfers.txt",
      [...header, "from_route_id", "to_route_id"],
      [
        ["A", "B", "0", "", "", "", "", ""],
        ["A", "C", "0", "", "", "", "R1", ""],
        ["A", "D", "0", "", "T1", "T2", "", ""],
      ],
    );
    const transfers = readTransfers(loaded, sink);
    expect(transferSpecificity(transfers[0] as never)).toBe(0);
    expect(transferSpecificity(transfers[1] as never)).toBe(2);
    expect(transferSpecificity(transfers[2] as never)).toBe(16);
  });
});

describe("shapes", () => {
  const header = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"];

  it("assembles points in sequence order", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["S", "51.502", "-0.1", "2", ""],
      ["S", "51.500", "-0.1", "1", ""],
      ["S", "51.504", "-0.1", "3", ""],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.points.map((point) => point.latitude)).toEqual([51.5, 51.502, 51.504]);
    expect(shapes.get("S")?.lengthMetres).toBeGreaterThan(0);
    expect(shapes.get("S")?.distances[0]).toBe(0);
  });

  it("drops a shape with fewer than two points", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [["S", "51.5", "-0.1", "1", ""]]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.size).toBe(0);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "shape.too_few_points")).toBe(true);
  });

  it("drops a repeated sequence number", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["S", "51.500", "-0.1", "1", ""],
      ["S", "51.502", "-0.1", "1", ""],
      ["S", "51.504", "-0.1", "2", ""],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.points).toHaveLength(2);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "shape.duplicate_sequence")).toBe(true);
  });

  it("drops a point missing a required field", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["", "51.5", "-0.1", "1", ""],
      ["S", "", "-0.1", "1", ""],
      ["S", "51.5", "", "1", ""],
      ["S", "51.5", "-0.1", "", ""],
    ]);
    expect(readShapePoints(loaded, sink)).toEqual([]);
  });

  it("keeps a monotonic published distance", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["S", "51.500", "-0.1", "1", "0"],
      ["S", "51.502", "-0.1", "2", "220"],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.publishedDistances).toEqual([0, 220]);
  });

  it("discards a partially populated distance column", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["S", "51.500", "-0.1", "1", "0"],
      ["S", "51.502", "-0.1", "2", ""],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.publishedDistances).toBeUndefined();
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "shape.partial_distances")).toBe(true);
  });

  it("discards a decreasing distance column", () => {
    const { loaded, sink } = loadTable("shapes.txt", header, [
      ["S", "51.500", "-0.1", "1", "500"],
      ["S", "51.502", "-0.1", "2", "200"],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.publishedDistances).toBeUndefined();
    expect(
      sink.bySeverity("warning").some((entry) => entry.rule === "shape.distance_not_increasing"),
    ).toBe(true);
  });

  it("reports no distances when the column is entirely absent", () => {
    const { loaded, sink } = loadTable("shapes.txt", header.slice(0, 4), [
      ["S", "51.500", "-0.1", "1"],
      ["S", "51.502", "-0.1", "2"],
    ]);
    const shapes = buildShapes(readShapePoints(loaded, sink), "shapes.txt", sink);
    expect(shapes.get("S")?.publishedDistances).toBeUndefined();
    expect(sink.count("warning")).toBe(0);
  });
});

describe("fares", () => {
  const attributeHeader = [
    "fare_id",
    "price",
    "currency_type",
    "payment_method",
    "transfers",
    "transfer_duration",
  ];

  it("reads a fare", () => {
    const { loaded, sink } = loadTable("fare_attributes.txt", attributeHeader, [
      ["F", "2.50", "gbp", "1", "1", "3600"],
    ]);
    const fare = readFareAttributes(loaded, sink)[0];
    expect(fare?.price).toBe(2.5);
    expect(fare?.currencyType).toBe("GBP");
    expect(fare?.transfers).toBe(1);
    expect(allowsUnlimitedTransfers(fare as never)).toBe(false);
  });

  it("treats a blank transfer count as unlimited", () => {
    const { loaded, sink } = loadTable("fare_attributes.txt", attributeHeader, [
      ["F", "2.50", "GBP", "1", "", ""],
    ]);
    const fare = readFareAttributes(loaded, sink)[0];
    expect(fare?.transfers).toBeUndefined();
    expect(allowsUnlimitedTransfers(fare as never)).toBe(true);
  });

  it("drops a fare missing a required field", () => {
    const { loaded, sink } = loadTable("fare_attributes.txt", attributeHeader, [
      ["", "2.50", "GBP", "1", "", ""],
      ["F", "", "GBP", "1", "", ""],
      ["F", "2.50", "", "1", "", ""],
      ["F", "2.50", "GBP", "", "", ""],
    ]);
    expect(readFareAttributes(loaded, sink)).toEqual([]);
  });

  it("keeps the first of two fares with one id", () => {
    const { loaded, sink } = loadTable("fare_attributes.txt", attributeHeader, [
      ["F", "2.50", "GBP", "1", "", ""],
      ["F", "3.50", "GBP", "1", "", ""],
    ]);
    const fares = readFareAttributes(loaded, sink);
    expect(fares).toHaveLength(1);
    expect(fares[0]?.price).toBe(2.5);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "fare.duplicate")).toBe(true);
  });

  it("warns about mixed currencies", () => {
    const { loaded, sink } = loadTable("fare_attributes.txt", attributeHeader, [
      ["A", "2.50", "GBP", "1", "", ""],
      ["B", "3.00", "EUR", "1", "", ""],
    ]);
    readFareAttributes(loaded, sink);
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "fare.currency_mismatch")).toBe(true);
  });

  it("reads fare rules and scores their specificity", () => {
    const { loaded, sink } = loadTable(
      "fare_rules.txt",
      ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
      [
        ["F", "R", "", "", ""],
        ["F", "", "A", "B", ""],
        ["F", "", "", "", "Z"],
      ],
    );
    const rules = readFareRules(loaded, sink);
    expect(fareRuleSpecificity(rules[0] as never)).toBe(1);
    expect(fareRuleSpecificity(rules[1] as never)).toBe(4);
    expect(fareRuleSpecificity(rules[2] as never)).toBe(4);
  });

  it("notes a rule that constrains nothing", () => {
    const { loaded, sink } = loadTable("fare_rules.txt", ["fare_id", "route_id"], [["F", ""]]);
    readFareRules(loaded, sink);
    expect(sink.bySeverity("info").some((entry) => entry.rule === "fare.unconstrained_rule")).toBe(true);
  });

  it("drops a rule without a fare id", () => {
    const { loaded, sink } = loadTable("fare_rules.txt", ["fare_id", "route_id"], [["", "R"]]);
    expect(readFareRules(loaded, sink)).toEqual([]);
  });

  it("orders rules most specific first, then by fare id and line", () => {
    const { loaded, sink } = loadTable(
      "fare_rules.txt",
      ["fare_id", "route_id", "origin_id"],
      [
        ["B", "R", ""],
        ["A", "R", ""],
        ["C", "R", "Z"],
      ],
    );
    const sorted = readFareRules(loaded, sink).slice().sort(compareFareRules);
    expect(sorted.map((rule) => rule.fareId)).toEqual(["C", "A", "B"]);
  });
});

describe("pathways and levels", () => {
  const header = [
    "pathway_id",
    "from_stop_id",
    "to_stop_id",
    "pathway_mode",
    "is_bidirectional",
    "length",
    "traversal_time",
    "stair_count",
    "max_slope",
  ];

  it("reads a pathway", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "B", "1", "1", "50", "45", "", ""],
    ]);
    const pathway = readPathways(loaded, sink)[0] as Pathway;
    expect(pathway.pathwayMode).toBe(PathwayMode.Walkway);
    expect(traversalSeconds(pathway)).toBe(45);
    expect(sink.hasErrors()).toBe(false);
  });

  it("estimates traversal time from length and stairs", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "B", "2", "1", "22", "", "20", ""],
    ]);
    const pathway = readPathways(loaded, sink)[0] as Pathway;
    expect(traversalSeconds(pathway)).toBe(Math.ceil(22 / 1.1 + 20 * 1.5));
  });

  it("never reports a free traversal", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "B", "1", "1", "0", "", "", ""],
    ]);
    expect(traversalSeconds(readPathways(loaded, sink)[0] as Pathway)).toBe(1);
  });

  it("drops a self-loop", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "A", "1", "1", "", "", "", ""],
    ]);
    expect(readPathways(loaded, sink)).toEqual([]);
    expect(sink.bySeverity("error").some((entry) => entry.rule === "pathway.self_loop")).toBe(true);
  });

  it("drops a bidirectional exit gate", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "B", "7", "1", "", "", "", ""],
    ]);
    expect(readPathways(loaded, sink)).toEqual([]);
    expect(
      sink.bySeverity("error").some((entry) => entry.rule === "pathway.exit_gate_bidirectional"),
    ).toBe(true);
  });

  it("notes stairs without a stair count", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["P", "A", "B", "2", "1", "20", "", "", ""],
    ]);
    readPathways(loaded, sink);
    expect(sink.bySeverity("info").some((entry) => entry.rule === "pathway.stairs_without_count")).toBe(true);
  });

  it("drops a pathway missing a required field", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["", "A", "B", "1", "1", "", "", "", ""],
      ["P", "", "B", "1", "1", "", "", "", ""],
      ["P", "A", "", "1", "1", "", "", "", ""],
      ["P", "A", "B", "", "1", "", "", "", ""],
      ["P", "A", "B", "1", "", "", "", "", ""],
    ]);
    expect(readPathways(loaded, sink)).toEqual([]);
  });

  it("judges step-free access", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["A", "1", "2", "1", "1", "", "", "", ""],
      ["B", "1", "3", "2", "1", "", "", "10", ""],
      ["C", "1", "4", "1", "1", "", "", "5", ""],
      ["D", "1", "5", "1", "1", "", "", "", "0.2"],
      ["E", "1", "6", "1", "1", "", "", "", "0.05"],
    ]);
    const pathways = readPathways(loaded, sink);
    expect(isStepFree(pathways[0] as Pathway)).toBe(true);
    expect(isStepFree(pathways[1] as Pathway)).toBe(false);
    expect(isStepFree(pathways[2] as Pathway)).toBe(false);
    expect(isStepFree(pathways[3] as Pathway)).toBe(false);
    expect(isStepFree(pathways[4] as Pathway)).toBe(true);
  });

  it("honours directionality", () => {
    const { loaded, sink } = loadTable("pathways.txt", header, [
      ["A", "1", "2", "1", "1", "", "", "", ""],
      ["B", "1", "3", "1", "0", "", "", "", ""],
    ]);
    const pathways = readPathways(loaded, sink);
    expect(allowsDirection(pathways[0] as Pathway, "1")).toBe(true);
    expect(allowsDirection(pathways[0] as Pathway, "2")).toBe(true);
    expect(allowsDirection(pathways[1] as Pathway, "1")).toBe(true);
    expect(allowsDirection(pathways[1] as Pathway, "3")).toBe(false);
  });

  it("names every pathway mode", () => {
    const names = [1, 2, 3, 4, 5, 6, 7].map((mode) => pathwayModeName(mode as PathwayMode));
    expect(new Set(names).size).toBe(7);
    expect(names).toContain("lift");
  });

  it("reads levels", () => {
    const { loaded, sink } = loadTable(
      "levels.txt",
      ["level_id", "level_index", "level_name"],
      [
        ["L0", "0", "Street"],
        ["L1", "-1", "Platform"],
      ],
    );
    const levels = readLevels(loaded, sink);
    expect(levels).toHaveLength(2);
    expect(levels[1]?.levelIndex).toBe(-1);
  });

  it("drops a level missing a required field", () => {
    const { loaded, sink } = loadTable(
      "levels.txt",
      ["level_id", "level_index"],
      [
        ["", "0"],
        ["L", ""],
      ],
    );
    expect(readLevels(loaded, sink)).toEqual([]);
  });
});

describe("feed_info", () => {
  const header = [
    "feed_publisher_name",
    "feed_publisher_url",
    "feed_lang",
    "feed_start_date",
    "feed_end_date",
    "feed_version",
  ];

  it("reads the publisher and range", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["Rivertown", "https://r.example", "en", "20230601", "20230831", "v1"],
    ]);
    const info = readFeedInfo(loaded, sink);
    expect(info?.publisherName).toBe("Rivertown");
    expect(describeRange(info)).toBe("2023-06-01..2023-08-31");
  });

  it("returns undefined for a table with no rows", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, []);
    expect(readFeedInfo(loaded, sink)).toBeUndefined();
  });

  it("warns about extra rows and reads the first", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["First", "https://a.example", "en", "", "", ""],
      ["Second", "https://b.example", "en", "", "", ""],
    ]);
    expect(readFeedInfo(loaded, sink)?.publisherName).toBe("First");
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "feed_info.multiple_rows")).toBe(true);
  });

  it("returns undefined without a publisher name", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["", "https://a.example", "en", "", "", ""],
    ]);
    expect(readFeedInfo(loaded, sink)).toBeUndefined();
    expect(sink.hasErrors()).toBe(true);
  });

  it("rejects an inverted range", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["R", "https://a.example", "en", "20230831", "20230601", ""],
    ]);
    expect(readFeedInfo(loaded, sink)).toBeUndefined();
    expect(sink.bySeverity("error").some((entry) => entry.rule === "feed_info.range_inverted")).toBe(true);
  });

  it("warns about a half-stated range and ignores it", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["R", "https://a.example", "en", "20230601", "", ""],
    ]);
    const info = readFeedInfo(loaded, sink);
    expect(describeRange(info)).toBeUndefined();
    expect(sink.bySeverity("warning").some((entry) => entry.rule === "feed_info.partial_range")).toBe(true);
  });

  it("treats a feed with no range as covering every date", () => {
    expect(coversDate(undefined, ServiceDate.parse("20230605"))).toBe(true);
  });

  it("checks a date against a stated range", () => {
    const { loaded, sink } = loadTable("feed_info.txt", header, [
      ["R", "https://a.example", "en", "20230601", "20230831", ""],
    ]);
    const info = readFeedInfo(loaded, sink);
    expect(coversDate(info, ServiceDate.parse("20230605"))).toBe(true);
    expect(coversDate(info, ServiceDate.parse("20230901"))).toBe(false);
  });
});
