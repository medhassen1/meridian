/**
 * Reading a feed from a directory on disk.
 *
 * This is the only module in the library that touches the filesystem, and it
 * is deliberately at the edge: everything below it takes a {@link FeedSource},
 * so the parser, validator, and routing engine stay pure and synchronous, and
 * a test can build a feed from string literals without a temporary directory.
 *
 * Table names are matched case-insensitively, because feeds exported on
 * Windows routinely carry `Stops.txt`, and a planner that refuses one for that
 * reason is not useful to anyone.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MeridianError } from "../errors.js";
import type { FeedSource } from "./source.js";

/**
 * A feed backed by a directory of `.txt` files.
 *
 * Files are read lazily and cached, so a validator that only needs
 * `stops.txt` does not pay to read a 400 MB `stop_times.txt`.
 */
export class DirectoryFeedSource implements FeedSource {
  private readonly directory: string;
  private readonly pathByLowerName: ReadonlyMap<string, string>;
  private readonly cache = new Map<string, string>();

  private constructor(directory: string, pathByLowerName: ReadonlyMap<string, string>) {
    this.directory = directory;
    this.pathByLowerName = pathByLowerName;
  }

  /**
   * Opens a directory as a feed source.
   *
   * @throws {MeridianError} if the path does not exist or is not a directory.
   */
  static open(directory: string): DirectoryFeedSource {
    let stats;
    try {
      stats = statSync(directory);
    } catch {
      throw new MeridianError("FEED_MISSING_TABLE", `cannot read feed directory "${directory}"`, {
        directory,
      });
    }
    if (!stats.isDirectory()) {
      throw new MeridianError("FEED_MISSING_TABLE", `"${directory}" is not a directory`, {
        directory,
      });
    }

    const pathByLowerName = new Map<string, string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) {
        continue;
      }
      const lower = entry.name.toLowerCase();
      // A directory containing both `Stops.txt` and `stops.txt` is ambiguous;
      // the first in readdir order wins and the other is ignored, which at
      // least keeps the result stable within one filesystem.
      if (!pathByLowerName.has(lower)) {
        pathByLowerName.set(lower, join(directory, entry.name));
      }
    }

    return new DirectoryFeedSource(directory, pathByLowerName);
  }

  /** The directory this source reads from. */
  get path(): string {
    return this.directory;
  }

  has(table: string): boolean {
    return this.pathByLowerName.has(table.toLowerCase());
  }

  read(table: string): string | undefined {
    const lower = table.toLowerCase();
    const cached = this.cache.get(lower);
    if (cached !== undefined) {
      return cached;
    }
    const path = this.pathByLowerName.get(lower);
    if (path === undefined) {
      return undefined;
    }
    const contents = readFileSync(path, "utf8");
    this.cache.set(lower, contents);
    return contents;
  }

  /** Table names as they appear on disk, in ascending order. */
  tableNames(): readonly string[] {
    return Array.from(this.pathByLowerName.keys()).sort();
  }

  /** Discards cached file contents, so a later read sees changes on disk. */
  invalidate(): void {
    this.cache.clear();
  }
}
