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

- **No generator over a schema-driven table, detail view or filter bar.** The
  control mechanism is ruled and shipped (`FJS-D17`) and all three would inherit
  it unchanged; nothing consumes it, which is why no registry ships for them.
  Two halves are missing underneath: sortability (`FJS-553`) and filterability
  (`FJS-554`) are answered by `db.$checkOrderBy`/`$checkWhere` on the server and
  reach no client, so a generated header would offer a sort the Data boundary
  throws on. Root `../../CLAUDE.md` § Open questions.
- **A prerendered site's `sitemap.xml` omits every dynamic page** (`FJS-456`) —
  `generateSitemap` is handed the indexed routes, which exclude dynamic ones, so
  a storefront's sitemap lists no product.
- **A generated form offers an editable box for a sealed column** (`FJS-628`,
  with `ui`) — `@immutable` under a `@seals` move is frozen at the seal and
  nothing on this side reads it.
- **The gate scale is a hand copy** (`FJS-520`, decision `FJS-D184` open) — this
  package holds one of the four, across a boundary that forbids the import.
- **Value sets have two axes held out of `FJS-D120` and both are wanted**: a
  per-caller ORDER (`FJS-D121`) and a DEPENDENT set, where one field's value
  narrows another's list (`FJS-D122`). Both unruled.
- **`FJS-D117` and `FJS-D118` are unruled routing questions** — whether a
  co-located route part carries its folder in its name, and whether a page can
  state where *back* goes.
- **`FJS-632` is a live flake** (with `example`): a second `record()` on one
  screen never resolves about one run in three, and two fixes moved the rate by
  nothing. It predates the `domain/` split and is measured rather than reasoned
  about.

## Picking it up next

1. **Run all four commands above before changing anything.** The two drives are
   not in `test`, so a green vitest run says nothing about the widget runtime or
   about whether a gated read still fails a static build.
2. **`FJS-456` is the cheapest real defect here** — one filtered list handed to
   the wrong step, and `postbuild.test.js` is already the place to pin it.
3. **`FJS-553`/`FJS-554` are the pair that unblocks the open question.** They are
   one shape: a fact the Data boundary already answers and that the client cannot
   ask for. Doing them together is what makes a generated table decidable.
4. **`FJS-632` needs a measurement, not a fix.** Two candidate causes have been
   ruled out by running them; the next step is instrumenting the record view's
   own subscribe path rather than trying a third shape.

## Unconfirmed

- `packages/sierra/example/` (the app on 8030) is exercised by no suite here —
  `tests/static-safety.test.js` is the only test naming an example path, and it
  uses its own fixture. Whether that example still runs was not checked.
- Whether the widget drive's fixture covers what a MINIFIED widget does; the root
  map says it does not, and `example`: `verify:widget` is named as the drive that
  minifies. Not re-measured here.
