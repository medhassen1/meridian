/**
 * Dense integer identifiers for the routing engine.
 *
 * RAPTOR keeps one label per stop per round and sweeps them repeatedly. With
 * string keys that means a hash lookup in the innermost loop; with dense
 * integers it is an array index, and the label arrays can be typed arrays that
 * the engine reuses between rounds instead of reallocating.
 *
 * The mapping is built once, when a feed is compiled into a network, and is
 * fixed for that network's lifetime. Branded types keep the three index spaces
 * — stops, patterns, trips — from being confused for one another, since all
 * three are plain numbers at runtime.
 */

import { MeridianError } from "../errors.js";

declare const stopIndexBrand: unique symbol;
declare const patternIndexBrand: unique symbol;
declare const tripIndexBrand: unique symbol;

/** A stop's position in the network's stop table. */
export type StopIndex = number & { readonly [stopIndexBrand]: true };

/** A pattern's position in the network's pattern table. */
export type PatternIndex = number & { readonly [patternIndexBrand]: true };

/** A trip's position within its pattern's timetable. */
export type TripIndex = number & { readonly [tripIndexBrand]: true };

/** Wraps a number as a stop index. */
export function stopIndex(value: number): StopIndex {
  return value as StopIndex;
}

/** Wraps a number as a pattern index. */
export function patternIndex(value: number): PatternIndex {
  return value as PatternIndex;
}

/** Wraps a number as a trip index. */
export function tripIndex(value: number): TripIndex {
  return value as TripIndex;
}

/**
 * Assigns each distinct string a stable integer, in first-seen order.
 *
 * First-seen order rather than sorted order because the caller controls the
 * insertion sequence: the network builder feeds ids in sorted order, so the
 * result is deterministic without the interner having to buffer and sort.
 */
export class Interner {
  private readonly indexById = new Map<string, number>();
  private readonly idByIndex: string[] = [];

  /** Returns the id's index, assigning one if this is the first sighting. */
  intern(id: string): number {
    const existing = this.indexById.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.idByIndex.length;
    this.indexById.set(id, index);
    this.idByIndex.push(id);
    return index;
  }

  /** The id's index, or `undefined` when it was never interned. */
  indexOf(id: string): number | undefined {
    return this.indexById.get(id);
  }

  /**
   * The id at an index.
   *
   * @throws {MeridianError} if the index was never assigned. This is a
   * programmer error rather than a data error, so it throws rather than
   * returning `undefined` and pushing the check to every call site.
   */
  idAt(index: number): string {
    const id = this.idByIndex[index];
    if (id === undefined) {
      throw new MeridianError("NETWORK_BUILD", `no interned id at index ${index}`, { index });
    }
    return id;
  }

  /** True when the id has been interned. */
  has(id: string): boolean {
    return this.indexById.has(id);
  }

  /** Number of distinct ids interned. */
  get size(): number {
    return this.idByIndex.length;
  }

  /** Every id, in index order. */
  ids(): readonly string[] {
    return this.idByIndex;
  }
}

/**
 * A value used where an index is expected but none applies.
 *
 * Typed arrays cannot hold `undefined`, so absence is encoded as -1 throughout
 * the routing engine. Naming it removes the ambiguity of a bare literal.
 */
export const NO_INDEX = -1;

/** True when a raw index value denotes a real entry. */
export function isIndex(value: number): boolean {
  return value >= 0;
}
