# GTFS support

Which parts of the specification meridian reads, and how it behaves where the
specification leaves room.

## Tables

| Table                  | Status    | Notes                                                        |
| ---------------------- | --------- | ------------------------------------------------------------ |
| `agency.txt`           | required  | `agency_id` may be omitted for a single agency; it becomes the empty string. |
| `stops.txt`            | required  | All five location types are read. Only `location_type = 0` is routable. |
| `routes.txt`           | required  | Extended route types are folded onto their basic equivalent.  |
| `trips.txt`            | required  | Trips whose calls cannot be resolved are dropped with an error. |
| `stop_times.txt`       | required  | Missing intermediate times are interpolated.                  |
| `calendar.txt`         | optional  | Optional, provided `calendar_dates.txt` is present.           |
| `calendar_dates.txt`   | optional  | May define a service entirely on its own.                     |
| `frequencies.txt`      | optional  | Expanded into concrete runs at network build time.            |
| `transfers.txt`        | optional  | Overrides generated footpaths; may forbid an interchange.     |
| `shapes.txt`           | optional  | Presentational only; affects no routing decision.             |
| `fare_attributes.txt`  | optional  | The original fare model, not Fares v2.                        |
| `fare_rules.txt`       | optional  | Matched by route and by fare zone.                            |
| `pathways.txt`         | optional  | Read, with traversal time and step-free judgement.            |
| `levels.txt`           | optional  | Read and cross-checked against `stops.level_id`.              |
| `feed_info.txt`        | optional  | Its declared range is compared against the real calendar.     |
| Fares v2 tables        | not read  | See "Not supported" below.                                    |
| `translations.txt`     | not read  | meridian carries the feed's own strings verbatim.             |
| `attributions.txt`     | not read  |                                                               |

An absent optional table yields an empty collection rather than a diagnostic. A
feed with no `shapes.txt` is complete, just less detailed.

## Decisions where the specification leaves room

### Times past 24:00:00

Read as written and kept that way. A time of `25:30:00` is 25 hours and 30
minutes after the start of its service day, not 01:30 the next morning, and the
distinction is what makes overnight routing work. See `docs/routing.md`.

Values up to seven days are accepted; beyond that the value is rejected, since
a feed writing `169:00:00` has almost certainly mis-parsed something.

### Interpolating missing stop times

GTFS requires a published time only at a trip's first and last stops and at any
stop flagged as a timepoint. The specification's stated remedy for the rest is
linear interpolation between the surrounding known times, which is what
meridian does — distributing the elapsed time evenly across the intervening
stops.

Interpolating by `shape_dist_traveled` where available would be more faithful
to the road, but the measure is optional, frequently wrong, and mixing two
strategies inside one feed would make results depend on which trips happen to
carry it. Even distribution is uniform and predictable.

A trip with no published time at its first or last stop cannot be anchored and
is dropped with `stop_time.unanchored`.

### A blank `transfers` count on a fare

GTFS encodes "unlimited onward transfers" as an empty cell, which is
indistinguishable from "not stated". The specification resolves the ambiguity
in favour of unlimited and meridian follows it. A naive reading gets this
backwards and quadruples the price of a multi-leg journey.

### Duplicate keys

The **first** occurrence wins, everywhere: a repeated `stop_id`, `route_id`,
`fare_id`, calendar exception, or transfer rule. Keeping the first, rather than
the last, means a feed whose exporter appends corrected rows without removing
the originals produces a stable result across runs *and* a diagnostic pointing
at the duplicate — rather than silently changing behaviour depending on row
order.

### Extended route types

Folded onto the basic type by hundreds block: 100–199 becomes rail, 200–299
bus, 400–499 subway, and so on. Routing only ever needs the coarse mode. An
`route.extended_type` note records the fold; an unrecognised value is an error.

### `shape_dist_traveled`

Its unit is not specified — feeds publish metres, kilometres, miles, and
arbitrary counters — so it cannot be compared against a computed distance.
meridian keeps the feed's measure separately from its own and discards it
entirely if the column is only partially populated or fails to increase.
Interpolating a measure whose unit is unknown would produce numbers that look
authoritative and are not.

### Accessibility filters

Checked strictly. A trip whose `wheelchair_accessible` is *unknown* is excluded
when a query requires accessibility. Returning a journey a wheelchair user
cannot take is a worse failure than returning none.

### Station origins and destinations

A query naming a station expands to its boardable platforms. A passenger asked
to depart from "Central" does not care which platform, and a search that picks
one arbitrarily will miss journeys.

## CSV handling

- A UTF-8 byte order mark is stripped, not rejected.
- CRLF, LF, and lone CR are all accepted; CRLF is consumed as one terminator.
- Quoted fields may contain commas, newlines, and doubled quotes.
- Text following a closing quote is an error by default and appended in lenient
  mode.
- Rows of only whitespace are skipped: exporters routinely leave a trailing
  blank line.
- Cells are trimmed by default. GTFS values are never meaningfully padded, and
  exporters that align columns for readability are common.
- A row whose field count differs from the header's is an error by default;
  `"pad"` and `"skip"` policies are available.
- A duplicated or blank column name in the header is always an error.

## Not supported

- **Fares v2** (`fare_media.txt`, `fare_products.txt`, `fare_leg_rules.txt`,
  `fare_transfer_rules.txt`, `rider_categories.txt`, `areas.txt`,
  `stop_areas.txt`, `networks.txt`, `route_networks.txt`, `timeframes.txt`).
- **GTFS Realtime.** meridian routes on published schedules only.
- **`translations.txt`.** Strings are carried through as the feed wrote them.
- **Flexible services** (`booking_rules.txt`, `location_groups.txt`,
  continuous pickup as a routable behaviour). The `continuous_pickup` and
  `continuous_drop_off` columns are read and retained, but the routing engine
  treats every leg as stop-to-stop.
