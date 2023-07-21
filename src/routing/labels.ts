/**
 * Arrival labels and the back-pointers that reconstruct a journey.
 *
 * RAPTOR keeps, for each round, the earliest arrival time at every stop using
 * at most that many boardings. Two things follow from the shape of that state.
 * The times are dense and numeric, so they live in `Int32Array`s that are
 * allocated once per query and reused across rounds. The back-pointers are
 * sparse — only stops actually improved in a round have one — so they live in
 * plain arrays indexed the same way.
 *
 * A separate `best` array tracks the earliest arrival at each stop across all
 * rounds. It is what target pruning tests against, and it is why RAPTOR does
 * not need a priority queue.
 */

import type { PatternIndex, StopIndex, TripIndex } from "../model/ids.js";
import type { DayAnchor } from "./day-scan.js";

/**
 * Sentinel for "not reached".
 *
 * Chosen to fit comfortably inside `Int32Array` while leaving room for a
 * journey to add several hours to it without wrapping, which would turn an
 * unreachable stop into a very attractive one.
 */
export const UNREACHED = 0x3f_ff_ff_ff;

/** How a stop was reached, in a given round. */
export type Leg =
  | {
      readonly kind: "ride";
      /** Pattern boarded. */
      readonly pattern: PatternIndex;
      /** Trip boarded, within that pattern's timetable. */
      readonly trip: TripIndex;
      /** Service day the trip was read from. */
      readonly anchor: DayAnchor;
      /** Stop boarded at. */
      readonly from: StopIndex;
      /** Position of the boarding stop in the pattern. */
      readonly fromPosition: number;
      /** Position of the alighting stop in the pattern. */
      readonly toPosition: number;
      /** Absolute departure from the boarding stop. */
      readonly departure: number;
      /** Absolute arrival at the alighting stop. */
      readonly arrival: number;
    }
  | {
      readonly kind: "walk";
      readonly from: StopIndex;
      readonly seconds: number;
      readonly departure: number;
      readonly arrival: number;
      /** True when the walk came from `transfers.txt`. */
      readonly published: boolean;
    }
  | {
      readonly kind: "access";
      readonly seconds: number;
      readonly departure: number;
      readonly arrival: number;
    };

/**
 * Per-round arrival times and back-pointers.
 *
 * Round 0 holds the state after access walks and before any boarding; round
 * `k` holds the state after at most `k` boardings.
 */
export class LabelSet {
  /** Number of stops the labels cover. */
  readonly stopCount: number;

  /** Highest round index allocated. */
  readonly maxRound: number;

  private readonly arrivals: Int32Array[];
  private readonly legs: Array<Array<Leg | undefined>>;
  private readonly best: Int32Array;

  constructor(stopCount: number, maxRound: number) {
    this.stopCount = stopCount;
    this.maxRound = maxRound;
    this.arrivals = Array.from({ length: maxRound + 1 }, () =>
      new Int32Array(stopCount).fill(UNREACHED),
    );
    this.legs = Array.from({ length: maxRound + 1 }, () =>
      new Array<Leg | undefined>(stopCount).fill(undefined),
    );
    this.best = new Int32Array(stopCount).fill(UNREACHED);
  }

  /** Arrival time at a stop in a round, or {@link UNREACHED}. */
  arrivalAt(round: number, stop: StopIndex): number {
    return (this.arrivals[round] as Int32Array)[stop] as number;
  }

  /** Earliest arrival at a stop across every round so far. */
  bestArrivalAt(stop: StopIndex): number {
    return this.best[stop] as number;
  }

  /** The leg by which a stop was reached in a round. */
  legAt(round: number, stop: StopIndex): Leg | undefined {
    return (this.legs[round] as Array<Leg | undefined>)[stop];
  }

  /** True when the stop was reached in the round. */
  isReached(round: number, stop: StopIndex): boolean {
    return this.arrivalAt(round, stop) !== UNREACHED;
  }

  /** True when the stop was reached in any round. */
  isReachedEver(stop: StopIndex): boolean {
    return this.bestArrivalAt(stop) !== UNREACHED;
  }

