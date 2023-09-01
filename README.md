# meridian

A deterministic transit routing engine for GTFS feeds: feed loading and
validation, service calendars, RAPTOR journey search, reachability analysis,
and fare computation.

meridian is a library first and a command line tool second. It has no runtime
dependencies, reads no configuration it was not given, and never consults the
system clock, the host time zone, or the network. The same feed and the same
query always produce the same answer, byte for byte.

- **Runtime:** Node.js 20 or later (tested and shipped on Node 24)
- **Language:** TypeScript 5.7, ES2023 output, ESM only
- **Runtime dependencies:** none

---

## Installing

```bash
npm ci
npm run build
```

`npm ci` installs the pinned development toolchain from `package-lock.json`;
`npm run build` emits ES modules and declaration files into `dist/`.

## Testing

```bash
npm test                  # the full suite
npm run test:coverage     # the suite plus the coverage gate
npm run typecheck         # tsc --noEmit over sources and tests
```

The coverage gate fails the command below 90% of lines, branches, functions,
or statements. The suite is deterministic: no network access, no wall clock, no
dependence on filesystem ordering, and no unexplained skips.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- **verify** — typecheck, the suite with the coverage gate, and a build, on
  Node 20, 22, and 24.
- **determinism** — runs the suite twice and requires byte-identical coverage.
  Determinism is a design constraint here, and a test that depended on ordering
  or on wall-clock time would break this job rather than surface months later.
- **image** — builds the repository image through
  `scripts/build-repo-image.sh`, a wrapper that reproduces the steps the
  repository-image service injects around this Dockerfile, then smoke-tests the
  result. A Dockerfile that only worked standalone would pass a plain
  `docker build` and fail here.

The image job is worth running locally before touching the Dockerfile:

```bash
./scripts/build-repo-image.sh
```

---

## Using the library

The shortest useful path is: read a feed, compile it into a network, plan
against the network, render the result.

```ts
import {
  MemoryFeedSource,
  ServiceDate,
  buildNetwork,
  loadFeed,
  planJourney,
  renderPlan,
} from "meridian";

const source = new MemoryFeedSource({
  "agency.txt": agencyCsv,
  "stops.txt": stopsCsv,
  "routes.txt": routesCsv,
  "trips.txt": tripsCsv,
  "stop_times.txt": stopTimesCsv,
  "calendar.txt": calendarCsv,
});

const { feed, diagnostics } = loadFeed(source);
if (feed === undefined) {
  throw new Error(diagnostics.sorted().map((entry) => entry.message).join("\n"));
}

const { network } = buildNetwork(feed);

const plan = planJourney(network, {
  from: { kind: "stop", stopId: "NORTH" },
  to: { kind: "stop", stopId: "HARBOUR" },
  date: ServiceDate.parse("20230605"),
  departAfter: "07:45:00",
});

console.log(renderPlan(plan));
```

```text
Option 1
07:50 → 09:00  1h 10m, 1 change, 1m walking
  07:50 → 08:02  2 towards Southbank: Northgate → Central Platform B (12m, non-stop)
  08:02 → 08:03  published transfer 1m: Central Platform B → Central Platform A
  08:30 → 09:00  1 towards Harbour: Central Platform A → Harbour (30m, 2 stops)
  fare: 2.50 GBP
```

### Reading a feed from disk

```ts
import { DirectoryFeedSource, loadFeed } from "meridian";

const { feed } = loadFeed(DirectoryFeedSource.open("./gtfs"));
```

`DirectoryFeedSource` is the only part of the library that touches the
filesystem. Everything below it takes a `FeedSource`, so the parser, the
validator, and the routing engine stay pure and synchronous.

### Validating a feed

```ts
import { formatReport, validateFeed } from "meridian";

const report = validateFeed(feed, {
  referenceDate: "20230605",
  severities: { "cover.unserved_stop": "off" },
});

console.log(formatReport(report));
console.log(`${report.errors} error(s)`);
```

Every check has an id, a category, and a default severity, all declared in one
catalogue. A caller may raise, lower, or suppress any of them — "a stop with no
name" is fatal to one consumer and cosmetic to another.

### Searching a departure window

```ts
import { planProfile } from "meridian";

const profile = planProfile(
  network,
  { from, to, date, departAfter: "07:30:00" },
  { windowSeconds: 2 * 3600 },
);
```

A profile search returns the departures worth taking across a window, rather
than the single best journey from one moment. Its results are Pareto-optimal in
departure time as well as arrival time, boardings, and walking, so a later
departure that arrives just as soon is kept rather than discarded.

### Reachability

