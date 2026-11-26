---
id: mesa-ordered-awaits
status: proposed
dated: 2026-11-25
---

# Idea — Mesa's ordered awaits: a load waits for the loads it reads

**Status: PROPOSED.** Dated 2026-11-25. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. A ruling cites an open question
by its `Q` number.

## The problem

An awaited `const` is `undefined` until its first answer (VISION § 13.2), and a
second awaited `const` that reads it starts at once anyway. In Svelte's own
dependent-selects example, ported to Mesa:

```mesa
const states = await getStates()
$: selectedState = states?.[0]
const cities = await getCities(selectedState)
```

the drive logged `getCities(undefined)` at the same millisecond as `getStates()`,
then `getCities('California')` 300 ms later. Against a real API the first call
fails, and a boundary with a `failed` snippet shows the error for a load nobody
asked for. The workaround is a guard the author has to know to write:
`await (selectedState && getCities(selectedState))`.

The wasted run is not limited to the hop through `$:`. `runtime.test.js`'s
FJS-3390 case (`b = await g(a)`, a direct read) runs `g` once with `a === null`
before `a` lands; the test asserts only the final value.

The pieces already exist. The compiler passes each load its async upstreams
(`compiler.js`, the `upstream` line in the awaited-const emit), and
`makeAsyncState` reads them so a chain reports `pending` end to end
(`FJS-3390`). Two things are missing: the list holds direct reads only, so a hop
through a derived `const` or a `$:` writable derived is missed; and
`asyncDerived` starts the loader without consulting it.

## The rule this proposes (RULE 16a)

**A load never starts before every async value it reads, directly or through
derived values, has its first answer.** Until then it is `loading`, as it is
today, and its loader is not called. After the first answer, an upstream refetch
does not hold it back: it keeps its old value, reports `pending` (as today), and
re-runs if the upstream lands with a new value.

A derived value is not deferred: `$: selectedState = states?.[0]` keeps its `?.`.

## Prior art