  /**
   * Records an arrival, if it improves on what the round already had.
   *
   * Returns true when the label changed, which is what tells the engine to
   * mark the stop for the next round.
   */
  improve(round: number, stop: StopIndex, arrival: number, leg: Leg): boolean {
    const times = this.arrivals[round] as Int32Array;
    if (arrival >= (times[stop] as number)) {
      return false;
    }
    times[stop] = arrival;
    (this.legs[round] as Array<Leg | undefined>)[stop] = leg;
    if (arrival < (this.best[stop] as number)) {
      this.best[stop] = arrival;
    }
    return true;
  }

  /**
   * Carries every arrival from one round into the next.
   *
   * RAPTOR's rounds are cumulative: a journey using two boardings is still
   * available when three are permitted, so the later round starts from the
   * earlier one's state rather than from nothing.
   */
  carryForward(fromRound: number, toRound: number): void {
    const source = this.arrivals[fromRound] as Int32Array;
    const target = this.arrivals[toRound] as Int32Array;
    target.set(source);
    const sourceLegs = this.legs[fromRound] as Array<Leg | undefined>;
    const targetLegs = this.legs[toRound] as Array<Leg | undefined>;
    for (let stop = 0; stop < this.stopCount; stop += 1) {
      targetLegs[stop] = sourceLegs[stop];
    }
  }

  /**
   * The earliest arrival at any of a set of stops, plus the round that
   * achieved it.
   *
   * Ties resolve to the *lower* round: fewer boardings is the better journey
   * when the arrival time is the same.
   */
  earliestAmong(stops: Iterable<StopIndex>): { round: number; stop: StopIndex; arrival: number } | undefined {
    let best: { round: number; stop: StopIndex; arrival: number } | undefined;
    for (let round = 0; round <= this.maxRound; round += 1) {
      for (const stop of stops) {
        const arrival = this.arrivalAt(round, stop);
        if (arrival === UNREACHED) {
          continue;
        }
        if (best === undefined || arrival < best.arrival) {
          best = { round, stop, arrival };
        }
      }
    }
    return best;
  }

  /** Number of stops reached in a round. */
  reachedCount(round: number): number {
    let count = 0;
    const times = this.arrivals[round] as Int32Array;
    for (let stop = 0; stop < this.stopCount; stop += 1) {
      if ((times[stop] as number) !== UNREACHED) {
        count += 1;
      }
    }
    return count;
  }
}

/**
 * The set of stops improved in the current round.
 *
 * A bitmap plus a list: membership tests are constant time and the iteration
 * order is insertion order, which keeps the pattern scan deterministic without
 * a sort. Clearing resets only the entries that were set, so the cost of a
 * round is proportional to what changed rather than to the network size.
 */
export class MarkedStops {
  private readonly flags: Uint8Array;
  private order: StopIndex[] = [];

  constructor(stopCount: number) {
    this.flags = new Uint8Array(stopCount);
  }

  /** Adds a stop. Returns true when it was not already marked. */
  add(stop: StopIndex): boolean {
    if (this.flags[stop] === 1) {
      return false;
    }
    this.flags[stop] = 1;
    this.order.push(stop);
    return true;
  }

  /** True when the stop is marked. */
  has(stop: StopIndex): boolean {
    return this.flags[stop] === 1;
  }

  /** Marked stops, in the order they were added. */
  values(): readonly StopIndex[] {
    return this.order;
  }

  /** Number of marked stops. */
  get size(): number {
    return this.order.length;
  }

  /** True when nothing is marked. */
  get isEmpty(): boolean {
    return this.order.length === 0;
  }

  /** Removes every mark. */
  clear(): void {
    for (const stop of this.order) {
      this.flags[stop] = 0;
    }
    this.order = [];
  }

  /** Takes the marked stops and clears the set in one step. */
  drain(): StopIndex[] {
    const taken = this.order;
    for (const stop of taken) {
      this.flags[stop] = 0;
    }
    this.order = [];
    return taken;
  }
}
