import { describe, expect, it } from "vitest";

import { ServiceDate } from "../../src/time/date.js";
import { summariseFeed } from "../../src/feed/feed.js";
import { computeReach } from "../../src/isochrone/reach.js";
import {
  planJourney,
  planProfile,
  type PlanResult,
  type PlannedJourney,
} from "../../src/planner.js";
import {
  ELLIPSIS,
  displayWidth,
  indent,
  renderPairs,
  renderTable,
  wrap,
} from "../../src/report/table.js";
import {
  renderDepartureBoard,
  renderFeedSummary,
  renderJourney,
  renderLeg,
  renderNetworkStatistics,
  renderPlan,
} from "../../src/report/text.js";
import {
  itineraryToJson,
  journeyToJson,
  planToJson,
  reachToJson,
  sortKeys,
  timeObject,
} from "../../src/report/json.js";
import { MONDAY, rivertownNetwork } from "../support/fixtures.js";

const network = rivertownNetwork();
const plan = planJourney(network, {
  from: { kind: "stop", stopId: "NORTH" },
  to: { kind: "stop", stopId: "HARBOUR" },
  date: MONDAY,
  departAfter: "07:45:00",
});
const emptyPlan = planJourney(network, {
  from: { kind: "stop", stopId: "NORTH" },
  to: { kind: "stop", stopId: "HARBOUR" },
  date: ServiceDate.parse("20231001"),
  departAfter: "07:45:00",
});

describe("renderTable", () => {
  it("aligns columns to their widest cell", () => {
    const text = renderTable(
      [{ header: "Name" }, { header: "Count", align: "right" }],
      [
        ["Alpha", "1"],
        ["Beta", "22"],
      ],
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Name   Count");
    expect(lines[2]).toBe("Alpha      1");
  });

  it("draws a rule under the header by default", () => {
    expect(renderTable([{ header: "A" }], [["1"]]).split("\n")[1]).toBe("-");
  });

  it("omits the rule when asked", () => {
    expect(renderTable([{ header: "A" }], [["1"]], { rule: false }).split("\n")).toHaveLength(2);
  });

  it("uses a custom gap", () => {
    expect(renderTable([{ header: "A" }, { header: "B" }], [["1", "2"]], { gap: " | " })).toContain(
      "A | B",
    );
  });

  it("pads short rows and truncates long ones", () => {
    const text = renderTable([{ header: "A" }, { header: "B" }], [["1"], ["1", "2", "3"]]);
    expect(text.split("\n")).toHaveLength(4);
  });

  it("truncates cells past a maximum width", () => {
    const text = renderTable([{ header: "A", maxWidth: 4 }], [["abcdefgh"]]);
    expect(text).toContain(`abc${ELLIPSIS}`);
  });

  it("returns empty text for no columns", () => {
    expect(renderTable([], [["1"]])).toBe("");
  });

  it("uses the empty text for a table with no rows", () => {
    expect(renderTable([{ header: "A" }], [], { emptyText: "nothing" })).toBe("nothing");
  });

  it("still renders the header for an empty table with no empty text", () => {
    expect(renderTable([{ header: "A" }], [])).toContain("A");
  });

  it("leaves no trailing whitespace", () => {
    const text = renderTable([{ header: "A" }, { header: "B" }], [["long-value", "x"]]);
    expect(text.split("\n").every((line) => !/\s$/.test(line))).toBe(true);
  });

  it("renders deterministically", () => {
    const rows = [["a", "1"], ["b", "2"]];
    expect(renderTable([{ header: "A" }, { header: "B" }], rows)).toBe(
      renderTable([{ header: "A" }, { header: "B" }], rows),
    );
  });
});

describe("renderPairs", () => {
  it("aligns keys", () => {
    const text = renderPairs([
      ["short", "1"],
      ["much longer", "2"],
    ]);
    expect(text.split("\n")[0]).toBe("short        1");
  });

  it("returns empty text for no pairs", () => {
    expect(renderPairs([])).toBe("");
  });
});

describe("indent and wrap", () => {
  it("indents non-blank lines only", () => {
    expect(indent("a\n\nb", 2)).toBe("  a\n\n  b");
  });

  it("wraps on spaces", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("returns the whole text for a non-positive width", () => {
    expect(wrap("one two", 0)).toEqual(["one two"]);
  });

  it("returns a single empty line for blank text", () => {
    expect(wrap("   ", 10)).toEqual([""]);
  });

  it("keeps a word longer than the width on its own line", () => {
    expect(wrap("short verylongwordindeed", 6)).toEqual(["short", "verylongwordindeed"]);
  });

  it("counts code points rather than UTF-16 units", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("a🚌c")).toBe(3);
  });
});