- **Svelte 5** ([await expressions](https://svelte.dev/docs/svelte/await-expressions)):
  a script `await` pauses the component, so the second call never sees an
  unanswered first. An upstream rejection goes to the nearest
  `<svelte:boundary>`, and the dependent never runs.
- **Solid 1.x** ([createResource](https://docs.solidjs.com/reference/basic-reactivity/create-resource)):
  a resource whose source is `false`, `null` or `undefined` does not call its
  fetcher. A source that reads an errored resource throws to the `ErrorBoundary`.
- **TanStack Query** ([dependent queries](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries)):
  `enabled: !!userId`, written by hand; a disabled query sits `pending` with
  `fetchStatus: 'idle'` and never errors.
- **SWR** ([dependent fetching](https://swr.vercel.app/docs/conditional-fetching#dependent)):
  a key function that throws or returns falsy means "not ready", and the fetch
  waits.

Every one of them refuses to call the loader with an unanswered input. They
split on upstream failure: Svelte and Solid pass the error down, TanStack and
SWR leave the dependent idle (Q1).

## Ruled out

- **Deferring a derived value that reads an unanswered async const**, so `?.`
  is never needed. `decision-rules` run 2026-11-25: it adds a "deferred derived"
  state to every derived `const` and lowers predictability, since a derived
  would sometimes not run. Revisit only with the `mesa-declared-reactivity`
  rule below settled.
- **Leaving it and documenting the `&&` guard.** A guard in prose is enforced
  by nothing, and the failure it prevents is a real request.

## Open questions

- ~~**Q1 — When an upstream load fails, what does the dependent do?**~~ **Answered 2026-11-26 (`FJS-D2393`): A — takes the upstream's error as its own: `error` is the same `Error`, `status` is `'error'`, and the loader is never called. Whatever shows the dependent failing shows why.**
  - **A** — takes the upstream's error as its own: `error` is the same `Error`,
    `status` is `'error'`, and the loader is never called. Whatever shows the
    dependent failing shows why.
  - **B** — stays `loading` and idle, as TanStack's disabled query does. No
    error of its own, so a template that shows only the dependent shows a
    spinner that never ends.
  - **C** — runs with `undefined`, as today. The `&&` problem comes back as a
    `TypeError` in `$async.x.error`.
  - **Recommend A** — it is Svelte's and Solid's answer, it keeps the
    dependent's `status` true, and a `refresh()` of the upstream that succeeds
    then starts the dependent. Confidence 2.
- ~~**Q2 — A loader that reads an async const only inside a called function.**~~ **Answered 2026-11-26 (`FJS-D2394`): A — accept it as the rule's edge, document it, and have the existing unanswered-read report (`_reportUnanswered`) name the loader in dev.**
  The compiler cannot see that read, so the gate misses it.
  - **A** — accept it as the rule's edge, document it, and have the existing
    unanswered-read report (`_reportUnanswered`) name the loader in dev.
  - **B** — gate at runtime as well: a loader whose synchronous part reads an
    unanswered async signal is abandoned and retried when that signal answers.
  - **Recommend A** — B is a second mechanism for a case the compiler already
    warns about elsewhere, and `mesa-declared-reactivity` (proposed the same
    day) may rule that a call is not a dependency at all. Confidence 2.
- ~~**Q3 — A load that reads a `let` a `$:` watch writes.**~~ **Answered 2026-11-26 (`FJS-D2395`): A — accept it as the rule's edge beside Q2, document it with its workaround (a derived `const x = a.n`), and pin it with a compiler test.**
  `$: a, () => { x = a.n }` then `const b = await g(x)`: a watch declares no
  variable, so `x` has no deps and `b` gets no upstream. `g(0)` runs before `a`
  answers.
  - **A** — accept it as the rule's edge beside Q2, document it with its workaround (a derived `const x = a.n`), and pin it with a compiler test.
  - **B** — the analyzer records an edge from each `let` a watch writes to that
    watch's deps, in a second map beside `v.deps`, and the closure walks it.
  - **Recommend A** — a watch is an effect with a trigger, not a derivation;
    `FJS-D2379` rules a write is never a trigger, and B is a second origin of
    dependency truth beside `v.deps`. `decision-rules` run 2026-11-25.
    Confidence 2.
- ~~**Q4 — What prints when a dependent adopts its upstream's error.**~~ **Answered 2026-11-26 (`FJS-D2396`): A — a failure prints at most once, at the load that failed: the runtime does not print for an adopted error, and the compiler counts an upstream as shown when a dependent that adopts its error is shown.**
  An unshown load prints `UNHANDLED_FAILURE` when it fails (`FJS-D2136`).
  Measured with adoption built: upstream shown and dependent unshown is one
  print naming the dependent; neither shown is two prints of one `Error`; and
  in Places, `states` (read only through `$:`) prints while the boundary's
  `failed` snippet shows that same error through `cities`.
  - **A** — a failure prints at most once, at the load that failed: the runtime does not print for an adopted error, and the compiler counts an upstream as shown when a dependent that adopts its error is shown.
  - **B** — the runtime half only; Places still prints for `states`.
  - **C** — leave it: every unshown load prints, adopted or not.
  - **Recommend A** — B and C leave two origins for one `Error`, and the
    shown-through-a-dependent edge is derived from `asyncUpstream`, not a new
    concept. `decision-rules` run 2026-11-25. Confidence 2.
- ~~**Q5 — The report `FJS-D2394` names cannot see the read.**~~ **Answered 2026-11-26 (`FJS-D2397`): A — the loader's rejection handler hands the error to the existing report, scoped to the loader's component, and the message names the loader.**
  A read inside a called function throws inside the loader's promise, so it is
  a rejection and never reaches `_reportUnanswered`. The only trace is a bare
  `TypeError` in `$async.<name>.error`, and with no deps the load never re-runs.
  - **A** — the loader's rejection handler hands the error to the existing report, scoped to the loader's component, and the message names the loader.
  - **B** — document the edge only and drop the report clause from `FJS-D2394`.
  - **Recommend A** — the report already takes a rejection from a delegated
    handler, so this is one call at the existing owner, and B leaves a load that
    is wrong with nothing saying so. `decision-rules` run 2026-11-25.
    Confidence 2.

## Related

- `IDEAS/mesa-declared-reactivity.md` proposes the rule for what a binding
  re-runs on. Phase 2's closure walks the same dependency graph, so a ruling
  there that changes what counts as a dependency changes 2.1.
- `$.transition` is the View Transitions API, not a held update. Holding the
  whole template until a change's loads land (Svelte 5's batches) is a separate,
  larger idea and is not proposed here.

---

### Phase 0 — Measure today

Goal: the current behavior on every path the rule touches, recorded here.
Done when: each step below has its found-record under it.

- [x] 0.1 Client, one hop through `$:` — the Places probe logged
  `getCities(undefined)` at 42 ms and `getCities('California')` at 342 ms.
  With the `&&` guard, one call at 376 ms.
- [x] 0.2 Client, a direct read and a hop through a derived `const` — count
  loader calls and arguments for `b = await g(a)` and `b = await g(d)` with
  `const d = a?.x`.
  Found: both shapes call `g` twice. Direct read (`a = await f()` resolving
  `{ x: 'X' }`): `g(undefined)` at mount, then `g({ x: 'X' })` once `a` lands.
  Hop (`d = a?.x`): `g(undefined)`, then `g('X')`. The first argument is
  `undefined`, not `null`; the rendered value ends right in both.
- [x] 0.3 Server render — what `renderToHTML` writes for Places with no guard:
  the California cities, nothing, or a failure. `boundaryWait` waits on the
  states it is handed; whether a dependent started late is among them is the
  question.
  Found: a loader that rejects for `undefined` made no difference to any row.
  Calls are `getStates()` and `getCities(undefined)` at once in every row, and
  `getCities('California')` only where the table says. None throws.
  - Flagged (`hydratable: true`), string mode (`target: 'server'`), inside a
    `<mesa:boundary>`: waits, and writes the California cities from three calls
    (`undefined`, then `'California'`). `boundaryWait` waits on `settled()` of
    the dependent, which covers the late run; the `undefined` call's failure is
    superseded and `failed` is not written.
  - Flagged, string mode, no boundary: writes the empty marker, `<p><!--m 0 .. empty--></p>`;
    the late `getCities('California')` never runs inside the render.
  - Flagged, happy-dom path (DOM compile): `<p></p>` with no boundary and an
    empty string with one; two calls, never `'California'`. `boundaryWait` is
    emitted only in string mode.
  - Unflagged, either path, boundary or not: `<p></p>` or `""` (the `pending`
    branch, which has no snippet); two calls, never `'California'`.
- [x] 0.4 Hydration — a flagged render's seeded dependent, and an unflagged one,
  on the client after a server render.
  Found: the server wrote `{"0 $h4": states, "0 $j0": cities}`, both flagged.
  - Both seeded: no loader call; the client adopts the California cities.
  - Dependent unseeded, upstream seeded: one call, `getCities('California')`
    (the seeded upstream gives `selectedState` its value at once).
  - Upstream unseeded, dependent seeded: `getStates()` and then
    `getCities('California')`, so the seeded dependent re-runs when its
    upstream lands and the seed saves nothing.
  - Neither seeded: `getStates()`, `getCities(undefined)`,
    `getCities('California')`, as on a plain client.


### Phase 1 — Ruling

Goal: RULE 16a and the answers to Q1 and Q2 recorded.
Done when: `fli decisions` no longer lists them, and VISION § 13.2 states the
rule.

- [x] 1.1 Owner rules the rule, Q1 and Q2; record each with `fli decide`.
  `FJS-D2393`, `FJS-D2394`, and Q3 as `FJS-D2395`.
- [x] 1.2 Amend VISION § 13.2 with RULE 16a and add its row to
  `docs/guide/reference/rules.md`.

### Phase 2 — The compiler hands every load its whole upstream

Goal: `makeAsyncState` and `asyncDerived` receive every async const a load
reads, through any number of derived hops.
Done when: the new `compiler.test.js` cases pass and `bun run corpus` shows no
other change in output.

- [x] 2.1 Replace the direct-deps filter on the `upstream` line with a closure
  over the variable graph: through a derived `const` and a `$:` writable
  derived, stopping at an async const.
  Built: `asyncUpstream` in `compiler.js` walks `vars[dep].deps` through derived
  consts and `$:` writable deriveds (both are vars with deps), stops at an async
  const, and is cycle-safe. A `let` a `$:` watch writes is not followed
  (`FJS-D2395`); a `compiler.test.js` case pins it.
- [x] 2.2 `compiler.test.js`: Places' shape (one hop through `$:`), a hop through
  a derived `const`, two hops, and a non-async chain that must pass `[]`.

### Phase 3 — The runtime gate

Goal: no loader is called while an upstream is unanswered.
Done when: `bun run test` in `packages/mesa` passes, bench gate included.

- [x] 3.1 `asyncDerived` reads each upstream's `loading` and `error` inside its
  effect, so the effect re-runs when an upstream answers even with a value equal
  to the old one. While any is loading, it does not run. On an upstream error,
  it does what Q1 rules. A seeded run skips the gate. `refresh()` on a dependent
  whose upstream is unanswered does nothing.
  Built: the gate reads a new `_answered` signal (set on the first `done`)
  rather than `loading`, since a failed first load refreshed has neither
  `loading` nor `error` and no value; an unanswered upstream with status
  `'error'` is adopted through `_update('error')`. `deps === null` is untouched.
- [x] 3.2 `runtime.test.js`: the FJS-3390 case gains a call-count assertion
  (one call, never with `null`); a hop; an upstream that answers with the value
  its dependent already read; an upstream error, then a successful `refresh()`;
  a seeded dependent.
  Found: six of the seven fail on the pre-change runtime; the seeded case
  passes there and fails only on a gate that blocks seeds. A gate on
  `!loading && status !== 'error'` fails the refresh-in-flight assertion.
- [x] 3.3 Q4 (`FJS-D2396`): an adopted error does not print, and the compiler
  counts an upstream shown when a dependent that adopts its error is shown,
  closed over the `asyncUpstream` graph.
  Built: `_update('error', err, true)` in the adopt arm, and `!adopted` on the
  one print; `refuseUnhandledFailures` grows a `shown` set by walking
  `asyncUpstream` from every directly shown load. `async-function-state.test.js`
  has three compiler cases (Places, a chain of three, an unshown dependent) and
  three runtime ones (neither shown, upstream only, both); four fail with the
  change off, and the negative and both-shown cases pass either way.
  A dependent adopts a failed first load only, so a load shown only through a
  dependent keeps its name and takes a third argument,
  `makeAsyncState([], 'states', true)`: its first-load failure does not print,
  and a refetch that fails after its first answer does. One runtime case pins
  both halves.
  Not covered: a hydrated dependent that starts from its seed never reads its
  upstream's status, so an unseeded upstream that fails under it is neither
  adopted nor printed.
- [x] 3.4 Q5 (`FJS-D2397`): a loader's rejection goes to `_reportUnanswered`,
  scoped to `entry.owner`, after `answered()` so the loader is never its own
  cause; the message names the loader and says to pass the value as an
  argument.
  Built: three cases in `async-function-state.test.js`; the `TypeError` one
  fails with the call removed, the non-`TypeError` and nothing-unanswered ones
  print nothing either way.

### Phase 4 — Server and hydration

Goal: a server render and a hydrated client each call each loader once, with a
real argument.
Done when: a server-render case for Places passes, and `bun run verify` and
`bun run verify:site` in `example/` pass.

- [x] 4.1 Server: whatever 0.3 found, a boundary over a dependent load writes
  the dependent's answer in one render.
  Found (`hydrate.test.js` § Places): flagged string mode in a boundary writes
  `LA, SF` from `getStates()` and `getCities('California')`; a failing
  `getStates()` writes its error in `failed` and `getCities` is never called.
  The other rows write the same bytes as 0.3 and now call only `getStates()`.
- [x] 4.2 Hydration: whatever 0.4 found, a seeded dependent starts from its seed
  and an unseeded one waits for its upstream.
  Found: both seeded, no call; dependent unseeded, `getCities('California')`;
  neither, `getStates()` then `getCities('California')`. Upstream unseeded and
  dependent seeded still starts from the seed and re-runs once on the landing.

### Phase 5 — Docs and the Rosetta page

Goal: the rule is where an author looks.
Done when: `fli done` is clean, and the Reactive Rosetta drive passes 36/36
with its call log showing no `undefined`.

- [x] 5.1 `docs/guide/runtime/async.md`: a section "One load feeding another"
  with the rule, the `?.` a derived still needs, and the failure behavior Q1
  rules.
- [x] 5.2 `docs/guide/misc/coming-from-svelte.md`: a row for a chained
  `await`.
- [x] 5.3 The Reactive Rosetta's `Places.mesa` drops the `&&` guard and its
  note; rerun the drive and republish.
  - Republished 2026-11-26 as version 5, with the drive at 36/36. The footer no
    longer counts "no guard" as a place Svelte goes further. The same publish
    also carried Todos' `bind:checked={todo.done}` (the `{#each}` list-root
    fix), so `toggle` is gone from the Mesa listing.
