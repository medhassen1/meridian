# Changelog

All notable changes to meridian are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows semantic versioning.

## [0.6.0] — 2023-08-25

### Added

- `meridian rules` prints the full validation rule catalogue, in text or JSON.
- `planProfile` and the `--window` flag on `meridian plan` search a departure
  window rather than a single moment.
- Reachability results can be rasterised onto a grid and rendered as ASCII or
  exported as GeoJSON points.
- `diversify` reduces an over-large result set by spread rather than by
  truncation.

### Changed

- Profile searches now compare journeys on departure time as well as arrival,
  boardings, and walking. Previously every departure but the first was
  dominated and a profile collapsed to a single row.
- Reconstructed journeys report the latest departure that still catches the
  first vehicle, instead of the query time.

### Fixed

- Transitive closure of the footpath graph no longer reinstates an interchange
  that `transfers.txt` forbids, by routing it through a third stop.
- The CSV tokeniser keeps a trailing empty field on the final row of a file
  with no terminating newline.
- Outlier stop detection measures against a component-wise median position
  rather than a centroid, which a single distant stop could drag far enough to
  hide itself.

## [0.5.0] — 2023-08-06

### Added

- Fare computation over the original GTFS fare model, including transfer
  allowances and transfer windows.
- `pathways.txt` and `levels.txt` support, with traversal time estimation and
  step-free judgement.
- One-to-many reachability search (`computeReach`).

### Changed

- The timetable's trip filter takes a trip index rather than a service id, so a
  caller can combine service activity with accessibility and mode restrictions
  in a single pass.

## [0.4.0] — 2023-07-16

### Added

- Range RAPTOR profile search.
- Accessibility and mode filters on journey queries.
- Stable-key JSON rendering for plans, itineraries, and reachability results.

### Fixed

- Patterns whose trips overtake one another now fall back to a linear trip
  search instead of relying on an unsound binary search.

## [0.3.0] — 2023-06-24

### Added

- The RAPTOR round loop, footpath relaxation, and journey reconstruction.
- The compiled network model: dense stop indices, route patterns, flat
  timetables, and the transfer graph.
- Frequency-based trips are expanded into concrete runs at build time.

## [0.2.0] — 2023-05-27

### Added

- The validation rule catalogue and the referential, temporal, and geometric
  checks.
- Service calendars, including the mapping from a query time to the service
  days that could contain it.

## [0.1.0] — 2023-05-06

### Added

- The CSV reading layer: an RFC 4180 tokeniser, header-keyed records, typed
  field coercion, and positional diagnostics.
- One module per GTFS table, plus the loader that assembles a feed.
- Time, geometry, and error primitives.