describe("text rendering", () => {
  it("renders a journey with a headline and legs", () => {
    const text = renderJourney(plan.journeys[0] as never);
    expect(text).toContain("→");
    expect(text).toContain("Northgate");
    expect(text).toContain("fare:");
  });

  it("omits the fare when asked", () => {
    expect(renderJourney(plan.journeys[0] as never, { showFare: false })).not.toContain("fare:");
  });

  it("lists intermediate stops when asked", () => {
    const text = renderJourney(plan.journeys[0] as never, { showIntermediateStops: true });
    expect(text).toContain("Market Square");
  });

  it("applies a prefix as an indent", () => {
    expect(renderJourney(plan.journeys[0] as never, { prefix: "  " }).startsWith("  ")).toBe(true);
  });

  it("renders a plan with one block per option", () => {
    const text = renderPlan(plan);
    expect(text).toContain("Option 1");
  });

  it("says so when a plan found nothing", () => {
    expect(renderPlan(emptyPlan)).toBe("No journey found.");
    expect(renderDepartureBoard(emptyPlan)).toBe("No journey found.");
  });

  it("renders a departure board with a route chain", () => {
    const board = renderDepartureBoard(plan);
    expect(board).toContain("Depart");
    expect(board).toContain("2 → 1");
  });

  it("labels a walking journey on the board", () => {
    const first = plan.journeys[0] as PlannedJourney;
    const walkPlan: PlanResult = {
      ...plan,
      journeys: [
        { ...first, itinerary: { ...first.itinerary, legs: [], boardings: 0, transfers: 0 } },
      ],
    };
    expect(renderDepartureBoard(walkPlan)).toContain("walk");
  });

  it("renders each kind of leg", () => {
    for (const leg of (plan.journeys[0] as never as { itinerary: { legs: unknown[] } }).itinerary.legs) {
      expect(renderLeg(leg as never).length).toBeGreaterThan(5);
    }
  });

  it("labels a published transfer as such", () => {
    const walk = (plan.journeys[0] as never as { itinerary: { legs: Array<{ kind: string }> } }).itinerary.legs.find(
      (leg) => leg.kind === "walk",
    );
    expect(renderLeg(walk as never)).toContain("published transfer");
  });

  it("renders an egress leg", () => {
    const egressPlan = planJourney(network, {
      from: { kind: "stop", stopId: "NORTH" },
      to: { kind: "coordinate", at: { latitude: 51.5001, longitude: -0.0999 } },
      date: MONDAY,
      departAfter: "07:45:00",
    });
    const text = renderPlan(egressPlan);
    expect(text).toContain("walk");
  });

  it("renders a feed summary", () => {
    const text = renderFeedSummary(summariseFeed(network.feed));
    expect(text).toContain("agencies");
    expect(text).toContain("boardable");
  });

  it("renders network statistics", () => {
    const text = renderNetworkStatistics(network.statistics());
    expect(text).toContain("patterns");
    expect(text).toContain("overhang");
  });

  it("mentions overtaking patterns when there are any", () => {
    const statistics = { ...network.statistics(), overtakingPatterns: 3 };
    expect(renderNetworkStatistics(statistics)).toContain("overtaking");
  });

  it("renders deterministically", () => {
    expect(renderPlan(plan)).toBe(renderPlan(plan));
  });
});

