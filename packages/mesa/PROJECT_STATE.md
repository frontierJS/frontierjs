# Mesa — project state

**Shipped.** A `.mesa` component compiler and the signal runtime its output runs
on, a static/SSR renderer, a Vite plugin at the `@frontierjs/mesa/vite` subpath,
and a REPL. The version is `package.json`'s. History is `CHANGES.md`; open
defects are `../../ISSUES.md`; the package map and its traps are `CLAUDE.md`.

## How it is proven

`bun run test` runs, in order: `test/spec-check.mjs` (VISION §4's claims list),
vitest over `test/*.test.js`, then the two gating browser drives —
`test/browser/runtime/` (the language in a real browser) and
`test/browser/vite/` (the plugin in a real dev server). Both drives need Chrome on
PATH or `$FJS_CHROME`. `test:browser:repl` opens `example/index.html` and is
manual, because the REPL loads from CDNs (`FJS-326`).

Because SSR and hydration fail apart, a compiler or runtime change is also run
through `example`: `verify` and `verify:site` (root `CLAUDE.md` § Which drive
proves a change).

## What to read before changing an area

| Area | Read |
| --- | --- |
| The language | `docs/VISION.md` — numbered RULEs, cited by number |
| `runtime.js` | `CHANGES.md` § 2026-08-01 — the reactivity audit and the block-teardown pass: the two failure shapes behind every block-removal bug, and the claims that died under testing |
| Either renderer | `docs/STATIC_RENDERING.md` — what runs on the server, the two component-children protocols, island markers, `tmpDir`, and what a browser global answers during a render |
| External state reaching a component | `docs/EXTERNAL_REACTIVITY.md` — why sierra exports plain objects watched with `$:`, and the silent failure that survives it |
| The Vite plugin, HMR, the browser drives | `CLAUDE.md` § What bites here and § The browser drives |

## Deferred by the spec, not open here

Full hydration (islands are REPLACED, not adopted — `docs/STATIC_RENDERING.md`
§ Island markers), TypeScript in `.mesa` (RULE 20), and variable-height virtual
lists (RULE 34).

## Consumers in this repo

`@frontierjs/sierra`, `@frontierjs/ui`, `@frontierjs/email-kit` and
`@frontierjs/jetty`. jetty's `file:../mesa` dependency installs a COPY, so an edit
here is invisible to it until reinstall (root `CLAUDE.md` § Live hazards).
