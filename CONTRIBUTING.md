# Contributing

## Getting set up

```bash
npm ci
npm run typecheck
npm test
```

Node 20 or later. There are no runtime dependencies; the development toolchain
is pinned exactly in `package-lock.json`.

## Before opening a change

```bash
npm run typecheck        # strict tsc over sources and tests
npm run test:coverage    # the suite plus the 90% gate
npm run build            # emits dist/
```

All three must pass. The coverage gate is not advisory: it fails the command
below 90% of lines, branches, functions, or statements.

## House rules

**Determinism is a hard constraint.** Do not read `Date.now`, the host time
zone, the environment, or the filesystem outside `src/feed/directory.ts`. Do
not introduce a runtime dependency. If a computation needs "now", take it as a
parameter.

**Every comparator used for output must be a total order.** If two entries can
compare equal, add a structural tie-break. Output that depends on a sort's
internal behaviour cannot be diffed between runs.

**Feed problems are diagnostics, not exceptions.** Append to the sink and keep
going. Throw only for a caller error or for an internal inconsistency that
should be impossible.

**New checks go in the catalogue.** Add the rule to
`src/validate/rules.ts` with an id, category, description, and default
severity, then emit it through `report.emit`. Never call the sink directly from
a validator, and never decide severity at the point of use.

**Public API changes need a barrel export.** Each package's `index.ts` lists
its exports explicitly rather than re-exporting everything, so that adding a
symbol is a deliberate act.

## Testing

- Tests execute behaviour; they do not inspect source text.
- No network access, no wall-clock dependence, no reliance on filesystem
  ordering. Temporary files go in an isolated temporary directory.
- Randomised input needs an explicit seed.
- A skipped or expected-failure test needs a comment explaining why.
- Prefer the Rivertown fixture in `test/support/fixtures.ts` over a bespoke
  feed. If your case needs something Rivertown does not have, consider adding
  it there — but only if it is a case the engine genuinely has to handle, since
  every addition costs every other test some clarity.
- Assert that renderings are stable across repeated calls.

## Commit messages

Conventional Commits, in the imperative, describing the completed change:

```text
feat(routing): add range search over a departure window
fix(model): keep forbidden transfers out of the transitive closure
test(feed): cover interpolation with a single unanchored stop
docs(architecture): explain why patterns replace routes
```

## Code style

Follow the surrounding code. In particular:

- Comments explain *why*, not *what*. A comment restating the line below it is
  worse than no comment.
- Public API needs a doc comment covering what it does, what it throws, and any
  decision a caller could reasonably disagree with.
- `strict` TypeScript with `noUncheckedIndexedAccess`. Prefer an explicit
  `as never` at a proven-safe index over loosening the compiler.
