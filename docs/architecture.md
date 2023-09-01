# Architecture

meridian is built as a stack of packages, each depending only on those above
it. The dependency direction is enforced by convention rather than by tooling,
but it is uniform: nothing in `src/time` imports from `src/feed`, nothing in
`src/feed` imports from `src/routing`, and no package imports from `src/cli`.

```
errors ── time ── geo ── csv ── feed ── calendar ── validate
                                  │        │
                                  └── model ┘
                                        │
                                     routing
                                        │
                              journey ─ fares ─ isochrone
                                        │
                                     report
                                        │
                                planner ── cli
```

## The three representations of a feed

The most important structural decision in the library is that a GTFS feed
exists in three distinct forms, and that the boundaries between them are hard.

### 1. Text — `src/csv`

Bytes, rows, and cells. This layer knows about quoting, line endings, byte
order marks, and source positions. It knows nothing about transit.

Its output is a `TableRow`: a header-keyed record that distinguishes an absent
*column* from an empty *cell*, because GTFS gives the two different meanings.
An absent `stop_times.timepoint` column means every stop is a timepoint; a
blank cell means that particular stop is not.

### 2. Entities — `src/feed`

The faithful reading of the tables. Each GTFS table has one module, which
declares its columns, its enumerations, and the rules for turning a row into an
entity. Times are interpolated and self-contradictory rows are dropped, but
nothing is derived: a `GtfsFeed` is what the agency wrote, cleaned up.

This is the form the validator inspects. Keeping it separate from the compiled
network is what lets a validation report say "your feed says X" rather than
"the thing we built from your feed says X".

### 3. The compiled network — `src/model`

What routing actually runs on. Stops become dense integer indices, trips are
grouped into *route patterns* by their actual call sequence, each pattern's
trips become a flat `Int32Array` time matrix, and walking connections become an
adjacency list.

Building this is the expensive step and it happens once. Running a query
against it is cheap and allocates almost nothing.

## Why patterns, not routes

RAPTOR is often described as scanning routes. It does not, despite the name in
the original paper. It scans sequences of stops that share an ordering, so that
"board the first trip departing after time T" is a single position along one
array.

A GTFS route rarely has that property. The same route number runs short
workings, express variants, and a different sequence at weekends. So trips are
grouped by their actual call sequence — including boarding permissions, since a
trip that only sets down at a stop offers a different set of journeys from one
that also picks up there.

`src/model/route-pattern.ts` builds those groups. Patterns are keyed on stop
*indices* rather than ids, which keeps the key short for a table with millions
of rows and stable because the catalogue assigns indices in sorted id order.

## Why a `FeedSource`

The loader reads through an interface with three methods: `has`, `read`, and
`tableNames`. That is the only seam between meridian and the outside world, and
it buys three things.

The whole parse-and-validate pipeline stays pure and synchronous — no promises,
no I/O errors interleaved with data errors. Tests build feeds inline as string
literals, so the input to a failing assertion is visible in the same screen as
the assertion. And the choice of container — a directory, a zip, an HTTP
response already in memory — belongs to the caller.

`DirectoryFeedSource` is the only module that imports `node:fs`.

## Diagnostics, not exceptions

A feed is an artefact produced by someone else's software. The useful response
to a broken one is a full account of what is wrong, not the first exception.

So the loader and the validator append to a `DiagnosticSink` and keep going.
Each diagnostic carries a severity, a rule id, a message, and a source position
rendered as `stops.txt:412:3`. The sink caps itself: a feed with a
systematically broken column can produce one diagnostic per row for a million
rows, and collecting them all turns a validation run into an out-of-memory
crash.

Exceptions are reserved for two cases: a caller error (an unknown stop id in a
query, an enumeration declared with no members) and an internal inconsistency
that should be impossible (a pattern referencing a trip that does not exist).

## The rule catalogue

Every validation check is declared in `src/validate/rules.ts` with an id, a
category, a description, and a default severity. Two things follow.

A caller can raise or lower any rule without patching the validator. And the
full catalogue can be printed — `meridian rules` — which is the only practical
way to document what a validator actually does.

Validators themselves are plain functions over a context. They never decide
severity; they call `report.emit(ruleId, message, position)` and the reporter
applies the caller's configuration uniformly, including a per-rule firing limit
so that one broken column cannot drown out every other finding.

## Absolute time

Every routing computation runs on one clock: seconds from midnight of the query
date. It may be negative and it may exceed 86,400.

This is the single most important invariant in the routing layer, and
`docs/routing.md` explains why. In short: a GTFS trip's times are relative to
its own service date, a trip running past midnight carries times beyond
24:00:00 on the *previous* date, and comparing seconds measured from different
origins produces wrong answers that look plausible.

`DayScanner` owns the conversion. It enumerates the service days a query must
read, resolves service activity once per day, and answers every timetable
lookup in absolute seconds.

## Determinism as a constraint

Reproducibility shapes several decisions that would otherwise go the other way.

- **No bundled time zone database.** It would make results depend on the tzdata
  release installed at build time, which is exactly the kind of hidden,
  drifting input that makes a routing result irreproducible six months later.
- **Sorted indexing.** Stops by id, patterns by key, trips by departure with an
  id tie-break. Two networks built from feeds whose rows were shuffled produce
  identical indices and therefore identical results.
- **Total comparators.** Every ordering used for output distinguishes every
  pair, falling back to a structural key when the numeric criteria tie. Nothing
  relies on a sort's internal behaviour.
- **Hand-written JSON.** Objects are built with keys in ascending order rather
  than serialised and hoped over, which makes the wire format a stated property
  of one module instead of an accident of object construction.
- **No clock reads.** Feed expiry is judged against a date the caller supplies.

## Testing strategy

One synthetic feed — Rivertown, in `test/support/fixtures.ts` — is exercised by
most of the suite. It is small but deliberately complete: a station with two
platforms, a published transfer that overrides a generated footpath, a tram
running past midnight, a weekend service plus a calendar exception that swaps
the two on one date, a headway-based route, fare zones with a transfer
allowance, an unserved stop, and a route with no trips.

Unit suites cover each module's own edge cases against inline inputs; the
integration suite checks that the whole pipeline produces the right journeys
against Rivertown. Every rendering is asserted for stability across repeated
calls, because a report that differs between runs is a report that cannot be
diffed.
