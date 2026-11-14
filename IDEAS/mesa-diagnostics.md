---
id: mesa-diagnostics
status: proposed
dated: 2026-11-14
---

# Idea — Mesa diagnostics: a code, a severity and one shape for every finding Mesa reports

**Status: PROPOSED. Q1–Q5 open; 0.1 next.**
Probed against the tree 2026-11-14. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-14): take from Solid 2's diagnostics what Mesa lacks. The
comparison found the rules mostly matched or deliberately absent; what differs is the
channel. Solid gives every finding a stable code, a severity with a stated meaning, a doc
page and a structured event a test can capture. Mesa gives a sentence on the console.

**No new noun.** *Diagnostic* is already the word for a compile finding here (RULE 53:
"`compileSource` collects diagnostics"; `FJS-D803`), as in Solid and LSP. This paper extends
it to the runtime. One SHAPE — `{ code, severity, message, loc }` — with two emitters, since
the compiler runs in Node and the runtime in a tab, a terminal or a phone: the compiler's
`analysis.*` and a runtime `report()`.

## What exists (probed 2026-11-14)

- **Every runtime finding is a free-text `console.warn` / `console.error`.** `src/runtime.js`
  has 24 such calls; `[Mesa]` prefixes number 19 there, 15 in `src/runtime-terminal.js`, 7 in
  `src/runtime-server.js`, 4 in `src/runtime-native.js`. Each site keeps its own once-per-key
  `Set` (`_warnedDerivedWrites`, `_warnedDestructures`, …), none carries a code, warn versus
  error is chosen per site, and production gating is per site too: the duplicate `{#each}` key
  warns only when `NODE_ENV !== 'production'` (~3612), most others always.
- **The drives fail on the prefix, and two warnings already miss it.** `src/drive.js` (~564)
  promotes a `console.warn` whose text starts `[Mesa]` to a failure (`FJS-315`). The null-anchor
  warnings in `$$eachBlock()` and `ifBlock()` (~3360, ~3838) start `@frontierjs/mesa-runtime`
  and pass every drive.
- **The compiler's findings are strings.** `ctx.analysis.errors` / `.warnings` are arrays of
  sentences (about 44 push sites in `compiler.js`); 16 cite a `RULE n` from `docs/VISION.md`.
  The Vite plugin fails a transform on any error (RULE 53), and `fli check`'s `mesa-compiles`
  relays the same list to the terminal and the editor (`FJS-D803`, `FJS-D133`), so a code
  added at the compiler reaches all three.
- **A structured channel already exists, for devtools.** `__dev` in `runtime.js` (~5760) has
  `subscribe(fn)` / `_emit(event)` carrying `update`, `run`, `mount` and `unmount` events, a
  write log and a cause chain (`_by`). Nothing reports a finding through it.
- **Sierra has its own 141 `[Sierra]` messages**, out of scope until Q5.

## Prior art

