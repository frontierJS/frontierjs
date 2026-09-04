# jetty — Project State

_Verified 2026-09-03 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up jetty cold.
> Read `../../CLAUDE.md` first, then this package's `CLAUDE.md` for the layout and
> the traps. Neither is restated here.

---

## What it is

`@frontierjs/jetty` v0.0.3 — the browser-extension app container: MV3 surfaces
rendered with Mesa, a service worker holding the only connection to Junction.

Realm: **UI container**. It is a peer of Sierra rather than a layer on it — an app
gets it as the `extension/` surface beside `api/`, `web/` and `site/`. Its
vocabulary (Harbor, Dock, Island, Pier) is its own, and **jetty's islands are not
Sierra's**.

## Verified state

| | |
|---|---|
| Tests | **445 pass, 0 fail** across **eleven** phase files (`bun run test`, which runs plain node over them in order) — verified. Per phase: 33 · 57 · 50 · 41 · 74 · 54 · 50 · 33 · 40 · 6 · 7 |
| Typecheck | **clean, 0 errors, no baseline** (`bun run typecheck`) — verified. jetty is absent from `scripts/typecheck-baselines.json`, which means 0 |
| Published | **0.0.3 on npm, matching the tree** (`npm view @frontierjs/jetty version`) — verified. Seven export subpaths and five `jetty-*` binaries, all shipped by `files:` per `exports.snapshot.md` |
| Open defects | **none.** No row in `../../ISSUES.md` is open against this package; the only unclosed row touching it is `FJS-D119`, the node/bun runner split, which is a decision rather than a defect |
| The fixture builds | `bun run build:fixture` runs inside the suite (phase 6 and phase 8 both drive a real Vite build) and phase 8 parses each artefact for its load mode — verified by the suite passing |

Reproduce: `cd packages/jetty && bun run test && bun run typecheck`.

**Both doc headers under-count the suite.** `CLAUDE.md` and `README.md` each say
ten phase files; there are eleven (`phase2.5` and `phase9` are both extra to a
`phase0…phase8` reading), and the README's *432 assertions* is thirteen behind what
the command prints. The `test` script itself runs all eleven, so the numbers are
stale prose rather than a hole in coverage.

---

## What is NOT built

- **The permission audit is string matching, not a parse.** `src/audit/` scans
  source text for `chrome.*` / `browser.*`, with known false negatives on
  framework-internal indirection and on minified code. A real parser (acorn, swc)
  would close both. Owed since the README was written and still owed.
- **`default-adapter.js` is still a placeholder and still shipped.** The real one
  is `junction-adapter.js` (`FJS-279`, closed 2026-08-25), so the placeholder is
  now a second thing answering the same protocol with nothing pointing at it. The
  README's *What's not yet done* still lists `FJS-279` as open, which it is not.
- **The UnoCSS pair predates Invariant 13.** `src/build/uno-plugin.js` and
  `src/island/unocss-mirror.js` are reached from four more files under `src/`;
  removing them is in scope and nobody has.
- **Two HMR harnesses are dead and kept on purpose.** `docs/dead/` holds
  `hmr-fullflow.mjs` and `hmr-integration.mjs` with a README saying why — they
  import mesa by an absolute path from another machine (`FJS-481`). `phase9`
  covers the wrapper's output alone; the full flow through jsdom is unrepaired.
- **`docs/future-refactors.md` is one refused option** (`resources-core`, superseded
  by `FJS-D16`) kept for its argument. There is no forward plan document here.

## Picking it up next

1. Run the suite before touching anything — it is eleven node processes in order
   and it is fast. Then correct the three stale counts, in `CLAUDE.md`,
   `README.md` and the README's `FJS-279` bracket, since all three currently
   mis-describe a green package.
2. **Nothing here proves the wire.** The suite asserts the adapter's SHAPE; the
   only place jetty talks to a real Junction, and the only place an extension is
   loaded into a browser profile, is `example`: `verify:extension`. Run it for any
   change to `src/junction/`, `src/runtime/` or `src/resources/`.
3. The two removals above — the placeholder adapter and the UnoCSS pair — are each
   a contained afternoon and each shrinks the published surface.

## Unconfirmed

- `example`: `verify:extension` was **not run** for this file. It needs Chrome, a
  built storefront and both servers, and nothing in this package's own suite
  stands in for it.
- Whether the audit's known false negatives are reachable in a real app's build
  output, or only in hand-written adversarial source. Nothing measures the rate.
- Firefox parity is asserted by the build (`--browser=firefox`, `--browser=both`)
  and by manifest emission; no Firefox profile has loaded the result here.
