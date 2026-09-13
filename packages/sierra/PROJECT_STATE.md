# Sierra — Project State

_Verified 2026-09-03 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up Sierra cold. Read `../../CLAUDE.md`
> for repo-wide vocabulary, then `CLAUDE.md` here for the layout and the traps —
> neither is restated below.

---

## What it is

`@frontierjs/sierra` v0.1.3 — the UI meta-framework. A file tree becomes a route
table, a Vite build runs the Mesa compiler over it, `createResource` is how a
screen talks to Junction, and three build targets come out of one config: the
SPA, `static` (prerendered pages with islands) and `widget` (one self-contained
IIFE per embed).

Realm: **UI meta**. It sits above Junction and Litestone and may be imported by
neither (Invariant 1) — the schema reaches it as generated JSON Schema, never as
an import.

## Verified state

| | |
|---|---|
| Tests | **1146 pass, 0 fail**, 60 files (`bun run test`, vitest, 7.2s) — verified |
| Static safety | **5/5 pass** (`bun run test:safety`) — a real Litestone client, a gated read that fails the build end to end and an acknowledged route that publishes deliberately — verified |
| Widget drive | **25/25 assertions pass** (`bun run test:widgets`) — the fixture built, both servers up, Chrome cross-origin against the server the surface deploys with — verified |
| Typecheck | **clean, 0 errors, no baseline** (`bun run typecheck`) — verified; sierra is absent from `scripts/typecheck-baselines.json`, which means 0 |
| Registry | published `0.1.3`, the same version the tree carries (`npm view @frontierjs/sierra version`) — verified |

Reproduce, from this directory:
`bun run test && bun run test:safety && bun run test:widgets && bun run typecheck`.
The widget drive needs Chrome on PATH or `$FJS_CHROME`; the other three need
nothing. None of the three is in the others — `test` does not run either drive.

What the suite cannot reach is the app-shaped half: the SPA, the prerender and
the resource layer are proven by `example`'s browser drives (`verify`,
`verify:build`, `verify:site`, `verify:widget`) and by `basecamp`'s. The rows in
`../../CLAUDE.md` § *Which drive proves a change* are the map; `fli proves` reads
them off a diff.

## What is NOT built

- **A schema-driven table and filter bar are built now**: `resource.columns()`
  / `.filters()`, `display/Cell.mesa`, `display/FilterBar.mesa` and a
  registered display — `columnList` ranks them. Sortability (`FJS-553`) and
  filterability (`FJS-554`) reach the client through `x-sortable` and the
  filter equivalent, both closed. What is left is a detail-view generator,
  which nothing here builds yet.
- **A generated form offers an editable box for a sealed column** (`FJS-628`,
  with `ui`) — `@immutable` under a `@seals` move is frozen at the seal and
  nothing on this side reads it. *Since closed*: the seal reaches a form
  through `resource.sealedFields`.
- **Value sets have two axes held out of `FJS-D120`**: a per-caller ORDER
  (`FJS-D121`, unruled) and a DEPENDENT set, where one field's value narrows
  another's list — ruled `FJS-D122` and built (`FJS-953`). This package's half
  is `options()`: it narrows by the controlling value off the draft record and
  answers EMPTY with `awaiting` where there is none. What a form does with a
  value the change made illegal was `FJS-D225`, now ruled and built.
- `FJS-456` (a prerendered site's sitemap omitting dynamic pages), `FJS-520`
  (the gate scale as a hand copy), `FJS-553`/`FJS-554` (sortability and
  filterability reaching no client) and `FJS-D117`/`FJS-D118` (the routing
  questions about a co-located part's name and where *back* goes) are all
  closed or ruled now — see `ISSUES.md`/`DECISIONS.md`.
- **`FJS-632` is closed and `record()` was not the cause.** The second read
  arrived 25 ms after the first; what was wrong was a screen rendering *the two
  prices agree* while it was still asking what the second one was. Worth knowing
  because the shape recurs: two independent `record()` views compared against
  each other need a drawn UNDECIDED state, or the comparison's two answers are
  one branch.

## Picking it up next

1. **Run all four commands above before changing anything.** The two drives are
   not in `test`, so a green vitest run says nothing about the widget runtime or
   about whether a gated read still fails a static build.
2. **A detail-view generator is what remains of the table/filter-bar/detail
   trio** — the table and filter bar are built; the detail view is the one
   piece with no generator yet, and it would inherit the same ruled control
   mechanism (`FJS-D17`) unchanged.

## Unconfirmed

- `packages/sierra/example/` (the app on 8030) is exercised by no suite here —
  `tests/static-safety.test.js` is the only test naming an example path, and it
  uses its own fixture. Whether that example still runs was not checked.
- Whether the widget drive's fixture covers what a MINIFIED widget does; the root
  map says it does not, and `example`: `verify:widget` is named as the drive that
  minifies. Not re-measured here.