- **Solid 2** ([diagnostics](https://v2.solidjs.com/reference/solid-js/diagnostics),
  [`DEV`](https://v2.solidjs.com/reference/solid-js/advanced/diagnostics-dev-hooks/dev),
  read 2026-11-14): 70 codes such as `REACTIVE_WRITE_IN_OWNED_SCOPE`. Each `DiagnosticEvent`
  carries `code`, `kind`, `severity`, `message`, owner path and `loc`; `guideUrl(code)` gives
  its page. *error* is broken behavior, *warn* works but is structurally wrong or expensive,
  *info* is advisory and never printed. `subscribe()` and `capture()` feed tests
  (`expectNoDiagnostics`). A production build reports nothing.
- **Svelte 5** names every compiler warning and runtime error with a snake-case code
  (`state_unsafe_mutation`) and documents each on one page
  ([runtime errors](https://svelte.dev/docs/svelte/runtime-errors)).
- **React** ships production errors as a number and decodes it on
  [react.dev/errors](https://react.dev/errors) — a code chosen for bundle size, not reading.
- **ReactiveScript** keeps Solid's names for its compile-time checks, so a compile error and
  Solid's runtime finding for the same shape share a code (`spec/99-diagnostics.md`,
  `solidjs/reactivescript@821a099`).

## Open questions

- **Q1 — What does a code look like?**
  - **A** — Solid's form, `SCREAMING_SNAKE`, and Solid's own name where the meaning matches
    (`REACTIVE_WRITE_IN_OWNED_SCOPE` for a derivation's write), a new name otherwise.
  - **B** — Svelte's form, `snake_case`, Mesa's own names throughout.
  - **C** — a number (`M104`), as React does.
  - **Recommend A** (confidence 3) — a name reads in a console without a lookup, which C
    gives up for bytes Mesa does not need to save; the API realm already spells its codes
    this way (junction's `NOT_FOUND` in `core/app.ts`, litestone's `PRINCIPAL_MISSING` in
    `core/client.js`); sharing Solid's names where they mean the same thing makes the
    comparison in this paper a lookup instead of a translation, the choice ReactiveScript
    made for the same reason.
- **Q2 — Where does a code's page live?**
  - **A** — one heading per code in `packages/mesa/docs/diagnostics.md`, the message ending in
    its anchor; a check fails on a code emitted with no heading or a heading no site emits.
  - **B** — beside the rule in `docs/VISION.md`, cited by `RULE n`.
  - **Recommend A** — most runtime findings have no RULE (a duplicate `{#each}` key, a frozen
    store); VISION states the language, and this is a list of the ways to get it wrong. A
    compile finding that enforces a `RULE n` links the rule from its heading. The check is
    Phase 3, so a code can ship without a page through Phases 1–2.
- **Q3 — Which severities, meaning what?**
  - **A** — Solid's three: *error* broken, *warn* works but structurally wrong, *info*
    advisory and sent to subscribers only.
  - **B** — *error* and *warn* with Solid's meanings, *info* added when its first producer
    arrives.
  - **Recommend B** (confidence 2) — nothing in the inventory is advisory; *info* would be a
    level with no emitter, and the cost findings that would use it (a hot node, a waterfall)
    are later. Either way the meanings move sites: a duplicate `{#each}` key leaves an orphan
    node (`FJS-315`), which is broken, so it is an *error* though it prints as a warning;
    0.1 grades each site.
- **Q4 — Does a production build report?**
  - **A** — yes, *warn* and *error* print in production; the sites gated today are moved
    to printing, so production behavior is one rule.
  - **B** — no, as Solid: a production build reports nothing.
  - **Recommend A** (confidence 2) — Mesa's findings mostly name a render it survived wrong,
    which is as wrong in production; the once-per-key sets bound the noise. The sites
    gated today change, so 0.1 lists them.
- **Q5 — Which messages are in scope?**
  - **A** — Mesa's four runtimes and its compiler; Sierra adopts the emitter after.
  - **B** — Mesa and Sierra's 141 together.
  - **Recommend A** — Sierra depends on Mesa (Invariant 1), so the emitter lands in Mesa
    first and Sierra's move is its own plan once the shape is proven.

## Phase 0 — Inventory and rulings

Goal: every finding Mesa reports, listed once, with its code decided.
Done when: Q1–Q5 are ruled and the inventory table names a code and severity for every site.

- [ ] 0.1 List every `console.warn` / `console.error` call in the four runtimes (not every
  `[Mesa]` prefix) and every `analysis.errors` / `.warnings` push: file and line, trigger,
  current level, the level Q3's meaning gives it, production gating, once-per what.
- [ ] 0.2 Map each to the Solid code of the same meaning, or coin one; mark the ones Solid has
  and Mesa does not (the comparison is in chat, 2026-11-14; FJS-4290 to FJS-4292 came from it).
- [ ] 0.3 Rule Q1–Q5.

## Phase 1 — One shape, two emitters

Goal: a runtime finding goes through `report()` and a compile finding through `analysis.*`,
both in the one shape.
Done when: step 1.5's check passes and `bun run test` is green.

- [ ] 1.1 `report({ code, severity, message, loc, data, once })` in `runtime.js`: prints
  `[Mesa CODE] message`, emits `{ type: 'diagnostic', … }` on `__dev`'s channel.
- [ ] 1.2 Move `runtime.js`'s 19 sites through it; the per-site `Set`s go.
- [ ] 1.3 Move the terminal, server and native runtimes' sites.
- [ ] 1.4 The compiler's findings become `{ code, severity, message, loc }`; `mesa-compiles`
  and the Vite overlay show the code.
- [ ] 1.5 A check that fails on any `console.warn` / `console.error` in the four runtimes
  outside `report()`, run by `bun run test`.

## Phase 2 — Consumers read events, not the console

Goal: a test asserts on codes.
Done when: the five browser drives and the terminal drive fail on a captured *warn* or
*error* event, and a reworded message cannot slip past them.

- [ ] 2.1 `drive.js` captures `diagnostic` events instead of matching the console prefix.
- [ ] 2.2 A test helper that captures events and asserts none (or exactly these codes).

## Phase 3 — Every code has a page

Goal: a finding names where to read about it.
Done when: the Q2 check passes in `fli check`.

- [ ] 3.1 Write `docs/diagnostics.md`, one heading per code: what, why, the fix.
- [ ] 3.2 The check that emitted codes and headings agree.
