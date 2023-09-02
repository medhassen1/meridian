# The routing engine

meridian implements RAPTOR — Round-bAsed Public Transit Optimized Router,
Delling, Pajor and Werneck, 2012 — with range search for profile queries.

## Why RAPTOR

RAPTOR computes earliest arrivals by *rounds* rather than by relaxing a
priority queue. Round `k` finds the earliest arrival at every stop using at
most `k` boardings.

That structure is what makes it a good fit for a passenger-facing planner. The
number of transfers becomes a property of the answer rather than a cost to be
traded against time through some invented weighting, so "fastest" and "fewest
changes" both fall out of a single run. It also means no priority queue, no
heap operations in the inner loop, and label arrays that can be typed arrays
reused between rounds.

## The round loop

Each round does two things.

**Scan patterns.** Every pattern reachable from a stop improved in the previous
round is ridden forward from the earliest position at which such a stop appears
— boarding a pattern later than necessary can never produce a better arrival.
Along the way the scan records arrivals where alighting is permitted, and
upgrades to an earlier trip wherever one can be caught.

The upgrade check is what keeps the scan linear. Having boarded a trip, the
scan only re-queries the timetable at a stop where the previous round's label
would have allowed catching something earlier; everywhere else it simply reads
the trip it is already on.

**Relax footpaths.** The stops just improved are extended along their outgoing
walking connections, so the next round can board at a neighbouring stop rather
than only at the one the vehicle reached.

When a round improves nothing, no later round can either, and the search stops.

## Absolute time

This is the part of GTFS handling most often got wrong, so it is worth stating
precisely.

A trip's published times are relative to its own *service date*. A trip
departing at 23:50 and arriving at 00:40 is anchored to the earlier date and
written with times of `23:50:00` and `24:40:00` — both on the same anchor. A
search on the following morning that only looked at that morning's services
will not find it, and will confidently report that no service exists.

meridian resolves this with a single absolute clock, measured in seconds from
midnight of the *query* date:

- a trip anchored `k` days earlier contributes its published time minus
  `k × 86400`;
- a trip anchored `k` days later contributes its published time plus the same.

Absolute times may therefore be negative (a vehicle boarded before midnight on
the previous day) or exceed 86,400 (an arrival after midnight on the next).
Both are ordinary and are rendered with a day marker: `23:50 (-1d)`,
`01:00 (+1d)`.

`DayScanner` enumerates the anchors worth considering. The number of days to
look back is measured from the feed itself — the longest past-midnight overhang
any trip reaches — so a network with no overnight service pays for exactly one
service day per query. Anchors on which no service at all runs are dropped at
construction, so a weekday-only network costs nothing to scan on a Sunday.

## Overtaking

RAPTOR's trip lookup is a binary search, and that is only sound when a
pattern's trips are ordered consistently at every stop: no vehicle overtakes
another.

Real feeds do contain overtaking, usually where an express and a stopping
service share a pattern. `PatternTimetable` checks for it once at build time —
one pass over the time matrix — and records the answer. Patterns that are
totally ordered use the binary search; the rest fall back to a linear scan that
takes the earliest qualifying departure rather than the first encountered.

The build emits a `build.overtaking_pattern` note for each affected pattern, so
the cost is visible rather than mysterious.

## Footpaths

Two sources feed the walking graph. The agency's own `transfers.txt` is
authoritative and may forbid an interchange outright. Everything else is
generated from geometry, because no feed publishes a transfer for every pair of
stops that happen to be a short walk apart.

Published rules override generated ones, and the more specific rule wins:
trip-level beats route-level beats stop-level.

RAPTOR assumes the footpath relation is **transitively closed**. If A→B and
B→C are footpaths, A→C must be one too, or the algorithm can miss a journey
whose only viable interchange chains two short walks. meridian closes the
relation at build time, bounded by `maxTransferSeconds` so the closure stays
finite and small. Prohibited pairs are excluded throughout the closure — a
forbidden interchange must not be reinstated by routing it through a third
stop, since that is precisely the walk the prohibition exists to prevent.

Within a round, a walk may not follow another walk. Chaining them would let the
search cross the city on foot in a single relaxation, and it is the reason the
closure exists at build time instead.

## Transfer slack

A passenger who arrived by vehicle or on foot needs time to reach the next
one. A passenger who is starting their journey does not.

The engine applies `minTransferSeconds` at boarding time, and only when the
previous leg was not the access leg. Applying it during footpath relaxation
instead would charge a passenger who merely passes through a stop.

## Departure tightening

RAPTOR seeds round zero at the query's departure time, so a reconstructed
journey nominally starts then — even when the first vehicle does not leave for
another twenty minutes. Reporting that as the departure time tells a passenger
to stand at a stop for twenty minutes for no reason.

Reconstruction therefore walks backwards from the first ride and re-times the
access and transfer legs to end exactly when it departs. The reported departure
is the latest moment the passenger can set out and still catch it.

## Profile search

A single earliest-arrival query answers "if I leave now, when do I arrive". A
passenger planning a trip wants the timetable.

Range RAPTOR runs the search from each candidate departure time in *descending*
order, so later departures are computed first and their results prune the
earlier ones. Candidate times come from the network itself — the only
departures worth starting at are the ones a vehicle actually leaves an origin
at — so a two-hour window on an hourly route costs two searches, not a hundred
and twenty.

Profile results are Pareto-optimal on four criteria, and departure time is the
only *maximising* one in the library: leaving later for the same arrival is
strictly better, because the passenger gets the same journey and twenty more
minutes beforehand. Using the single-departure comparison here would dominate
every departure but the first and collapse the profile to one row.

## Multi-criteria results

Outside a profile, journeys are compared on arrival time, boarding count, and
walking time. Departure time is deliberately excluded from dominance and used
only as a tie-break: within a single earliest-arrival search every journey
shares a departure window, and treating a two-minute-later departure as an
advantage floods the frontier with near-identical results.

Where a frontier is still too large to be useful, `diversify` keeps the best
entry and then repeatedly adds whichever remaining entry is furthest from those
already chosen, measured on a scale-free distance where one change counts for
about as much as five minutes. Plain truncation would drop every low-transfer
option in favour of a run of near-identical fast ones.

## Frequency-based trips

`frequencies.txt` publishes a trip once and says it repeats every N seconds.
meridian expands those into concrete runs at build time rather than carrying
the indirection into the query path, where every trip lookup would need a
branch for a feature a minority of feeds use.

The expansion is faithful for `exact_times = 1`, where the generated times are
the published ones. For `exact_times = 0` only the headway is promised, so a
rider does not actually get the modelled departure; the expected wait — half a
headway — is recorded on the leg and surfaced in the journey metrics, so a
caller can report the arrival as a best case.

## Complexity

Let `S` be stops, `P` patterns, `T` trips, `F` footpaths, and `K` rounds.

- One round scans each pattern at most once and reads each of its stops once,
  giving `O(Σ|pattern|)` per round, plus `O(log T)` per trip lookup on an
  ordered pattern.
- Footpath relaxation is `O(F)` per round.
- The whole search is `O(K · (Σ|pattern| + F))` with a `log T` factor on
  lookups, and allocates only the label arrays, which are sized once per query.
- A profile search multiplies this by the number of candidate departures, which
  is bounded by `maxDepartures`.
