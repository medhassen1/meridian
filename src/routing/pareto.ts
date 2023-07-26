/**
 * Multi-criteria comparison.
 *
 * A passenger does not want the single fastest journey. They want the small
 * set of journeys where each is better than the others at *something*: this
 * one arrives soonest, that one has no change, the third avoids a twenty
 * minute walk. That set is the Pareto frontier, and computing it well is
 * mostly a matter of choosing criteria that are genuinely incomparable and
 * refusing to invent a weighting between them.
 *
 * meridian compares on arrival time, boarding count, and walking time.
 * Departure time is deliberately excluded from dominance and used only as a
 * tie-break: within a single earliest-arrival search every journey shares a
 * departure window, and treating a two-minute-later departure as an advantage
 * floods the frontier with near-identical results.
 */

/** The criteria a journey is compared on. */
export interface Criteria {
  /** Absolute arrival time; lower is better. */
  readonly arrival: number;
  /** Number of vehicle boardings; lower is better. */
  readonly boardings: number;
  /** Seconds spent walking; lower is better. */
  readonly walkSeconds: number;
}

/**
 * True when `a` is at least as good as `b` on every criterion.
 *
 * Weak dominance, so identical journeys dominate each other; callers filtering
 * a frontier must therefore also guard against comparing an entry with itself.
 */
export function dominates(a: Criteria, b: Criteria): boolean {
  return a.arrival <= b.arrival && a.boardings <= b.boardings && a.walkSeconds <= b.walkSeconds;
}

/** True when `a` is at least as good everywhere and strictly better somewhere. */
export function strictlyDominates(a: Criteria, b: Criteria): boolean {
  return (
    dominates(a, b) &&
    (a.arrival < b.arrival || a.boardings < b.boardings || a.walkSeconds < b.walkSeconds)
  );
}

/**
 * Criteria for a profile search, where departure time also matters.
 *
 * In a profile, leaving *later* for the same arrival is strictly better: the
 * passenger gets the same journey and twenty more minutes beforehand. That
 * makes departure a maximising criterion, the only one in the library, and it
 * is why a profile cannot reuse the single-departure comparison — under that
 * comparison every departure but the first is dominated, and the profile
 * collapses to one row.
 */
export interface ProfileCriteria extends Criteria {
  /** Absolute departure time; *higher* is better. */
  readonly departure: number;
}

/** True when `a` is at least as good as `b` on every profile criterion. */
export function profileDominates(a: ProfileCriteria, b: ProfileCriteria): boolean {
  return a.departure >= b.departure && dominates(a, b);
}

/** True when `a` weakly dominates `b` and is strictly better somewhere. */
export function profileStrictlyDominates(a: ProfileCriteria, b: ProfileCriteria): boolean {
  return (
    profileDominates(a, b) &&
    (a.departure > b.departure ||
      a.arrival < b.arrival ||
      a.boardings < b.boardings ||
      a.walkSeconds < b.walkSeconds)
  );
}

/**
 * Reduces a set to its Pareto frontier.
 *
 * Entries that no other entry strictly dominates are kept, in the order they
 * were supplied. Duplicates — entries that dominate each other exactly — are
 * collapsed to the first occurrence, so the result never contains two entries
 * a passenger would call the same.
 */
export function paretoFrontier<T>(
  entries: readonly T[],
  criteriaOf: (entry: T) => Criteria,
): T[] {
  return frontierOf(entries, criteriaOf, dominates, strictlyDominates);
}

/** The Pareto frontier under {@link ProfileCriteria}. */
export function profileFrontier<T>(
  entries: readonly T[],
  criteriaOf: (entry: T) => ProfileCriteria,
): T[] {
  return frontierOf(entries, criteriaOf, profileDominates, profileStrictlyDominates);
}

/** Shared frontier computation, parameterised by its dominance relation. */
function frontierOf<T, C>(
  entries: readonly T[],
  criteriaOf: (entry: T) => C,
  weaklyDominates: (a: C, b: C) => boolean,
  strictly: (a: C, b: C) => boolean,
): T[] {
  const criteria = entries.map(criteriaOf);
  const frontier: T[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const candidate = criteria[index] as C;
    let dominated = false;

    for (let other = 0; other < entries.length; other += 1) {
      if (other === index) {
        continue;
      }
      const rival = criteria[other] as C;
      if (strictly(rival, candidate)) {
        dominated = true;
        break;
      }
      // Exact ties: the earlier entry wins, so only later ones are dropped.
      if (
        other < index &&
        weaklyDominates(rival, candidate) &&
        weaklyDominates(candidate, rival)
      ) {
        dominated = true;
        break;
      }
    }

    if (!dominated) {
      frontier.push(entries[index] as T);
    }
  }
  return frontier;
}

/**
 * Total ordering for presentation: soonest arrival, then fewest boardings,
 * then least walking.
 *
 * Distinct from dominance. Dominance decides what is worth showing; this
 * decides the order it is shown in, and it must be total so that output is
 * byte-for-byte reproducible.
 */
export function compareCriteria(a: Criteria, b: Criteria): number {
  return (
    a.arrival - b.arrival || a.boardings - b.boardings || a.walkSeconds - b.walkSeconds
  );
}

/**
 * Keeps at most `limit` entries, preferring those that differ most from what
 * is already kept.
 *
 * A frontier of thirty journeys is not more useful than a frontier of five;
 * it is less useful. Rather than truncating — which would drop every
 * low-transfer option in favour of a run of near-identical fast ones — this
 * keeps the best entry, then repeatedly adds whichever remaining entry is
 * furthest from the ones already chosen.
 */
export function diversify<T>(
  entries: readonly T[],
  criteriaOf: (entry: T) => Criteria,
  limit: number,
): T[] {
  if (limit <= 0) {
    return [];
  }
  if (entries.length <= limit) {
    return entries.slice();
  }

  const ordered = entries
    .map((entry, index) => ({ entry, index, criteria: criteriaOf(entry) }))
    .sort((a, b) => compareCriteria(a.criteria, b.criteria) || a.index - b.index);

  const chosen = [ordered[0] as (typeof ordered)[number]];
  const remaining = ordered.slice(1);

  while (chosen.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index] as (typeof ordered)[number];
      let nearest = Number.POSITIVE_INFINITY;
      for (const kept of chosen) {
        const distance = criteriaDistance(candidate.criteria, kept.criteria);
        if (distance < nearest) {
          nearest = distance;
        }
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = index;
      }
    }

    chosen.push(remaining[bestIndex] as (typeof ordered)[number]);
    remaining.splice(bestIndex, 1);
  }

  return chosen
    .sort((a, b) => compareCriteria(a.criteria, b.criteria) || a.index - b.index)
    .map((item) => item.entry);
}

/**
 * A scale-free distance between two criteria vectors.
 *
 * Each axis is normalised by a characteristic magnitude — five minutes of
 * time, one boarding — so that a difference of one change counts for about as
 * much as a difference of five minutes, rather than being swamped by the raw
 * second counts.
 */
function criteriaDistance(a: Criteria, b: Criteria): number {
  const arrival = Math.abs(a.arrival - b.arrival) / 300;
  const boardings = Math.abs(a.boardings - b.boardings);
  const walking = Math.abs(a.walkSeconds - b.walkSeconds) / 300;
  return arrival + boardings + walking;
}
