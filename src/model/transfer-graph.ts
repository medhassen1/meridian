/**
 * The footpath graph: how a passenger moves between stops on foot.
 *
 * Two sources feed it. The agency's own `transfers.txt` is authoritative and
 * may forbid an interchange outright. Everything else is generated from
 * geometry, because no feed publishes a transfer for every pair of stops that
 * happen to be a short walk apart, and without generated footpaths a journey
 * planner cannot change between two operators' stops across a street.
 *
 * RAPTOR assumes the footpath relation is transitively closed: if A→B and B→C
 * are footpaths, A→C must be one too, or the algorithm can miss a journey
 * whose only viable interchange chains two short walks. Closure is therefore
 * available as an option, defaulting on, with a bound on the total walk so the
 * closure stays finite and small.
 */

import { NetworkBuildError } from "../errors.js";
import { walkingSeconds } from "../geo/distance.js";
import {
  TransferType,
  requiredTransferSeconds,
  transferSpecificity,
  type Transfer,
} from "../feed/transfers.js";
import { stopIndex, type StopIndex } from "./ids.js";
import type { StopCatalogue } from "./stop-index.js";

/** A walk from one stop to another. */
export interface Footpath {
  readonly to: StopIndex;
  /** Seconds the walk takes, always at least one. */
  readonly seconds: number;
  /** True when the walk came from `transfers.txt` rather than from geometry. */
  readonly published: boolean;
}

/** Options controlling footpath generation. */
export interface TransferGraphOptions {
  /** Straight line radius searched for walkable neighbours, in metres. */
  readonly maxWalkMetres?: number;
  /** Walking speed in metres per second. */
  readonly walkSpeed?: number;
  /** Multiplier applied to straight line distance to approximate a street path. */
  readonly straightnessFactor?: number;
  /** Seconds added to every generated walk, modelling the time to get moving. */
  readonly boardingSlackSeconds?: number;
  /** Whether to transitively close the footpath relation. Defaults to true. */
  readonly transitiveClosure?: boolean;
  /** Longest total walk permitted after closure, in seconds. */
  readonly maxTransferSeconds?: number;
}

/** Default straight line search radius, in metres. */
export const DEFAULT_MAX_WALK_METRES = 400;

/** Default walking speed, in metres per second — a brisk 4.7 km/h. */
export const DEFAULT_WALK_SPEED = 1.3;

/** Default slack added to a generated walk, in seconds. */
export const DEFAULT_BOARDING_SLACK = 20;

/** Default ceiling on a single transfer after closure, in seconds. */
export const DEFAULT_MAX_TRANSFER_SECONDS = 900;

/**
 * An immutable adjacency list of footpaths.
 *
 * Entries for each stop are sorted by ascending walk time, then by destination
 * index, so relaxation order — and therefore tie-breaking in results — does
 * not depend on how the graph was assembled.
 */
export class TransferGraph {
  private readonly adjacency: ReadonlyArray<readonly Footpath[]>;

  private constructor(adjacency: ReadonlyArray<readonly Footpath[]>) {
    this.adjacency = adjacency;
  }

  /** Builds a graph with no footpaths at all. */
  static empty(stopCount: number): TransferGraph {
    return new TransferGraph(Array.from({ length: stopCount }, () => []));
  }

  /**
   * Builds the graph from published transfers and stop geometry.
   *
   * @throws {NetworkBuildError} if an option is out of range.
   */
  static build(
    catalogue: StopCatalogue,
    transfers: readonly Transfer[],
    options: TransferGraphOptions = {},
  ): TransferGraph {
    const maxWalkMetres = options.maxWalkMetres ?? DEFAULT_MAX_WALK_METRES;
    const walkSpeed = options.walkSpeed ?? DEFAULT_WALK_SPEED;
    const straightness = options.straightnessFactor ?? 1.4;
    const slack = options.boardingSlackSeconds ?? DEFAULT_BOARDING_SLACK;
    const maxTransferSeconds = options.maxTransferSeconds ?? DEFAULT_MAX_TRANSFER_SECONDS;

    if (maxWalkMetres < 0) {
      throw new NetworkBuildError("maxWalkMetres must not be negative", { maxWalkMetres });
    }
    if (slack < 0) {
      throw new NetworkBuildError("boardingSlackSeconds must not be negative", { slack });
    }

    const { overrides, forbidden } = collectPublishedRules(catalogue, transfers);
    const stopCount = catalogue.count;
    const times = Array.from({ length: stopCount }, () => new Map<number, number>());
    const publishedEdges = Array.from({ length: stopCount }, () => new Set<number>());

    // Generated footpaths from geometry.
    for (let from = 0; from < stopCount; from += 1) {
      const origin = stopIndex(from);
      const point = catalogue.coordinateAt(origin);
      if (point === undefined || !catalogue.isBoardable(origin)) {
        continue;
      }
      for (const match of catalogue.nearby(point, maxWalkMetres)) {
        const to = match.value;
        if (to === origin || !catalogue.isBoardable(to)) {
          continue;
        }
        if (forbidden.has(edgeKey(from, to))) {
          continue;
        }
        const seconds =
          walkingSeconds(match.distanceMetres, walkSpeed, straightness) + slack;
        record(times[from] as Map<number, number>, to, seconds);
      }
    }

    // Published rules override anything geometry produced, in both directions
    // of specificity: a stated minimum time replaces a generated estimate even
    // when it is longer.
    for (const [key, seconds] of overrides) {
      const [from, to] = splitKey(key);
      if (forbidden.has(key)) {
        continue;
      }
      (times[from] as Map<number, number>).set(to, seconds);
      (publishedEdges[from] as Set<number>).add(to);
    }

    for (const key of forbidden) {
      const [from, to] = splitKey(key);
      (times[from] as Map<number, number>).delete(to);
      (publishedEdges[from] as Set<number>).delete(to);
    }

    if (options.transitiveClosure ?? true) {
      closeTransitively(times, maxTransferSeconds, forbidden);
    }

    const adjacency: Footpath[][] = times.map((edges, from) =>
      Array.from(edges.entries())
        .filter(([to, seconds]) => to !== from && seconds <= maxTransferSeconds)
        .map(([to, seconds]) => ({
          to: stopIndex(to),
          seconds: Math.max(1, Math.round(seconds)),
          published: (publishedEdges[from] as Set<number>).has(to),
        }))
        .sort((a, b) => a.seconds - b.seconds || a.to - b.to),
    );

    return new TransferGraph(adjacency);
  }

