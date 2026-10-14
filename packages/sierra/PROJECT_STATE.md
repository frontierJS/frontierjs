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
| Tests | **2167 pass, 0 fail**, 142 files (`bun run test`, vitest, 23s) — verified 2026-10-13 |
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
`../../DRIVES.md` § *Which drive proves a change* are the map; `fli proves` reads
them off a diff.

## What is NOT built

- **An MCP App view in a REAL host.** `build/mcp-build.js` builds one document
  per resource file and `test/mcp-build.test.js` proves the shape with a real build;
  the relay is built (`mcpApp()`,
  plan step 3.1, every call a `tools/call` to the host, and a refusal thrown
  with the `code` and `data` HTTP would have, 3.2), and the handshake opens a
  view (`startView()`, 3.3: `ui/initialize`, the tool's row read through the
  Resource as `record`, the mount, the size; 3.4, no identity, and a
  generated form locked over a gate only the application writes; 3.5, no
  live pushes — no socket, so `stale` never fires; 3.6, a `@@sync` write is
  never held there and a `field` save carries its base as `_meta`; 3.7, the
  record is the tool's answer, `detailQuery` or not), and a submit is
  dispatched in place, since a frame without `allow-forms` drops the browser's
  (`FJS-2849`). `fli mcp:build` (→ `sierra mcp --out`) writes them to
  `api/dist/mcp/` — 36 over `example` — and `example`'s `verify:mcp-view` runs
  the Product view in ext-apps' reference `AppBridge` on a third origin (4.3).
  None has run in Claude or an inspector yet (4.4).
  `IDEAS/agent-client-ui.md` § The plan is the order.

- **A detail-view generator.** The table and filter bar are generated —
  `resource.columns()` / `.filters()`, `display/Cell.mesa`, `display/FilterBar.mesa`,
  ranked by `columnList` — and a detail view is the one piece of that trio with no
  generator. It would inherit the ruled control mechanism (`FJS-D17`) unchanged.

Everything else this section used to list — sealed columns in a form, value-set
order and dependent sets, sitemap dynamic pages, the gate scale, sortability and
filterability, the co-located part's name and *back* — is closed or ruled; open
items are `../../ISSUES.md`.

**One shape worth knowing, from `FJS-632`:** two independent `record()` views
compared against each other need a drawn UNDECIDED state, or the comparison's two
answers are one branch.

## Picking it up next

**Run all four commands above before changing anything.** The two drives are not
in `test`, so a green vitest run says nothing about the widget runtime or about
whether a gated read still fails a static build.

## Unconfirmed

- `packages/sierra/example/` (the app on 8030) is exercised by no suite here —
  `test/static-safety.test.js` is the only test naming an example path, and it
  uses its own fixture. Whether that example still runs was not checked.
- Whether the widget drive's fixture covers what a MINIFIED widget does; the root
  map says it does not, and `example`: `verify:widget` is named as the drive that
  minifies. Not re-measured here.
