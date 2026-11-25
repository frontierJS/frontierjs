---
id: mesa-declared-reactivity
status: proposed
dated: 2026-11-25
---

# Idea — Mesa's reactivity rule: what is written is what re-runs

**Status: PROPOSED.** Dated 2026-11-25. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. A ruling cites an open question
by its `Q` number.

## The problem

Mesa has never stated one rule for what a template binding, a derived `const` or
a `$:` re-runs on. The compiler guesses from the emitted text which bindings are
live (`_isReactive`), and the runtime then tracks every read inside the live ones,
through calls. So a binding's reactivity turns on spelling:

- `function label(p)` reading `n` is written once; `const label = (p) => …` and a
  no-argument `label()` are live (`FJS-4637`).
- A helper that CALLS a watched import is live under `FJS-D404`; one that READS the
  watched import directly is written once (`FJS-4636`).
- Consecutive live bindings share one `render()`, so any change re-runs all of
  them: under `$: prefs.theme`, every `{money(v)}` re-formats (`FJS-D404` measured
  1.6 ms per fire over 1,000 rows with a cached formatter, 31 ms without).
- `FJS-D381`'s cover updates a component from another component's watch,
  depending on mount order.

`FJS-D381` said a component's reactivity should be readable from its own source;
`FJS-D404` and the `FJS-1439` rule then made calls see-through, as bug fixes,
without restating the model. Probed 2026-11-25 with a six-binding screen; the
scratch harness is not kept.

## The rule

**An expression re-runs when a reactive name or property path written in its text
changes — a `let`, a prop, a derived `const`, or an import path a `$:` here watches
(RULE 44: written is not enough).
A property read is tracked, getters included. A call is a boundary: its receiver
and arguments are tracked and its body is not** — `{myValue.toFixed()}` re-runs
on `myValue`; `{here.get()}` does not, since `here` never changes and the live
read is inside `get()`. One rule for a template binding, a derived
`const`, a prop and a `$:` block. It is Svelte 3's rule, with property reads
tracked because Mesa's state lives behind getters.

| Written | Re-runs on |
| ------- | ---------- |
| `{label(n)}` | `n` |
| `{label()}` reading `n` | nothing — warned (Q3) |
| `{inRange(day)}`, local `inRange` reading `_startDate` | `day` — `_startDate` warned (Q4) |
| `{items.filter(i => i.price < max)}` | `items`, `max` (Q5) |
| `const { name } = load()`, local `load` reading `userId` | nothing — warned; once is `var` (Q6) |
| `$: { total += delta }` | `delta` — a target is a write (Q7) |
| `{(page.route, isActive(href))}` | `page.route`, `href` |
| `{money(v, prefs.currency)}` | `v`, `prefs.currency` |
| `{list.rows}`, `const rows = list.rows` | the getter's signal |
| `{here.get()}` | nothing — a call; the handle exposes `here.value` |
| `$: { other; log() }` | `other` (Q2) |

What follows from it:

- **A `const` over a property read is a live derived.** `const rows = list.rows`
  works, so `FJS-1969`'s warning and the 34 `const rows = () => list.rows`
  wrappers (25 files) lose their reason to exist.
- **`var` snapshots the name, not what is read through it.** `var here =
  presence(…)` keeps the handle from being re-created; `here.value` still tracks.
  RULE 13's wording narrows.
- **Live state on a handle is a property.** A method that answers a question takes
  its inputs as arguments — `plans.can('create', session.level)`, already how 22
  of 28 `can()` calls are written.
- **An imported helper is opaque at compile time.** The dev runtime sees its reads
  through a watched import, which is what Q3's runtime half uses.
- **Moving code into a helper changes what re-runs** unless the dependency is
  passed. This is the cost the rule accepts; Q3's warning is what keeps it loud.
- **Moving a callback into a named function is how it stops re-running.** A
  function passed by name is a value, not a call: `svc.on('*', onServer)` and
  `{@attach zone(rosterZone)}` have no triggers from the body, and Q4 warns only
  on a helper the expression CALLS. Inline, the same callback's names are triggers
  (Q5), so `const off = svc.on('*', (m, row) => …rows…)` re-subscribes on every
  change and leaks the old listener, and `{@attach zone(() => ({ items: roster }))}`
  re-attaches. Step 2.6 warns where the arrow holds the only triggers; in the
  script `var off = …` is the other spelling.

**Supersedes** `FJS-D404` (a call follows import watches), the `FJS-1439` rule (a
`const` calling a local function is derived on the strength of the call) and
`FJS-2616` (an `{@attach}` as a watched call). **Amends** `FJS-D381` (the cover
mostly goes) and VISION RULES 2, 13, 47, 60, 62, 64 and § 4.3. Closes `FJS-4636`
and `FJS-4637` by definition.