```ts
import { computeReach, rasterise, renderGrid } from "meridian";

const reach = computeReach(network, {
  from: { kind: "stop", stopId: "CENTRAL_A" },
  date: ServiceDate.parse("20230605"),
  departAfter: "08:00:00",
  budgetSeconds: 30 * 60,
});

console.log(renderGrid(rasterise(reach), [600, 1200, 1800]));
```

---

## Command line

```bash
meridian describe --feed ./gtfs
meridian validate --feed ./gtfs --reference-date 20230605
meridian plan     --feed ./gtfs --from NORTH --to HARBOUR --date 20230605 --time 07:45:00
meridian reach    --feed ./gtfs --from CENTRAL_A --date 20230605 --time 08:00:00 --budget 1800
meridian rules
```

Every command accepts `--json` for machine-readable output. Exit codes are part
of the contract:

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | The command succeeded.                                       |
| `1`  | The command ran but its subject failed: an invalid feed, no journey found. |
| `2`  | The command line was not understood.                         |
| `3`  | The feed could not be read at all.                           |

---

## Architecture

Each package depends only on those above it.

| Package          | Responsibility                                                        |
| ---------------- | --------------------------------------------------------------------- |
| `src/errors.ts`  | The error hierarchy and its stable machine-readable codes.             |
| `src/time`       | Calendar dates, GTFS times past 24:00, durations, intervals, UTC offsets. |
| `src/geo`        | Coordinates, distance, bounding boxes, a spatial hash, polylines.      |
| `src/csv`        | An RFC 4180 tokeniser, header-keyed records, typed coercion, positional diagnostics. |
| `src/feed`       | One module per GTFS table, plus the loader that assembles a `GtfsFeed`. |
| `src/calendar`   | Which services run on which dates, and which service days a query must scan. |
| `src/validate`   | The rule catalogue and the referential, temporal, and geometric checks. |
| `src/model`      | The compiled network: dense indices, route patterns, timetables, footpaths. |
| `src/routing`    | Query normalisation, the RAPTOR round loop, profile search, journey reconstruction. |
| `src/journey`    | Journeys as a caller sees them: named legs, metrics, deterministic ordering. |
| `src/fares`      | Fare rule matching and journey pricing.                                |
| `src/isochrone`  | One-to-many reachability and its map projections.                      |
| `src/report`     | Aligned text tables, human-readable journeys, stable-key JSON.          |
| `src/planner.ts` | The high-level `planJourney` and `planProfile` entry points.            |
| `src/cli`        | Argument parsing and the commands, as pure functions.                   |

`docs/architecture.md` explains the boundaries and why they fall where they do.
`docs/routing.md` covers the RAPTOR implementation, including how times past
midnight and overtaking vehicles are handled.

---

## Determinism

Reproducibility is a design constraint, not a nice-to-have. Concretely:

- No module reads `Date.now`, the host time zone, or any environment variable.
- Feed expiry is judged against a date the caller supplies, never "today".
- Stops are indexed in sorted id order, patterns in sorted key order, and trips
  by departure with an id tie-break, so two networks built from feeds whose
  rows were shuffled produce identical indices.
- Every comparator used for output is a *total* order; nothing relies on a
  sort's tie-breaking behaviour.
- JSON is emitted with keys in ascending order, written explicitly rather than
  by serialising an object and hoping.
- No IANA time zone database is bundled. A caller who needs absolute instants
  supplies the offset rule explicitly, so a result cannot change because a
  tzdata release did.

---

## Known limitations

- **Fares v2 is not supported.** meridian implements the original
  `fare_attributes.txt` / `fare_rules.txt` model, which is what the great
  majority of published feeds carry.
- **No street network.** Walking legs are straight-line distance scaled by a
  documented straightness factor. Without a street graph there is no honest way
  to model a real walking route, and a stated constant is easier to reason
  about than a false precision.
- **No time zone database.** See "Determinism" above. Agency time zone names
  are read and carried through verbatim but never resolved to an offset.
- **Frequency-based trips are expanded at build time.** For `exact_times = 1`
  the generated times are the published ones. For `exact_times = 0` only the
  headway is promised, so the modelled departures are a best case; the expected
  wait is reported separately on each leg and in the journey metrics.
- **Bounding boxes do not wrap the antimeridian.** A feed spanning it is
  reported by the `geo.antimeridian` rule rather than silently mishandled.
- **Footpaths are transitively closed within a bound**, not shortest-path
  complete. The bound keeps chains to a few hops; a walk longer than
  `maxTransferSeconds` is not synthesised.

---

## Licence and ownership

Copyright (c) 2023 Med Hassen. All rights reserved. See `LICENSE`.

This is proprietary software. No licence to use, copy, modify, or distribute is
granted.