describe("JSON rendering", () => {
  it("renders a plan with sorted top-level keys", () => {
    const parsed = JSON.parse(planToJson(plan)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["date", "journeys", "statistics"]);
  });

  it("renders each journey with sorted keys", () => {
    const parsed = JSON.parse(planToJson(plan)) as { journeys: Array<Record<string, unknown>> };
    expect(Object.keys(parsed.journeys[0] as Record<string, unknown>)).toEqual([
      "arrival",
      "boardings",
      "departure",
      "fare",
      "legs",
      "metrics",
      "totalSeconds",
      "transfers",
    ]);
  });

  it("includes intermediate stops only when asked", () => {
    const without = JSON.parse(planToJson(plan)) as {
      journeys: Array<{ legs: Array<Record<string, unknown>> }>;
    };
    const ride = without.journeys[0]?.legs.find((leg) => leg["kind"] === "ride");
    expect(ride?.["intermediateStops"]).toBeUndefined();

    const withStops = JSON.parse(planToJson(plan, { includeIntermediateStops: true })) as {
      journeys: Array<{ legs: Array<Record<string, unknown>> }>;
    };
    const rideWith = withStops.journeys[0]?.legs.find((leg) => leg["kind"] === "ride");
    expect(rideWith?.["intermediateStops"]).toBeDefined();
  });

  it("renders one journey alone", () => {
    const parsed = JSON.parse(journeyToJson(plan.journeys[0] as never)) as Record<string, unknown>;
    expect(parsed["boardings"]).toBe(2);
  });

  it("renders an itinerary alone", () => {
    const parsed = JSON.parse(
      itineraryToJson(plan.journeys[0]?.itinerary as never),
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "arrival",
      "boardings",
      "date",
      "departure",
      "legs",
      "totalSeconds",
      "transfers",
    ]);
  });

  it("renders on a single line at indent zero", () => {
    expect(planToJson(plan, { indent: 0 })).not.toContain("\n");
  });

  it("renders each time as a clock, day offset, and second count", () => {
    expect(timeObject(8 * 3600 + 30 * 60)).toEqual({
      clock: "08:30:00",
      dayOffset: 0,
      seconds: 30_600,
    });
    expect(timeObject(-600).dayOffset).toBe(-1);
    expect(timeObject(-600).clock).toBe("23:50:00");
    expect(timeObject(25 * 3600).dayOffset).toBe(1);
  });

  it("sorts an object's keys", () => {
    expect(Object.keys(sortKeys({ z: 1, a: 2, m: 3 }))).toEqual(["a", "m", "z"]);
  });

  it("renders a reachability result", () => {
    const result = computeReach(network, {
      from: { kind: "stop", stopId: "CENTRAL_A" },
      date: MONDAY,
      departAfter: "07:55:00",
      budgetSeconds: 1800,
    });
    const parsed = JSON.parse(reachToJson(result)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "budgetSeconds",
      "date",
      "departAfter",
      "origin",
      "reached",
    ]);
  });

  it("renders an empty plan", () => {
    const parsed = JSON.parse(planToJson(emptyPlan)) as { journeys: unknown[] };
    expect(parsed.journeys).toEqual([]);
  });

  it("renders deterministically", () => {
    expect(planToJson(plan)).toBe(planToJson(plan));
  });

  it("renders a profile plan", () => {
    const profile = planProfile(
      network,
      {
        from: { kind: "stop", stopId: "CENTRAL_A" },
        to: { kind: "stop", stopId: "HARBOUR" },
        date: MONDAY,
        departAfter: "07:30:00",
      },
      { windowSeconds: 2 * 3600 },
    );
    const parsed = JSON.parse(planToJson(profile)) as { journeys: unknown[] };
    expect(parsed.journeys).toHaveLength(3);
  });
});