## Plan

### Phase 0 — Measure

Goal: every binding whose triggers change, by file and line, before any code moves.
Done when: a list over this repo and the linked prototype repos, each row naming
today's triggers and the rule's.

- [ ] 0.1 Compile every `.mesa` file (992 here) under both classifications and diff
  the trigger sets
- [ ] 0.2 The same over the 22 prototype repos that link this tree
- [ ] 0.3 Per live app (ELA, TPM): the rows that would go stale

### Phase 1 — Compiler

Goal: the rule, emitted.
Done when: `bun run test` in `packages/mesa` passes with the flipped tests, and
compiler tests parse their output (Invariant 15).

- [ ] 1.1 A call's arguments tracked and its body untracked — template, `const`,
  prop and `$:`, on the `$: deps, handler` untrack machinery. A free name inside
  an inline arrow is a trigger (Q5). `new X(a)`, a tagged template and `a?.()` are
  calls; `{@render s(x)}` is not, since the snippet's own bindings track. A getter
  must not run twice per render when the triggers are read apart from the value.
  The boundary is decided on the SOURCE AST: a call the compiler emits —
  `$$ctxRead` for `$context`, a prop accessor, `$async` — is never one
- [ ] 1.2 A property read in a `const` initializer derives it; `warnHandleReads`
  goes
- [ ] 1.3 Each binding gated on its own reads inside a shared `render()`
- [ ] 1.4 `$: { }` and `$: expr` follow Q2's ruling; an assignment target — `=`,
  `+=`, `++` — is never a trigger (Q7)
- [ ] 1.5 Delete `WATCHED_CALLS`, `opaqueLocalCall` and `_isReactive`'s text guesses
- [ ] 1.6 Flip `watch-follows-calls.test.js` and its siblings

### Phase 2 — The warnings

Goal: Q3's ruling as amended by Q4, Q6 and Q8 (`FJS-D2376`, `FJS-D2378`,
`FJS-D2383`), both halves, and a warning for each shape the rule leaves silent.
Done when: a compiler test or a runtime dev-check test sees each step's shape
warned and its fixed form quiet, and Phase 0's corpus names every site each new
warning fires on.

- [ ] 2.1 Compile time: a local helper reads state the expression does not name
  (Q4) — each missed read is named, whether or not the expression names others;
  a helper passed by reference, not called, is never warned
- [ ] 2.2 Dev runtime: an imported helper read a signal or watched path the
  expression does not name, partial or not (Q8) — router, session, presence and
  resources are signals
- [ ] 2.3 `var` alone clears it for an intended one-time read; both `const` forms, destructuring included, are warned (Q6)
- [ ] 2.4 Compile time: a top-level `var` assigned after init and read in a
  binding or a derived `const` — always stale, since a binding re-runs only on its
  own reads (1.3); the fix named is `let`
- [ ] 2.5 Compile time: a `let` read in a binding is mutated in place — a method
  that mutates (`push`, `splice`, `sort`, …) or a member write — with no `$:`
  covering the path and no `x = x` in the same function (RULE 43)
- [ ] 2.6 Compile time: an inline arrow whose names are its expression's only
  triggers re-runs what it is handed — `{@attach zone(() => ({ items: roster }))}`
  re-attaches, `const off = svc.on('*', () => …rows…)` re-subscribes. Q5 is
  unchanged; the warning names the re-run and offers a named function or `var`.
  `const cheap = items.filter(i => i.price < max)` is quiet: `items` is outside
- [ ] 2.7 Dev runtime: a derived `const` re-derived and the value it dropped has
  `destroy`, `dispose`, `close`, `disconnect`, `unsubscribe` or `abort` — the old
  one leaked; the fix named is `var`, or a `$: deps, handler` returning cleanup

Today's compiler is silent on all four shapes (probed 2026-11-25); it already
warns on a `$:` that reads and writes one name.

### Phase 3 — Sierra handles

Goal: no live state behind a method.
Done when: `bun run test` in `packages/sierra` and `example`'s `verify`.