  /** The footpaths leaving a stop, ascending by walk time. */
  from(stop: StopIndex): readonly Footpath[] {
    return this.adjacency[stop] ?? [];
  }

  /** Walk time from one stop to another, or `undefined` when there is no path. */
  secondsBetween(from: StopIndex, to: StopIndex): number | undefined {
    return this.from(from).find((footpath) => footpath.to === to)?.seconds;
  }

  /** Total number of footpaths in the graph. */
  get edgeCount(): number {
    let total = 0;
    for (const edges of this.adjacency) {
      total += edges.length;
    }
    return total;
  }

  /** Number of stops the graph covers. */
  get stopCount(): number {
    return this.adjacency.length;
  }

  /** Stops reachable on foot from a stop, excluding the stop itself. */
  neighbours(stop: StopIndex): StopIndex[] {
    return this.from(stop).map((footpath) => footpath.to);
  }
}

/** Published overrides and outright prohibitions, keyed by stop pair. */
function collectPublishedRules(
  catalogue: StopCatalogue,
  transfers: readonly Transfer[],
): { overrides: Map<number, number>; forbidden: Set<number> } {
  const overrides = new Map<number, number>();
  const specificities = new Map<number, number>();
  const forbidden = new Set<number>();

  // Sorted so that, among rules of equal specificity, the earlier row wins —
  // matching the duplicate-key policy used when loading.
  const ordered = transfers
    .slice()
    .sort((a, b) => transferSpecificity(a) - transferSpecificity(b) || a.line - b.line);

  for (const transfer of ordered) {
    if (transfer.fromStopId === undefined || transfer.toStopId === undefined) {
      // A trip-scoped in-seat rule; the routing engine reads those directly
      // from the feed rather than through the footpath graph.
      continue;
    }
    const from = catalogue.indexOf(transfer.fromStopId);
    const to = catalogue.indexOf(transfer.toStopId);
    if (from === undefined || to === undefined) {
      continue;
    }
    const key = edgeKey(from, to);

    if (transfer.transferType === TransferType.NotPossible) {
      forbidden.add(key);
      overrides.delete(key);
      continue;
    }

    const seconds = requiredTransferSeconds(transfer);
    if (seconds === undefined) {
      continue;
    }
    const specificity = transferSpecificity(transfer);
    const existing = specificities.get(key);
    if (existing === undefined || specificity >= existing) {
      specificities.set(key, specificity);
      overrides.set(key, seconds);
      forbidden.delete(key);
    }
  }

  return { overrides, forbidden };
}

/**
 * Closes the relation transitively, bounded by `maxSeconds`.
 *
 * Repeated relaxation rather than a full shortest-path run: footpath graphs are
 * extremely sparse and the bound keeps chains to two or three hops, so the
 * loop converges in a handful of passes. The pass counter is a guard against a
 * pathological feed rather than an expected limit.
 *
 * Prohibited pairs are excluded throughout. Closure would otherwise reinstate
 * an interchange the agency explicitly forbade, by routing it through a third
 * stop — which is precisely the walk the prohibition exists to prevent.
 */
function closeTransitively(
  times: Array<Map<number, number>>,
  maxSeconds: number,
  forbidden: ReadonlySet<number>,
): void {
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let changed = false;
    for (let from = 0; from < times.length; from += 1) {
      const direct = times[from] as Map<number, number>;
      // Snapshot: extending the map while iterating it would let a single pass
      // chain arbitrarily far, which is exactly what the bound is meant to
      // prevent.
      const hops = Array.from(direct.entries());
      for (const [middle, firstLeg] of hops) {
        const onward = times[middle];
        if (onward === undefined) {
          continue;
        }
        for (const [to, secondLeg] of onward) {
          if (to === from || forbidden.has(edgeKey(from, to))) {
            continue;
          }
          const total = firstLeg + secondLeg;
          if (total > maxSeconds) {
            continue;
          }
          const existing = direct.get(to);
          if (existing === undefined || total < existing) {
            direct.set(to, total);
            changed = true;
          }
        }
      }
    }
    if (!changed) {
      return;
    }
  }
}

function record(edges: Map<number, number>, to: number, seconds: number): void {
  const existing = edges.get(to);
  if (existing === undefined || seconds < existing) {
    edges.set(to, seconds);
  }
}

/**
 * Packs a stop pair into one number.
 *
 * The multiplier bounds a network at just over four million stops, which is
 * two orders of magnitude beyond the largest published feed.
 */
const KEY_STRIDE = 4_194_304;

function edgeKey(from: number, to: number): number {
  return from * KEY_STRIDE + to;
}

function splitKey(key: number): [number, number] {
  return [Math.floor(key / KEY_STRIDE), key % KEY_STRIDE];
}
