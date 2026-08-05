# island-site — the static-target island fixture

A real Sierra app, built by a real Vite build, checked in a real browser. It
exists because the interesting claims about islands are all outside a test
runner.

```bash
# from packages/sierra
npx vite build --config tests/fixtures/island-site/vite.config.js
node tests/fixtures/island-site/verify.mjs
```

`verify.mjs` serves `dist/client`, drives it in headless Chrome, and **clicks
the buttons**. Needs Chrome on PATH or `$FJS_CHROME`.

## What it covers

| File | What it establishes |
|---|---|
| `src/routes/index.mesa` | Eight islands covering all five directives, beside static markup that must not be touched |
| `src/routes/plain.mesa` | A `render: static` page with **no** island — it must ship no JavaScript at all |
| `Counter.mesa` | `client:load`, and props crossing the marker: `start={7}` prerenders as `count: 7` |
| `Later.mesa` | `client:idle` really does mount, just later than `client:load` |
| `Seen.mesa` | `client:visible` for an island already in the viewport |
| `Below.mesa` | `client:visible` out of view — **its chunk must not be fetched until scrolled to** |
| `Narrow.mesa` | `client:media` with a query that matches |
| `Wide.mesa` | `client:media="(min-width: 5000px)"` — must never mount and **never be fetched** |
| `Styled.mesa` | Scoped CSS: it styles its own root, and no other button on the page |
| `Outer.mesa` / `Inner.mesa` | A **nested island** — `client:idle` inside `client:load` — and two more components with CSS |

## Nested islands

`Outer` is an island containing `<Inner client:idle />`. On the client there is
no nesting to honour: Mesa's `island()` short-circuits when it is already on the
client, so Outer's render calls Inner **directly** — live, in Outer's delegation
root, before Inner's own directive ever fires. The assertions that matter are
that Inner responds to a click (`Inner: 2` after two), that there is exactly
**one** `#inner` node afterwards, and that the loader logs **nothing** while all
this happens.

That last one is the point. Mounting Outer removes the range between its
markers, which is where Inner's markers live; Inner's scheduled callback then
finds them gone. It used to reach `mount()` with a detached anchor, throw, and
be logged as `<Inner> failed to load or mount` — a working island reported as
broken, on every page that nested one.

Three components carry CSS here (`Styled`, `Outer`, `Inner`), so the `<style>`
assertions pin ordering and not just the dedupe: three tags, three distinct ids,
one copy of each rule, and an order that matches the served HTML and survives
the late mount after the scroll.

## Why a click and not a snapshot

The failure mode this guards against is silent. An island mounted with a bare
`Comp(anchor, props, null)` instead of `mount(...)` renders **byte-identical
markup** and registers no delegation root, so the page looks perfect and no
button works. `verify.mjs` was checked against exactly that mutation: with the
bare call, `prerenderedCounter` and the static assertions still pass, the
console stays empty, and only the two click assertions fail.

That is the same trap that left all 59 Mesa REPL examples rendering correctly
and responding to nothing.

## Two harness notes

**Mount is detected by element identity, not by a sleep.** Mounting replaces the
prerendered markup, so `$(id) !== originalRef` is the exact signal that an island
went live. A fixed delay is not: mounting is a dynamic import, and under headless
virtual time an early click lands on inert prerendered markup and reads as a
product failure. That cost an hour of chasing a `client:visible` "bug" that was
the probe clicking too soon — the chunk had been fetched and simply had not run.

**Resource timing is how splitting is proved.**
`performance.getEntriesByType('resource')` names the chunks the browser actually
fetched, which is the only way to show that a directive that never fires costs
nothing.

**The scroll happens FIRST, and `Below` sits in its own scroll container.** Both
are forced by headless Chrome. Under `--virtual-time-budget` the page gets a
rendering lifecycle around load and then effectively none, and
IntersectionObserver only delivers records during one — so scrolling late means
the record lands after the last frame that will ever happen, and a working
`client:visible` island reports as never mounting. Measured: scrolling after the
other probe work mounted it ~1 run in 5; scrolling before the first lifecycle,
5 in 5. Scrolling the *page* would then push `Seen` out of the viewport before
intersections are first computed, which is why `Below` lives in a 120px
`overflow: auto` box — IntersectionObserver measures against the viewport either
way, so it is the same test. The claim survives the reordering because what
proves it is the resource list **at the moment of the scroll**, not the clock.

## What it does not cover

- The dev server. Islands are a build-time path; `vite dev` serves the SPA, where
  every component is live anyway.
- Deeper nesting than one level, and a nested island whose parent never mounts
  (`client:*` inside `client:static`). Both are pinned in
  `tests/islands.test.js` against a hand-built DOM.

## Note on running the build

Pass the config **absolutely**:

```bash
npx vite build --config tests/fixtures/island-site/vite.config.js   # from packages/sierra
```

The Vite CLI resolves a relative `--config` against its own cwd, which is not
necessarily the directory you typed the command in. Getting this wrong produces
`Cannot resolve entry module index.html` — Vite looking for the app in the wrong
place, not a Sierra failure.