- [ ] 3.1 `presence()` returns a handle, not the raw signal: getters `members`,
  `others`, `self`, `count` over the snapshot, plus `subscribe`, `updateMeta` and
  `leave`; `get()` and `set()` go (the roster is the server's to write). Agreed
  2026-11-25. Lands with or after Phase 1 — under today's compiler a property read
  through a `var` handle is written once.
- [ ] 3.2 Every other handle with a `.get()` or a no-argument live-state method

### Phase 4 — Migrate this repo

Goal: every row Phase 0 listed, fixed.
Done when: Phase 0's diff is empty and `fli done` is clear.

- [ ] 4.1 The 34 arrow wrappers over a handle read
- [ ] 4.2 The ~48 no-argument calls in template braces
- [ ] 4.3 `FJS-D404`'s formatter sites: pass or lead with the watched path
- [ ] 4.4 Haven's `here.get()` (Booth, Scene) as values in the script — `me`, `them`,
  `alone` — and the other `presence()` callers (workbench `chat-commands.js`,
  sierra `router/signals.js`, two sierra tests)
- [ ] 4.5 The ~107 `$: {` blocks against Q2's ruling
- [ ] 4.6 Callbacks that must not re-run under Q5, into a named function or a
  `var`: the 7 `const off = <service>.on('*', …)` in basecamp's routes and the
  23 `{@attach x(() => …)}` getters in 11 files, Haven's `keys` and the dnd zones
  among them; RULE 64's options-getter idiom in VISION becomes the named getter
- [ ] 4.7 Every `const` Phase 0 shows going from static to derived whose
  initializer is `new` or a call: a re-derive never disposes the old value

### Phase 5 — Doctrine

Goal: one rule, stated once.
Done when: `doc-audit` is clean on the touched files.

- [ ] 5.1 VISION RULES 2, 13, 47, 60, 62, 64 and § 4.3 rewritten as the rule above
- [ ] 5.2 `ui-hazards` mesa.md: the leading-read workaround becomes the idiom; the
  `const rows = list.rows` trap goes
- [ ] 5.3 The template idiom, stated where a new author meets it: state becomes a
  value in the script (a derived `const`) and the template reads values; a call in
  the template is a pure function of what it is passed — a formatter, or a
  per-row computation inside `{#each}` where no `const` can sit. Pass a helper the
  property, never the handle: `meOf(here)` reads `h.self` inside the body and goes
  stale; `const me = Number(here.self?.userId)` in the script is live. Time is a
  value too: `{ago(t)}` never ticks, `{ago(t, clock.now)}` does
- [ ] 5.4 RULE 13: a `var` over a watched object tracks reads through it, so a
  snapshot of one is `var initial = unproxy(form.values)`

### Phase 6 — Outside this tree

Goal: no app takes the new Mesa with a stale row on it.
Done when: each app's drive passes on the new Mesa.

- [ ] 6.1 The prototype repos, from 0.2's list
- [ ] 6.2 ELA, then TPM, one at a time, each proved by its drive before deploy

## Open questions

- ~~**Q1**~~ **Answered 2026-11-25 (`FJS-D2372`): A — Declared: names and property paths written in the text are tracked; a call's body is not.** — What a call means to the expression around it. **Recommend A.**
  - **A** — Declared: names and property paths written in the text are tracked; a
    call's body is not
  - **B** — Tracked: everything read is tracked, through calls (Solid, Svelte 5)
  - **Recommend A** — every trigger is visible in the line read, a call site can
    limit what re-runs, and it is `FJS-D381`'s own principle. B keeps `FJS-D404`'s
    coarse import rule anyway, since signals cannot see into a function reading a
    plain object.
- ~~**Q2**~~ **Answered 2026-11-25 (`FJS-D2373`): A — the names and paths in its text, like every other expression; a write-only target is not a trigger.** — What a `$: { }` block re-runs on. **Recommend A.**
  - **A** — the names and paths in its text, like every other expression; a
    write-only target is not a trigger
  - **B** — stays auto-tracked, the one explicit "whatever I touch" form
  - **Recommend A** — B is a second model in the same file; RULES 60 and 62 exist
    only because blocks discover their dependencies by running.
- ~~**Q3**~~ **Answered 2026-11-25 (`FJS-D2374`): A — when a call reads state and the expression names nothing reactive: compile time for a local helper, a dev runtime check for an imported one; `var` or destructuring clears it.** — When a forgotten dependency is warned. **Recommend A.**
  - **A** — when a call reads state and the expression names nothing reactive:
    compile time for a local helper, a dev runtime check for an imported one;
    `var` or destructuring clears it
  - **B** — whenever a helper reads state the expression does not name
  - **C** — never, as Svelte 3
  - **Recommend A** — a call-only binding that names nothing can never update, so
    it is always a bug; a partial declaration is trusted as meant. B fires on every
    intended partial trigger, and C leaves the failure to be seen on screen.
- ~~**Q4**~~ **Answered 2026-11-25 (`FJS-D2376`): A — warned: for a local helper the compiler names each reactive read its body makes that the expression does not; an import keeps Q3's dev runtime check. Amends Q3's "a partial declaration is trusted as meant" for local helpers.** — What a local helper's reads the expression does not name are. In
  DatePicker, `class:range={inRange(day, startDateMonth, startDateYear)}` names
  reactive values while `inRange` also reads `_startDate`, `_endDate`,
  `tempEndDate` and `isRange`; under Q3 that is a trusted partial declaration and
  the highlight never updates. **Recommend A.**
  - **A** — warned: for a local helper the compiler names each reactive read its
    body makes that the expression does not; an import keeps Q3's dev runtime
    check. Amends Q3's "a partial declaration is trusted as meant" for local helpers
  - **B** — see-through: a local function's reads join the triggers of any
    expression that calls it; only an import is opaque. Amends Q1
  - **C** — as Q3 rules: trusted, silent
  - **Recommend A** — the compiler sees a local helper's reads exactly, so a miss
    it could name is never silent, and a template call stays a pure function of
    what it is passed. B moves triggers from the line to the file; C ships
    DatePicker's bug.
- ~~**Q5**~~ **Answered 2026-11-25 (`FJS-D2377`): A — yes, in a template and in a `const`: `{items.filter(i => i.price < max)}` re-runs on `max`, and `const save = debounce(() => send(query))` is derived on `query`; once is `var save = …`, as RULE 2 already says.** — Whether a free name inside an inline arrow is written in the
  expression's text: orion's `{types?.find(t => t.type === n.type)?.label}` names
  `n` only inside the arrow. **Recommend A.**
  - **A** — yes, in a template and in a `const`: `{items.filter(i => i.price <
    max)}` re-runs on `max`, and `const save = debounce(() => send(query))` is
    derived on `query`; once is `var save = …`, as RULE 2 already says
  - **B** — no: only names outside every arrow are triggers
  - **Recommend A** — the arrow is in the line read, so its names are visible
    triggers; the repo has no `const` over a debounce, throttle or timer for A to
    break.
- ~~**Q6**~~ **Answered 2026-11-25 (`FJS-D2378`): A — no: destructuring is property reads like any other, and `var` is the one spelling of "once"; both `const` forms are warned. Amends Q3.** — Whether destructuring marks a one-time read. Q3 clears its warning for
  `var` or destructuring, so `const { name } = load()` over a local `load` reading
  `userId` is quiet while `const name = load().name` is warned. **Recommend A.**
  - **A** — no: destructuring is property reads like any other, and `var` is the
    one spelling of "once"; both `const` forms are warned. Amends Q3
  - **B** — yes, as Q3 says
  - **Recommend A** — two spellings of the same read should not differ in whether
    the bug is named.
- ~~**Q7**~~ **Answered 2026-11-25 (`FJS-D2379`): A — no: any assignment target — `=`, `+=`, `++` — is a write and never a trigger.** — Whether a compound-assignment target is a trigger in `$: { total +=
  delta }`, given `+=` reads it. **Recommend A.**
  - **A** — no: any assignment target — `=`, `+=`, `++` — is a write and never a
    trigger
  - **B** — yes: the read half counts, and the runtime suppresses the self-fire
  - **Recommend A** — B makes the block its own trigger; Q2 already rules a write
    is not one.
- ~~**Q8**~~ **Answered 2026-11-25 (`FJS-D2383`): A — any signal or watched path an imported helper reads during a binding that the expression does not name is warned in dev, partial or not: Q4's runtime twin.** — What the dev runtime check on an imported helper covers. In
  `{statusLabel(row)}`, an imported `statusLabel` reading `session.level` names
  `row`, so step 2.2 as written — the expression names nothing, the read is a
  watched path — stays silent, and Sierra's state is signals, not watched imports.
  **Recommend A.**
  - **A** — any signal or watched path an imported helper reads during a binding
    that the expression does not name is warned in dev, partial or not: Q4's
    runtime twin
  - **B** — as step 2.2 is written
  - **Recommend A** — router, session, presence and resources are signals, so B
    misses the state an app reads most, and the check costs nothing in production.
- ~~**Q9**~~ **Answered 2026-11-25 (`FJS-D2384`): A — none: a read subscribes only to watches this component declares.** — What is left of `FJS-D381`'s incidental cover, where a read through the
  proxy subscribes to a watch another component declared, by mount order.
  **Recommend A.**
  - **A** — none: a read subscribes only to watches this component declares
  - **B** — kept: it can add a render, never miss one asked for
  - **Recommend A** — B makes a binding's triggers depend on what mounted first,
    which no reading of the file can show, and dev and production can mount in a
    different order.
