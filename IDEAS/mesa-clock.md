---
id: mesa-clock
status: proposed
dated: 2026-11-10
---

# Idea — refresh an async derived, and timers on one runtime clock

**Status: PROPOSED.** Nothing here is ruled unless a row cites a ruling. Probed
against the tree 2026-11-10. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-10): having compared Mesa with expo/exact's Contract
language, find which of Contract's seven declared effects we have no clear way
to write, and whether our code needs them.

## What exists (probed 2026-11-10)

Contract declares `state`, `derive`, `resource`, `mutation`, `action`, `task` and
`sequence` (`docs/contract-grammar.md` in https://github.com/expo/exact). Mesa
covers the first five with `let`, `const`, `const x = await …` and Sierra's
resource. Two gaps came out of an audit of every `.mesa` file in `packages/`,
`example/` and `../fjs-prototypes` (regex counts, read one line a site):

- **An async derived cannot be re-run on demand.** `const x = await f(dep)` reruns
  only when a dependency changes (`compiler.js` at the async-derived emit;
  VISION §13). 36 files hand-write `const mine = ++seq … if (mine !== seq) return`
  with their own `loading`/`error` lets; the five sampled all guard reads.
  The idiom `let v = 0; const x = await f(dep, v)` then `v++` already re-runs,
  keeps the old value while pending and drops a stale reply — probed under
  happy-dom with a compiled component. Nobody used it.
- **No declared timer.** About 100 hand-written timers: ~35 polls while
  something runs, ~30 debounces, ~20 flash auto-clears (one guards against
  clearing a newer flash: thod's `ReportReference`), ~11 clock ticks, 4 undo
  windows; three cleanup styles. Mesa itself reads the wall clock in
  `|debounce`/`|throttle` (`runtime.js` ~2260), the transition waits (~2476,
  ~2537, ~2563), two `requestAnimationFrame` (~3144, ~3170) and
  `runtime-terminal.js` twice; `drive.js` waits on `Date.now()` (~560, ~595).
- serpgrid's `requests/` and `clients/[id]/phone` polls cite `FJS-1741` as the
  reason, and it closed under `FJS-D953`.

## Open questions

- ~~**Q1 — How an async derived is re-run on demand.**~~ **Answered 2026-11-10 (`FJS-D2058`): B — `$async.x.refresh()`, one verb on the state object beside `$async.f.for(key)` (`FJS-D591`), compiling to the same rerun.**
  - **A** — Document the version-token idiom in VISION §13 and add nothing. It
    works today; the token leaks into `f`'s arguments.
  - **B** — `$async.x.refresh()`, one verb on the state object beside
    `$async.f.for(key)` (`FJS-D591`), compiling to the same rerun.
  - **Recommend A** — the idiom already passes the probe, so the verb is sugar,
    and § IV's cut-one-level-simpler prices sugar first.
- ~~**Q2 — Declared timers, and when.**~~ **Answered 2026-11-10 (`FJS-D2059`): B — The full shape before v1: `$.after` and `$.every`, one runtime clock every Mesa timer reads, a drive that advances it, the sites migrated.**
  - **A** — The drive installs fake timers per page now (Playwright's clock,
    https://playwright.dev/docs/clock, over `@sinonjs/fake-timers`); declared
    timers are the recorded destination, built when a second host or a
    lifecycle bug asks.
  - **B** — The full shape before v1: `$.after` and `$.every`, one runtime clock
    every Mesa timer reads, a drive that advances it, the sites migrated.
  - **C** — The drive clock only; timers stay plain JavaScript.
  - **Recommend A** — the drive clock reaches every existing timer with no
    language change, and adding `$.after` after v1 breaks nothing.
- ~~**Q3 — What a raw `setTimeout`/`setInterval` in a `.mesa` script is once `$.after`/`$.every` exist.**~~ **Answered 2026-11-10 (`FJS-D2060`): A — A warning naming the declared form, every time.**
  - **A** — A warning naming the declared form, every time.
  - **B** — A warning only when the handle reaches no `$.onDestroy`/`$.onCleanup`.
  - **C** — Nothing; both stay valid.
  - **Recommend A** — the drive's clock cannot advance a timer it does not own,
    so every raw one is a place a drive falls back to real time.
- ~~**Q4 — What the drive's clock controls.**~~ **Answered 2026-11-10 (`FJS-D2061`): B — Mesa's clock, and the page's `Date`, `setTimeout`, `setInterval` and `requestAnimationFrame` faked as Playwright does, so library code holds still too.**
  - **A** — Mesa's runtime clock only.
  - **B** — Mesa's clock, and the page's `Date`, `setTimeout`, `setInterval` and
    `requestAnimationFrame` faked as Playwright does, so library code holds still too.
  - **Recommend B** — a third-party widget animating on real time would move
    between two operations, which is the flake the clock exists to remove.

- ~~**Q5 — Does `$async.x.refresh()` exist on a one-shot `const x = await f()` that reads nothing reactive?**~~ **Answered 2026-11-10 (`FJS-D2062`): A — One emit: the one-shot goes through `asyncDerived` with `[]` deps, first run untracked, so every awaited `const` has abort, latest-wins and `refresh`. Every one-shot's output changes (rebaseline the corpus; measure the byte gate); SSR's `{#await}` wait (`FJS-D1647`) must be re-proved.** Found building 1.1: the compiler has two emits for
  an awaited top-level `const` — `asyncDerived` when the argument reads a
  reactive value, a bare IIFE with no rerun and no abort when it does not — so
  `.refresh` is legal or a compile error depending on whether a dependency is in
  the argument, and adding the first `page.query` read flips the error off.
  - **A** — One emit: the one-shot goes through `asyncDerived` with `[]` deps,
    first run untracked, so every awaited `const` has abort, latest-wins and
    `refresh`. Every one-shot's output changes (rebaseline the corpus; measure
    the byte gate); SSR's `{#await}` wait (`FJS-D1647`) must be re-proved.
  - **B** — Keep the refusal that is built: `refresh` only where a dependency
    already triggers a rerun; a Reload button on a plain load uses the
    version-token idiom Q1 retired.
  - **Recommend A** — one owner of "this const is loading" (§ V question 6);
    B's legality turns on a fact the author did not write (predictability), and
    a load with no dependencies is the commonest thing to put a Reload button on.

- ~~**Q6 — What a sleep inside an async function is.**~~ **Answered 2026-11-10 (`FJS-D2063`): A — `$.sleep(ms)`: an awaitable on the runtime clock, allowed inside a function (the one imperative timer verb, beside the Promise-returning `$.measure`/`$.viewport`/`$.focus`); never resolves after the owner is destroyed, so a `finally` around it does not run then. Costs: a sleep after an `await` has no `_owner`, so the compiler binds it to the component's destroyed flag at the factory; `runtime-native.js` exports it too; the sniff lists and the warning text name it.** Found building 3.3: `$.after`
  and `$.every` are top-level declarations (RULE 65), so
  `await new Promise(r => setTimeout(r, ms))` — simulated latency in 14 of the
  74 REPL examples, retry backoff in apps — has no declared form, runs on real
  time outside a held clock, and now warns under `FJS-D2060` every time.
  - **A** — `$.sleep(ms)`: an awaitable on the runtime clock, allowed inside a
    function (the one imperative timer verb, beside the Promise-returning
    `$.measure`/`$.viewport`/`$.focus`); never resolves after the owner is
    destroyed, so a `finally` around it does not run then. Costs: a sleep after
    an `await` has no `_owner`, so the compiler binds it to the component's
    destroyed flag at the factory; `runtime-native.js` exports it too; the sniff
    lists and the warning text name it.
    **Built 2026-11-10** (`sleeper()` in `runtime.js`, `$$sleep` per instance,
    5 rows in `test/declared-timers.test.js`, the 14 examples migrated, VISION
    §17 + rules-index rows 65/66). Found building: no native export is needed
    (every target imports `$$runtime` from `runtime.js`); under the server's
    `quietSource` a sleep hung the render queue (`FJS-D1647` waits on every
    `{#await}`), so there it resolves at once; `$.sleep` is refused in
    `<script module>` with the three Promise verbs. The ruling carries the
    corrections.
  - **B** — No verb: the warning stands and an author imports `clock` from
    `@frontierjs/mesa/runtime` — a second door beside `$` (`FJS-D132`), taught
    by 14 examples.
  - **C** — The warning exempts the sleep shape — against `FJS-D2060`'s "every
    time", and the sleep stays on real time.
  - **Recommend A** — one owner of time (clock.js) and one door (`$`); the
    warning can then name a replacement for every raw timer. `sleep` over
    `wait` (`waitFor` is the drive's) and over `$.after(ms)` with no `fn` (one
    name, two shapes).

- ~~**[ ] **Q7 — What `$.every` does when an async `fn` is still pending at the next tick.** Found surveying 5.1: `declaredTimer` calls `fn()` on every tick of `clock.every`, so a slow server stacks overlapping polls; all 18 polls being migrated re-arm by hand only after their body settles.**~~ **Answered 2026-11-11 (`FJS-D2064`): A — No overlap: a tick due while the promise `fn` returned is pending is skipped, the next tick after it settles runs; cadence stays `ms`. One rule, no option; a sync `fn` is unchanged. Flag cleared in `finally`, reset in `arm()` so a `key` change starts the new cadence (RxJS `exhaustMap`, TanStack `refetchInterval`).**
  - **A** — No overlap: a tick due while the promise `fn` returned is pending is
    skipped, the next tick after it settles runs; cadence stays `ms`. One rule,
    no option; a sync `fn` is unchanged. Flag cleared in `finally`, reset in
    `arm()` so a `key` change starts the new cadence (RxJS `exhaustMap`,
    TanStack `refetchInterval`).
  - **B** — Ticks on schedule regardless; each site keeps an `inFlight` flag in
    `when` — the stacking bug the migration exists to remove, copied 18 times
    (VueUse `useIntervalFn`).
  - **C** — `ms` counts from settle, a re-arming `after` — `every(5000)` no
    longer means five seconds and `runFor` cannot count its firings (SWR
    `refreshInterval`).
  - **Recommend A** — the pending state is derived from the promise `fn`
    already returns and lives in the one owner of arming. Owed: a
    `declared-timers` case where `advance(3 * ms)` against a never-settling `fn`
    calls it once and a second advance after it resolves calls it again. If a
    site needs C, a later opt-in `{ after: true }`.

## Phase 0 — Groundwork

Goal: every wall-clock reader known, and the stale polls gone.
Done when: the table below lists each reader with its owner, and serpgrid's
three polls are removed or name what still forces them.

- [x] 0.1 List every wall-clock read in `packages/mesa/src` and `drive.js`, with
  what each would read from the runtime clock instead. **Done 2026-11-10**; the
  table is § The readers below. Found on the way: no site has an injectable
  scheduler; `browser/clock.js` is the `now({ every })` time signal (parks while
  the tab is hidden), not a timer owner, and is the one owner-scoped teardown;
  `keys.js`'s matcher already takes `now` as an argument.
- [x] 0.2 Check serpgrid's channels against `FJS-D953`; drop the polls a tether
  now covers. **Done 2026-11-10** (serpgrid, uncommitted): every watched model
  already has `channel: agencyChannel`, which reads the agency off the row and
  takes a null `ctx`. `requests/`, `requests/[id]`, `clients/[id]/phone` and
  `locations/[id]` (a scan-progress poll, not a tick) are `service.on('*')`
  subscriptions plus a reconnect re-read, proved by a new `live.test.ts` describe
  (a second agency's tab hears nothing). `requests/[id]` keeps a 1.5 s tick for
  its elapsed counter — a Phase 5 timer, not a poll. `web/src/lib/chat.js`'s
  `draftPoll` is deleted: `startChatAlerts` already subscribed to every
  `clientRequests` op, so the poll only covered a frame lost while the socket
  was down, and a `reconnected` re-read now does that. Left: `LinkPreview`'s
  re-ask in `link-cards.js`/`chat-unfurl.job.ts` — that model has no channel,
  and whether it gets one is serpgrid's own question. `chat.test.ts`'s
  private-room failure fails the same way at HEAD (checked in a worktree).
- [x] 0.3 Read prior art with sources: Playwright clock, `@sinonjs/fake-timers`,
  Exact's `clock` operations (`docs/testing.md`, LLP 1012 as cited there).
  **Done 2026-11-10**; § Prior art below. LLP 1012 itself is not public; Exact's
  clock verbs come from its `docs/reference.md`, `docs/testing.md` and
  `docs/contract-for-humans.md`.

### Prior art (read 2026-11-10)

What Phases 2–4 copy, each with its source.

- **Two layers, the runtime's clock first.** Exact's `clock +N` / `clock settle`
  / `clock data` drive a clock the runtime owns and fake no global; Playwright's
  `install` patches the page (`Date`, `Temporal.Now`, `setTimeout`/`setInterval`,
  rAF, `requestIdleCallback`, `performance`, `Event.timeStamp`). `FJS-D2061` takes
  both: Mesa's clock is the seam, the page fake covers library code.
  (expo/exact `docs/testing.md` § Waiting; playwright.dev/docs/clock.)
- **Install before any page script, in the new-document hook.** A timer armed by
  the native `setTimeout` before install keeps its native handle: Playwright's
  faked `clearTimeout` builds an Error for it and never throws, sinon
  `warnOnce`s, and the timer fires on real time either way. Playwright registers
  the clock as an init script (`addInitScript`), evaluates it in open frames, and
  keeps a replayable log of every clock verb that each new document replays, so
  a navigation lands on the same virtual time and paused state. Fake ids start
  at `1e12` so a native id is detectable. (`playwright-core/src/server/clock.ts`
  `_installIfNeeded`, `_replayLogOnce`; `injected/src/clock.ts`.)
- **`runFor` and `fastForward` are different verbs.** `runFor(n)` fires every
  intermediate timer at its own virtual time, with `now` set to it; `fastForward`
  rewrites every overdue timer to the final instant and fires each once, so an
  interval fires once (the "laptop lid"). sinon's `tick` / `jump` are the same
  pair. `clock(ms)` is `runFor`. (`injected/src/clock.ts` `_runTo`,
  `_innerFastForwardTo`; sinonjs/fake-timers README.)
- **Yield a real task between fired timers.** Playwright awaits a
  `MessageChannel` task after each callback (`setTimeout(0)` is clamped to 4 ms
  when nested), so promise continuations settle; sinon's `tickAsync` exists for
  the same reason. A drive's `clock(ms)` is async.
- **Queue order is fire time, then creation order**; a timer armed inside a
  callback with delay 0 lands at `now + 1`, which is what keeps zero-delay
  recursion finite; an interval re-arms from its scheduled time, not from `now`.
  (`compareTimers` and `addTimer` in both libraries.)
- **A frame is a timer on a 16 ms grid**: `callAt = 16 - now % 16`, the callback
  receives the fake `performance.now()`. `queueMicrotask`/`nextTick` are faked
  only by opt-in (Vitest's default `toFake` excludes them, includes `performance`).
- **`settle` has a bound and an honest answer.** Exact's `clock settle` stops at
  its bound and reports `settled: false` when a repeating timer or an infinite
  animation is armed, and says the poll belongs in a declared `task`; sinon's
  `runAll` throws "assuming an infinite loop" at `loopLimit` (1000; Vitest
  10 000). So `clock('settle')` runs `after` timers and frames to idle, treats
  `every` as never-settling, and names what kept it from settling.
- **`when` and `key` follow Elm and VueUse, not an effect re-run.** Elm's
  `Time.every` exists exactly while `subscriptions` returns it, reconciled per
  update as kill-plus-spawn keyed on the interval; VueUse's `useIntervalFn`
  never starts a paused timer on an interval change, and firing once on resume is
  an explicit option (`immediateCallback`, default off), with `pause` bound to
  scope dispose. Svelte's `$effect`/Solid's `onCleanup` idiom is the baseline to
  beat: a re-run silently re-arms. (`elm/time` `onEffects`;
  `vueuse/shared/useIntervalFn/index.ts`.)
- **Real waits stay a separate, named path.** Exact refuses `clock +N real` for
  protocol state and offers `clock until state <path> == <v> within <ms>` (clock
  frozen, real-time poll, a miss names the last value) and `clock held` for a
  long poll. Playwright's `install` resumes real-time flow until `pauseAt`, so
  "installed and running" and "installed and paused" are a deliberate choice.

### The readers (probed 2026-11-10, `packages/mesa`)

Every wall-clock read Mesa owns, and the clock verb it reads in Phase 2. Lines
are as of the probe. Not listed: `queueMicrotask`/`Promise.then` flushes
(`runtime.js:99`, `runtime-native.js:47/91/561` — microtasks, not time), the
dev-hook `ts`/`mountTime` labels (`runtime.js:5642/5663/5764`), the devtools
panel's own display (`mesa-vite/devtools.html`), Vite's cache-bust timestamp
(`mesa-vite/index.js:476`), `render-component.js:236`'s temp-file age check,
and `runtime-terminal.js:332`'s `new Date(0)` calendar constant.

| Site | What it is | Verb |
| ---- | ---------- | ---- |
| `runtime.js:2258` | `\|debounce` — `clearTimeout` then `setTimeout`; not cleared on destroy, so a pending one fires after unmount | `after`, with a cancel handle |
| `runtime.js:2271` | `\|throttle` — `Date.now()` against a `last` closure | `now` |
| `runtime.js:2476/2537/2563` | `fade`/`slide`/`fly` exit: `duration + 50` fallback if `transitionend` never fires; never cleared | `after` |
| `runtime.js:3144/3170` | virtual list: rAF coalescing `onScroll`, and a retry rAF until the parent connects; never cancelled on cleanup | `frame` |
| `keys.js:72/78/91` | chord-sequence deadline: `setTimeout(due, state.due - now)`, `Date.now()` into the pure matcher; cleared on teardown | `after` + `now` |
| `runtime-terminal.js:469/1100` | `<dialog>` close and `<details>` toggle dispatch on a 0 ms `setTimeout` (the browser's async event) | `after(0)` on the terminal source |
| `browser/clock.js:41–56/95/98` | `now({ every })`: epoch-aligned `setTimeout` then `setInterval`; `Date.now()` on tick and untracked read | `after` to align, `every`, `now` |
| `browser/datetime.js:34` | `createDatetime({ now: () => Date.now() })` | `now` (already injectable) |
| `render.js:61–62` | the server render copies happy-dom's real `requestAnimationFrame`/`requestIdleCallback` into `GLOBALS` | server source is a no-op, or the four stay a leak (2.3) |
| `drive.js:473/660` | in-page 10 ms `setInterval` polling the `ready` expression after load | stays real: it is how the drive learns the page is up (4.1) |
| `drive.js:554–582` | `settledCenter`: rAF + 50 ms fallback, `Date.now()` 500 ms cap, 50 ms settle after `scrollIntoView` | `frame`/`now`/`after` through the page clock (4.1) |
| `drive.js:595–605` | `waitFor`: Node-side `Date.now()` deadline, 50 ms sleeps between polls | the only Node-side `Date.now()` loop; 4.2 |
| `drive.js:282–298/325–393/680–696/814` | Chrome launch, CDP command timeouts, `close()`, `waitOnline` | stay real: harness waits a held clock would deadlock |
| `mesa-vite/inspect-client.js:255` | Alt+Z inspector defers behind the page's keydown, 0 ms | none: dev-only |

The native source arms no timer today; `after`/`every`/`frame` there are new in 2.3.

## Phase 1 — `$async.x.refresh()`

Goal: an async derived re-runs on demand with its cancel and latest-wins intact.
Done when: a compile test parses the output (Invariant 15) and a runtime test
shows refresh, pending-with-old-value and a stale reply dropped.

- [x] 1.1 Compiler: `.refresh` on a top-level `const x = await …`; RULE 16
  (`FJS-1720`) refuses it on any other name. **Done 2026-11-10**: refused on a
  function ("has `.for(key)`, not `.refresh()`"). Under `FJS-D2062` the two
  awaited-const emits are one `asyncDerived` call; a one-shot passes `null`
  deps, not `[]`, because `[]` already means "derived through an opaque local
  call" (`closeReactiveSet`), and `null` runs once untracked with an abort on
  unmount. Nothing in the corpus has a top-level awaited `const` (every one
  found is inside a function), so `before-refresh` and `after-d2062` are
  identical and only the new tests prove the emit; `compiler.test.js` asserts
  it exactly.
- [x] 1.2 Runtime: the rerun the dependency change already triggers. **Done**:
  one `run` closure in `asyncDerived`, `refresh` is `untrack(run)`, returns
  nothing; a refresh while pending starts a new run and the latest wins.
  `runtime.test.js` § asyncDerived, `async-function-state.test.js` § FJS-D2058.
- [x] 1.3 VISION §13 and `$async` docs. **Done**: §13.2 field list and a
  paragraph; RULE 16 blockquote; README's Async derived line.
- [x] 1.4 Move the framework's seq-token sites (`packages/`, `example/`) onto it.
  **Probed 2026-11-10: none of the eight is an async derived.** `CatalogList`,
  `Combobox`, `CommandPalette` are debounced searches with an empty-input reset;
  `Dns.read`, `Live.follow`, `Desk.peekAt` are loaders called on navigation, a
  stream, a cached peek; basecamp's `volumes` and `cleanup` `load()` are the
  closest — a one-shot `const` with a side effect, `await load()` after `remove`,
  and a shared `error`; even under `FJS-D2062` they are multi-step functions,
  not awaited consts. **Closed 2026-11-10: no site.** Phase 5 revisits each as
  a timer, not a derived.

## Phase 2 — One runtime clock

Goal: every timer Mesa owns reads one clock that each host supplies.
Done when: `bun run corpus -- --diff before` is identical, `bench/run.mjs --gate`
holds, and a test advancing the clock completes a transition and a `|debounce`.

- [x] 2.1 The clock in `runtime.js`: now, after, every, frame; the DOM source.
  **Done 2026-11-10**: `src/clock.js`, re-exported from `runtime.js`. `after`/
  `every`/`frame` return a cancel function, a trailing label names a timer;
  `clock.use(source)` returns the previous source, `use(null)` restores the DOM
  one, which reads the globals at the call. `virtualClock(start)` is the held
  source: `advance(ms)` is `runFor` (fire-time then creation order, `every`
  re-arms from its schedule, delay 0 inside a callback lands at +1, frames on the
  16 ms grid, a MessageChannel task between timers, the first thrown error
  rethrown at the end), `settle({ limit })` answers `{ settled, armed }` and
  counts an `every`'s firings toward the limit. `quietSource` arms nothing.
  `test/clock.test.js`.
- [x] 2.2 `|debounce`, `|throttle`, the transition waits and the
  `requestAnimationFrame` sites read it. **Done**: every row of § The readers
  that Mesa owns. Fixed on the way: the virtual list's scroll and retry frames
  are cancelled on cleanup (they rendered rows into a torn-down list). Still
  open: a pending `|debounce` fires after unmount — Phase 3 ties it to the owner
  with the declared timers.
- [x] 2.3 Terminal and native sources; the server render arms nothing. **Done**:
  terminal and native install nothing (their globals are the DOM source's;
  without rAF a frame is `after(16)`); `render.js` installs `quietSource` on
  both paths and restores in `finally` inside the render body, so a render with
  no `{#await}` restores before it returns (`FJS-D1647`). Under a held clock the
  terminal's 0 ms `<dialog>`/`<details>` dispatches wait for `advance`, which is
  the point. Corpus identical, `--portability server` 0 differ, bench gate held,
  browser runtime 218, terminal 470 assertions.

## Phase 3 — `$.after` and `$.every`

Goal: a declared timer torn down with its owner, re-armed by its key.
Done when: specs pin teardown, re-arm under a key, `when` gating, and no timer
armed in a server render.

- [x] 3.1 `$.after(ms, fn, { key, when })`. **Done 2026-11-10**: one
  `declaredTimer` behind `after`/`every` in `runtime.js`; top-level only
  (RULE 65, a compile error inside a function or as a value); returns nothing;
  the compiler wraps `ms`, `key` and `when` as getters, one effect reads them and
  re-arms only on a real change; `when` false cancels, a `key` change while
  paused arms nothing, `ms` is read at each arm; `onCleanup` ties it to the
  owner; labeled `'$.after'`/`'$.every'` for `settle`. `$$shared` carries them
  only when the sniff finds one, so the corpus is identical to `after-d2062`.
  A pending `|debounce` is now cancelled with its owner. `test/declared-timers.test.js`.
- [x] 3.2 `$.every(ms, fn, { key, when })`. **Done**, same owner; no fire on
  arm — `load()` beside it is the shape (no site asked for `immediate`).
  A server render on either path arms nothing (`quietSource`), proved.
- [x] 3.3 The raw-timer diagnostic Q3 rules. **Done** (RULE 66): a warning per
  name on `setTimeout`/`setInterval`, bare or on `window`/`globalThis`/`self`,
  in both scripts; `clear*` quiet. It turns `test/repl.test.js` red on 14
  examples until Q6 is ruled and the examples migrate (5.1). Upper bound on
  workspace `.mesa` files that will warn: 62 files / 87 calls by text.

## Phase 4 — The drive holds the clock

Goal: nothing moves between two drive operations.
Done when: a drive films a flash auto-clear and a poll by advancing the clock,
with no wall-clock wait in it.

- [x] 4.1 `drive.js`: `clock(ms)`, `clock('settle')`, `clock('real')`, as Q4 rules.
  **Done 2026-11-10**: opt-in `newPage({ clock: true | { at } })`; an init
  script (re-registered after every verb, so a reload the page triggers opens on
  the right time) runs `clock.js`'s text in the page, saves the native timers as
  `vc.native`, fakes `setTimeout`/`setInterval`/rAF/`Date`/`performance.now`
  over one `virtualClock` (ids from `1e12`; microtasks untouched) and sets
  `globalThis.__fjsClock`, which `clock.js` dispatches to after an explicit
  `use()` and before the DOM source — so Mesa's labels reach `settle`.
  `page.clock(ms)` is `runFor`; `clock('settle')` throws naming `armed` unless
  `allowArmed`; `clock('real')`/`'hold'` toggle a native 20 ms tick. `clock.js`
  has no import, asserted. `specs/clock.spec.mjs` (26) films a flash auto-clear,
  a poll, a plain-script interval holding still, `Date.now()`, `settle`
  throwing, real/hold and a navigation. Default stays real for every drive.
- [x] 4.2 ~~Replace `drive.js`'s `Date.now()` waits with the clock.~~ **Re-read
  2026-11-10**: every Node-side wait (`waitFor`, CDP timeouts, `close`,
  `waitOnline`) is a harness deadline and stays on real time, or a held clock
  hangs the drive. What 4.2 needed: the drive's own waits INSIDE the page (the
  `ready` polls, all of `settledCenter`) go through
  `globalThis.__fjsClock?.native ?? globalThis`. Done.
- [x] 4.3 The main page holds a clock too: `openChrome({ clock })`, so a held
  spec clicks through the trusted-input path (`t.clickAt`/`t.press`) instead of
  `el.click()`; `t.eventually` (`test/browser/drive.mjs`) and `mesaMount`
  (`test/browser/runtime/page.js`) read `__fjsClock?.native`, or they hang on a
  held page. `clock: true` is not the default for in-repo drives until 5.1 has
  migrated the sites. `Event.timeStamp`/`Temporal` are not faked until
  something reads them. **Done 2026-11-10**: `holdPageClock` in `drive.js` is
  the one registrar and verb set for the first page and every `newPage`, over
  the one `clockScript`; the handle answers `clock`. `t.eventually`,
  `mesaMount` and `mesaMountBare` poll on the native timers. `clock.spec.mjs`
  (33) opens a held first page, mounts, and films the flash and poll through
  `clickAt`. Off for every in-repo drive; `drive.d.ts` and
  `docs/browser-drives.md` § Holding the clock carry the option.

## Phase 5 — Migrate

Goal: the hand-written timers become declared ones.
Done when: the raw `setTimeout`/`setInterval` count in framework `.mesa` files
is 0 and the 14 raw `requestAnimationFrame` layout settles stay (not warned).

Surveyed 2026-11-10 (read-only, fixtures aside): **84 calls in 56 files** —
ui 20, basecamp/web 12, cli/console 6, haven 20, workbench/web 21, site-kit 1,
example 4. By class: 29 `$.every`, 22 `$.after` with `key`, 8 `$.after` with
`when`, 10 `$.sleep`, 15 not a timer (14 rAF, and `Toaster.mesa:66`'s
zero-delay DOM settle, which becomes `await $.sleep(0)`). Haven has no raw rAF
game loop; `Emotes.mesa` ticks on a stage-level `{ every: BEAT_MS }`. The
per-site table is the brief each migration agent gets. Settled on the way:

- **Handler-armed timers** (~25: flash auto-clears, debounces, hover intents,
  Form autosave, backoffs) have no top-level form under RULE 65, so each gets a
  state flag or counter the handler sets and `$.after` reads through `key`/`when`
  — the restructure is the migration, not a workaround.
- **Polls** (18, self-rescheduling after their body settles) become `$.every`
  with a `when`; `FJS-D2064` (Q7) makes an async body skip the tick it
  overlaps, so no site keeps an `inFlight` flag. A `Date.now() <= until` gate
  (`AppBackups`, `ReadOnlyCopy`) is not reactive and becomes a state flag.
- **haven `Study.mesa`** unrefs its terminal intervals so the TUI can exit: the
  terminal source unrefs every handle it arms, so a declared timer never holds
  a process open (`runtime-terminal.js` installs it; 2.3 had it install none).
- **workbench `home/index.mesa:123`** drops its remainder-of-minute first fire:
  `$.every(SLOW_MS, slowTick)` with `loadSlow()` beside it when the cache is
  older than `SLOW_MS`.
- **Test fixtures** (ui 9 files, example 1) migrate too — a fixture that warns
  is noise in every drive — with a stub's sleep as `$.sleep` (allowed in a
  function).
- **Islands** (`example/site` `LivePrices`, `BuyBox`, `CatalogList`) take the
  same compiler and runtime as a page component (`$$shared` carries
  `after`/`every` by the sniff, `$$runtime.island` hydrates with the same
  module), so they migrate like any site.

- [x] 5.0 `FJS-D2064` in `declaredTimer`: an `every` whose `fn` returned a pending
  promise skips the ticks until it settles (`finally` clears, `arm()` resets);
  the terminal source unrefs its handles. Owed case: `advance(3 * ms)` against a
  never-settling `fn` calls it once; a second advance after it resolves, twice.
  **Done 2026-11-10**: the skip, with a rejection still surfacing as unhandled
  and the timer ticking on; VISION §17 cites it. `runtime-terminal.js` installs
  `terminalSource` as it loads (a child process with a 60 s `every` armed
  exits at once, `test/terminal/specs/clock.spec.mjs`). `FJS-D2063`'s two
  corrections: `quietSource` answers a `'$.sleep'` at once, so `awaitBlock`
  renders its settled branch on both paths; `sleep`, `measure`, `viewport` and
  `focus` join the `<script module>` refusal. Corpus moved only `clock.mesa`
  and the two workbench routes; bench gate held.
- [ ] 5.1 `packages/ui`, `basecamp`, `workbench`, `cli` console, `haven`,
  `site-kit`, `example` — one package per agent, in the tree, sequentially.
  **ui done 2026-11-10**: 12 declared timers, 8 rAF stay, 9 fixtures moved;
  `bun run test` 2561 passing with the kit drive, 200 files compile with 0
  warnings. Form autosave keeps its timer handle's second job as an `_autoArmed`
  flag (`flushAutosave` and `_flushGone` read it), with an edit counter as
  `key`; Json, HoverCard and Combobox key on a counter because the value would
  not re-arm (same row copied twice, `pointerover` across a trigger's children,
  the same text asked again). Two MultiSelect edges accepted: `min: 0` fetches
  `''` at mount, and `_searchAll` latching on with text in the box fetches once.
  **basecamp/web done 2026-11-10**: 11 sites moved, `LogView`'s rAF stays;
  `verify:screens` 379/379. `Date.now() <= until` gates became a flag plus a
  `$.after` that clears it. Found: a declared timer above the `$:` its `when`
  reads is a ReferenceError at mount, not a compile error (`FJS-4145`).
  **cli/console done 2026-11-10**: 6 sites, `test:browser:console` all green;
  the CI poll is one `$.every` keyed on `!!ci?.active` so the cadence follows
  CI going live.
- [x] 5.2 `../fjs-prototypes`, each its own repo (serpgrid `requests/[id]`'s
  1.5 s elapsed tick first). **Done 2026-11-10** for every linked repo: 18 of
  19 at 0 raw calls, every changed file compiling with 0 warnings under this
  tree's compiler and acorn-parsed, all uncommitted in their repos; charter's
  only hits were frozen rig output under its gitignored `apps/`, dropped from
  the count. Owed a browser pass: intake `triage.mesa`'s Approve/Undo (the item
  now rides in `pending`), serpgrid's Composer flash, locations coalescer and
  chat debounces (serpgrid has no drive). Counted 2026-11-10: 82 raw calls in 19 repos
  (ela 22, serpgrid 11, portal 6, intake 6, sstime 5, remnant 5, quo 5, immich 3,
  chat 3, then 1–2 each). **ela and portal are not linked** — they install the
  published `@frontierjs/mesa` (0.1.12 and 0.1.9), whose compiler passes
  `$.after(...)` through and whose runtime has no `after`, so a build succeeds
  and the page throws at mount. ELA's 22 sites are migrated 2026-11-10 and
  compile clean under this tree's compiler (0 warnings, acorn-parsed), left
  UNCOMMITTED: **ELA must not release until its Mesa is bumped to a release
  with `FJS-D2059`–`D2064`.** Portal waits for the same bump before touching.
