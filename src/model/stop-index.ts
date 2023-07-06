/**
 * The network's stop table.
 *
 * Holds every stop the feed defines — not only the boardable ones — because
 * parent station relationships have to resolve, and a station's index is what
 * lets two of its platforms be recognised as the same place. Routing itself
 * only ever visits indices that a pattern actually reaches.
 */

import { GeometryError } from "../errors.js";
import type { Coordinate } from "../geo/coordinate.js";
import { SpatialGrid, type GridMatch } from "../geo/grid.js";
import { boundingBoxOf, boxCentre, type BoundingBox } from "../geo/bbox.js";
import { LocationType, isBoardable, stopLabel, type Stop } from "../feed/stops.js";
import { Interner, stopIndex, type StopIndex } from "./ids.js";

/** Cell size of the stop spatial grid, in metres. */
export const STOP_GRID_CELL_METRES = 500;

/**
 * An immutable, index-addressed view of a feed's stops.
 *
 * Built once per network. Every accessor is total over `[0, count)`.
 */
export class StopCatalogue {
  private readonly interner: Interner;
  private readonly stops: readonly Stop[];
  private readonly parents: Int32Array;
  private readonly children: ReadonlyArray<readonly StopIndex[]>;
  private readonly boardable: readonly boolean[];
  private readonly grid: SpatialGrid<StopIndex>;
  private readonly extent: BoundingBox | undefined;

  private constructor(
    interner: Interner,
    stops: readonly Stop[],
    parents: Int32Array,
    children: ReadonlyArray<readonly StopIndex[]>,
    boardable: readonly boolean[],
    grid: SpatialGrid<StopIndex>,
    extent: BoundingBox | undefined,
  ) {
    this.interner = interner;
    this.stops = stops;
    this.parents = parents;
    this.children = children;
    this.boardable = boardable;
    this.grid = grid;
    this.extent = extent;
  }

  /**
   * Builds a catalogue from a feed's stops.
   *
   * Stops are indexed in ascending id order rather than file order, so two
   * networks built from feeds whose rows were shuffled produce identical
   * indices and therefore identical routing results.
   */
  static build(stops: readonly Stop[]): StopCatalogue {
    const sorted = stops.slice().sort((a, b) => a.stopId.localeCompare(b.stopId));
    const interner = new Interner();
    for (const stop of sorted) {
      interner.intern(stop.stopId);
    }

    const parents = new Int32Array(sorted.length).fill(-1);
    const childLists: StopIndex[][] = sorted.map(() => []);
    const boardable = sorted.map((stop) => isBoardable(stop));

    for (let index = 0; index < sorted.length; index += 1) {
      const stop = sorted[index] as Stop;
      if (stop.parentStation === undefined) {
        continue;
      }
      const parent = interner.indexOf(stop.parentStation);
      if (parent === undefined) {
        // A dangling parent reference is reported by the validator; here it is
        // simply treated as no parent, which keeps the stop routable.
        continue;
      }
      parents[index] = parent;
      (childLists[parent] as StopIndex[]).push(stopIndex(index));
    }

    const located = sorted
      .map((stop) => stop.coordinate)
      .filter((point): point is Coordinate => point !== undefined);
    const extent = located.length > 0 ? boundingBoxOf(located) : undefined;
    const referenceLatitude = extent === undefined ? 0 : boxCentre(extent).latitude;

    const grid = new SpatialGrid<StopIndex>(STOP_GRID_CELL_METRES, referenceLatitude);
    for (let index = 0; index < sorted.length; index += 1) {
      const stop = sorted[index] as Stop;
      if (stop.coordinate !== undefined) {
        grid.insert(stop.coordinate, stopIndex(index));
      }
    }

    return new StopCatalogue(interner, sorted, parents, childLists, boardable, grid, extent);
  }

  /** Number of stops. */
  get count(): number {
    return this.stops.length;
  }

  /** The bounding box of every located stop, or `undefined` when none has one. */
  get boundingBox(): BoundingBox | undefined {
    return this.extent;
  }

  /** The index of a stop id, or `undefined` when the feed has no such stop. */
  indexOf(stopId: string): StopIndex | undefined {
    const index = this.interner.indexOf(stopId);
    return index === undefined ? undefined : stopIndex(index);
  }

  /** The stop id at an index. */
  idAt(index: StopIndex): string {
    return this.interner.idAt(index);
  }

  /** The stop record at an index. */
  stopAt(index: StopIndex): Stop {
    const stop = this.stops[index];
    if (stop === undefined) {
      throw new GeometryError(`no stop at index ${index}`, { index });
    }
    return stop;
  }

  /** The stop's position, or `undefined` when the feed published none. */
  coordinateAt(index: StopIndex): Coordinate | undefined {
    return this.stopAt(index).coordinate;
  }

  /** A display label for the stop. */
  labelAt(index: StopIndex): string {
    return stopLabel(this.stopAt(index));
  }

  /** True when passengers can board at the stop. */
  isBoardable(index: StopIndex): boolean {
    return this.boardable[index] === true;
  }

  /** The stop's parent station, or `undefined` when it has none. */
  parentOf(index: StopIndex): StopIndex | undefined {
    const parent = this.parents[index];
    return parent === undefined || parent < 0 ? undefined : stopIndex(parent);
  }

  /** The stops whose parent is this one, ascending. */
  childrenOf(index: StopIndex): readonly StopIndex[] {
    return this.children[index] ?? [];
  }

  /**
   * The stop plus every other stop sharing its parent station, ascending.
   *
   * This is the set a passenger can move between without leaving the station,
   * and it is what an origin or destination given as a station expands to.
   */
  siblingsOf(index: StopIndex): StopIndex[] {
    const parent = this.parentOf(index);
    if (parent === undefined) {
      const own = this.childrenOf(index);
      return own.length === 0 ? [index] : [index, ...own];
    }
    return [parent, ...this.childrenOf(parent)];
  }

  /**
   * The boardable stops an origin resolves to.
   *
   * Naming a station resolves to its platforms; naming a platform resolves to
   * itself. A passenger asked to depart from "Central" does not care which
   * platform, and a search that picks one arbitrarily will miss journeys.
   */
  boardingPointsOf(index: StopIndex): StopIndex[] {
    const stop = this.stopAt(index);
    if (stop.locationType === LocationType.Station) {
      return this.childrenOf(index).filter((child) => this.isBoardable(child));
    }
    return this.isBoardable(index) ? [index] : [];
  }

  /** Stops within `radiusMetres` of a point, nearest first. */
  nearby(point: Coordinate, radiusMetres: number): GridMatch<StopIndex>[] {
    return this.grid.within(point, radiusMetres);
  }

  /** The `count` nearest stops to a point inside `maxRadiusMetres`. */
  nearest(point: Coordinate, count: number, maxRadiusMetres: number): GridMatch<StopIndex>[] {
    return this.grid.nearest(point, count, maxRadiusMetres);
  }

  /** Every index, ascending. Useful for whole-network sweeps. */
  allIndices(): StopIndex[] {
    return Array.from({ length: this.stops.length }, (_, index) => stopIndex(index));
  }

  /** Every boardable index, ascending. */
  boardableIndices(): StopIndex[] {
    return this.allIndices().filter((index) => this.isBoardable(index));
  }
}
