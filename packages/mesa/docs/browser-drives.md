# mesa — the browser drives

Moved out of `CLAUDE.md` verbatim: what `test/browser/` is, and what bites when writing a spec there.

**`test/browser/` is where this package is run rather than described** — five
drives over one harness, shared with `@frontierjs/ui` (`drive.mjs`,
`probes.js`) and read by relative path because mesa is the leaf. The browser
under the runner is `src/drive.js`, which is published: a change to it reaches
every app's drive, so `drive/` pins what an app asks of it and the runner
never did — a kept `profile` read back after a relaunch — and
`test/drive.test.js` keeps the half that launches nothing. All five gate. A
collected test that opens Chrome is `test-not-hermetic` in `fli check`. What
bites:

- **A spec exports `run(t)`, not a suite.** vitest excludes `test/browser/**`
  for that reason; without the exclusion it collects eleven files and fails
  each one with *no test suite found*.
- **A fixture is a component**, because a slot cannot be expressed as a props
  object. Props reach it as JSON.
- **A spec that PASSES can still be the point, and it can also be lying about
  where to look.** `chained-derived` was written for a shape that misbehaved in
  a real screen (`FJS-512`) and passed here, so it was kept as the list of
  causes ruled out. It passed because a component-ROOT template has its
  whitespace collapsed and the real screen's blocks were one branch down, where
  it survives — the fixture reproduced the markup and not the position. Say in
  the header what a green spec pins; and when a spec cannot reproduce a real
  failure, suspect the frame around the shape before the shape.
- **Input goes through the pipeline** (`t.press`, `t.type`, `t.clickAt`). A
  dispatched `KeyboardEvent` moves no focus, types no character and dismisses
  no `[popover]`.
- **`t.eventually(expr, expected, label, ms?)`** for anything a state change
  produces — mesa flushes on a microtask. `ms` is for a round trip that is not
  one: a Vite update is **seconds**.
- **`t.allow(re)`** declares a page error the spec is provoking. Everything
  else still fails the run, including any `[Mesa]` console warning — the
  framework reports a render it survived but corrupted that way.
- **Two writes to one file within tens of milliseconds are ONE watch event.**
  Measured at 23ms apart: the second edit fired no `change` and arrived only
  when a later edit flushed it — which looks exactly like broken HMR. The Vite
  drive's `edit()` holds until the file has settled, so a spec never has to
  know; anything else touching files does.
- **The Vite drive edits a COPY** in a temp directory. An edit is what an HMR
  update is, and a drive that writes to the tree leaves it dirty when it
  crashes.
- **`each-unkeyed.spec.mjs` is the DEFAULT `{#each}` key written down** — the
  index, and the trade it makes: an unkeyed list can never collide, and a row
  that moves is rebound in place rather than moved, so its DOM state stays with
  the position. `each.spec.mjs` is the keyed half, where a reordered row must
  be the same NODE moved. Keying by the item was the default until `FJS-325`,
  and a duplicate value corrupted the reconciler beyond recovery.
- **No backticks in a probe's own comments.** Everything handed to
  `t.evaluate` is a template literal, so one backtick inside a comment in it
  ends the string and the spec fails to PARSE — which reads as the drive being
  broken rather than the spec. It has bitten twice.
- **A relay between two pages needs `browser.newPage(url, ready)`** — a second
  target with its own `evaluate`/`navigate`/`close`, whose errors land in the
  same array. `BroadcastChannel` is cross-document by definition, so one tab
  posting and listening proves nothing.
- **A drive over a page it does not own installs its probes with
  `bootstrap`** — a script CDP runs before anything else in every document.
  The REPL has nowhere to put one, and reaching for a probe that is not there
  reads as the page being broken.
- **Nothing the REPL defines is reachable from page scope** — it is one module
  script, so `encodeState` and the editor view are both invisible. Drive the
  buttons instead. `copyShareLink` writes the hash with `replaceState` BEFORE
  it touches the clipboard, which is what makes the share round trip assertable
  without a clipboard permission.
- **Wait on what CHANGED, not on the status word.** `#pvlbl` already says
  *running* before a click that loads another example, so an `eventually` on it
  returns at once and the assertion afterwards reads the example being
  replaced. Twice, in two specs.

## Holding the clock

**Opt-in per page: `browser.newPage({ url, ready, clock: true })`**, or
`clock: { at: <epoch ms> }` for a fixed start; **`openChrome({ clock })` holds
the FIRST page** the same way, and `browser.clock(verb)` moves it — the page a
spec reaches with `clickAt`/`press`, so a held spec clicks through trusted
input rather than an `el.click()` in the page. Every other page, and every
existing drive, runs on real time; no in-repo drive turns it on until
`IDEAS/mesa-clock.md` 5.1 has migrated the sites. The clock goes in as a new-document script
ahead of `bootstrap` and of every page script, so nothing arms a timer on the
native clock first — a timer armed there keeps its native handle and fires on
real time whatever the drive does.

**The verbs** (`FJS-D2061`, `IDEAS/mesa-clock.md` Phase 4):

- `await page.clock(ms)` runs every timer due on the way at its own virtual
  time, yielding a real task between them so a promise continuation settles
  (Playwright's `runFor`, not `fastForward`: a 100 ms interval fires ten times
  in `clock(1000)`). It answers the new now.
- `await page.clock('settle', { limit })` runs one-shot timers and frames until
  none is armed and answers `{ settled, armed }`. **An armed `$.every` or
  `setInterval` never settles, and `settle` THROWS naming it** — turn the poll
  off with its `when`, or pass `{ allowArmed: true }` to read `armed` instead.
- `await page.clock('real')` lets virtual time follow real time (a native
  20 ms tick); `page.clock('hold')` stops it. `page.clock()` reads now.
- A page opened without `clock` throws on any verb, naming
  `newPage({ clock: true })` or `openChrome({ clock: true })`.

**What is faked**: the page's `Date` (no-arg constructor and `Date.now()`),
`setTimeout`/`setInterval` and their clears (ids from `1e12`, so a native id is
told apart and clearing one does nothing), `requestAnimationFrame`/
`cancelAnimationFrame` (16 ms grid) and `performance.now()` (from the start).
Mesa's own `clock` reads `globalThis.__fjsClock` directly, so a declared timer
keeps its label — `settle` names `'$.every'`, a raw one `'setInterval(100ms)'`.
**Not faked**: microtasks and promises, `Event.timeStamp`, `Temporal`, CSS
animations and transitions, network. A held page still settles a `fetch`.

**The drive's own in-page waits use the native timers** —
`__fjsClock.native` (`setTimeout`, `setInterval`, `requestAnimationFrame`,
`Date`, …). The `ready` poll and `clickAt`'s settle wait go through it, or a
held clock would hang the drive; a spec proving time did NOT move waits on it
too, and so do `t.eventually` (`test/browser/drive.mjs`) and `mesaMount`
(`test/browser/runtime/page.js`). Node-side `waitFor` is the harness deadline
and stays on real time.

**A navigation keeps the clock**: every verb re-registers the script with the
current now and running state, so the next document — a reload the page does
itself included — opens on the same virtual time. `test/browser/drive/specs/
clock.spec.mjs` films a flash auto-clear and a poll this way, on a second page
and on a held first page through trusted clicks, with no wall-clock wait in it.
