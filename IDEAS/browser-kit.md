---
id: browser-kit
status: proposed
dated: 2026-10-14
---

# Idea — Browser kit: the ten browser APIs every app wraps by hand, wrapped once as signals

**Status: PROPOSED.** Dated 2026-10-14; architecture added 2026-10-16. Nothing
here is built. Do not cite this file as describing behavior — see
`VERIFYING.md`. Every noun below is provisional until `decision-rules` has run
on it; the open questions are at the end and a ruling cites one by its `Q`
number.

**Trigger.** `calls-and-media.md` asked what makes *integrating an app with the
browser's media APIs* easy, and the same question applies to the rest of the
browser. A count on 2026-10-14 across the 21 prototype apps, `example` and
`basecamp` (`web/src` only, mockups excluded) found the same ten wrappers
written by hand in app after app, and two of them already written privately
inside mesa and sierra more than once.

---

## The claim

**Toolbelt cannot own this.** Its license is *pure functions, no I/O, no clock,
no globals* (`FJS-D26`, `packages/toolbelt/CLAUDE.md`), and every one of these
touches `window` or `navigator`. So each wrapper splits: **the pure half is
toolbelt's and most of those halves already exist** (`/datetime`, `/redact`,
`/mime`, `/geo`); **the stateful half is a signal, and the signal's home is
mesa** — the leaf, so `site/`, `widgets/` and `extension/` get it, which is the
same argument `calls-and-media.md` makes for its media kit. Sierra takes only
what needs config, the router or the session.

**One primitive sits under all ten.** Svelte 5's `createSubscriber(start)`:
`start` runs once while any effect reads the value and tears down when none do.
Mesa's `bindWindow` (`runtime.js`, `<mesa:window bind:prop>`) is that function
written for eight window properties; generalized, each wrapper below is about
ten lines. Svelte core ships exactly this plus `MediaQuery`, window signals,
`SvelteDate` and `SvelteURL`; VueUse's and solid-primitives' catalogs put
storage, media query, intersection and clipboard first. The field agrees on the
shape; the ranking below is the repo's own counts.

## The ten, ranked by demand

Counts are files. *Prototypes* is 21 apps under `fjs-prototypes`; *repo* is
`packages/` + `example/`.

| # | Wrapper | Evidence | Pure half (toolbelt) | Stateful half |
| --- | --- | --- | --- | --- |
| 1 | **Persisted preference** — `persisted(key, default)` | `localStorage` 82 prototypes, 68 repo; 25 distinct `*_KEY` constants; no namespace per app, no cross-tab sync, credentials mixed with preferences (`portal_token` ×17). `example`'s own config hand-prefixes two keys, `shop_theme` and `shop_token` | `/redact` already answers *is this key a credential*, so the wrapper refuses a token key by name — junction's `tokenStorage` owns tokens | signal + the `storage` event for cross-tab; sierra adds the app prefix from config. The theme switch (`sierra/src/theme`) is the one existing instance |
| 2 | **Clock** — `now({ every })` | 42 copies of `now = Date.now()` + `setInterval` + cleanup | `/datetime` `relative()` and `format()` exist | one shared interval per resolution, paused while the page is hidden (#8) |
| 3 | **Media query** — `media(q)`, `reducedMotion`, `colorScheme` | `matchMedia` 8 prototypes, 14 repo; the same four queries retyped as rems (`47.99rem`, `64rem`) | none — `@frontierjs/css`'s scale (sm 640 … 2xl 1536 px) was stated only in a `tokens.css` comment, so the retyped rems had no source to match; it becomes a table in `vocabulary.js` (Q3) | subscriber over `MediaQueryList`; `setScheme` in the theme switch is the first consumer |
| 4 | **Element observers** — `visible(el)`, `size(el)` | `IntersectionObserver` 18, `ResizeObserver` 7; mesa's `$$virtualEach`, sierra's islands loader, `prefetch.js` and `mcp/index.js` each hold a private copy | — | one shared observer per option set, delivered through mesa `attach()`; infinite scroll becomes `visible(sentinel)` → `resource.more()` |
| 5 | **Hotkeys** — `hotkey('<Mod-k>', fn, { scope })` | 9 app files and 15 kit components bind `document` keydown each their own way. `FJS-2611`'s Escape defects closed 2026-10-15 at each owner, so this is consolidation, not a fix | the chord parser `'mod+k'` → `{ key, mods }` | scope is the nearest delegation root (Invariant 11; `_delegateRoots` in `runtime.js` is the table); CommandPalette, Popover and Dialog consume it |
| 6 | **Clipboard, share, download** | `writeText` 6 repo + 12 prototypes; `download()` already sits in `ui/utils.js` — the precedent | — | `copy(text \| blob)` with the execCommand fallback, `share()` falling back to copy, `download` moved beside them |
| 7 | **Files in** — `pickFiles()`, `dropzone(el)`, `objectUrl(file)` | 25 files; the leaked object URL is `FJS-2474` | `/mime` `sniff` grades a name against its bytes — exists | object URL revoked on `onCleanup`; picker, drop and paste one shape; feeds the `attachments` bridge. `ui/dnd.js` is list reordering, a different gesture, and stays |
| 8 | **Tab state** — `tab.online`, `.visible`, `.focused` | `onLine` 7 repo + 12 prototypes; `bindWindow` carried `online` only; sierra's `offline.js` and `pending.js` arm on the socket's `connect` and read neither, on purpose | — | one object, `watchProxy`-backed like `session`; #2 and the live store pause on it |
| 9 | **Head** — `title(fn)`, `meta()` | `document.title` 12 (serpgrid: three copies of one suffix pattern); `<mesa:head>` exists for fragments | — | sierra: per-route title with the app suffix from config; a no-op on the server |
| 10 | **Push and install** | 0 copies, because nobody can: `ecosystem-gaps.md` § 16 (push is a driver gap), `homestead.md` names the service worker | — | not a wrapper but a rig: service-worker registration in sierra's postbuild and `PushManager.subscribe` → the notifications package's channel list. Highest ceiling, most work |

**Below the cut, named so they are not relitigated:** geolocation (3 copies,
`/geo` is the pure half, a `position()` signal is #8's shape and lands with
it); `BroadcastChannel` (rides #1's cross-tab half); View Transitions
(`list-motion.md` owns them); print, fullscreen, wake lock, vibrate (zero
demand). **Media capture is its own kit** by `calls-and-media.md` and is not in
this list.

---

## Architecture

### Where it lives, priced

Three homes were priced. The question is not *which is cleanest* but *which
one a developer predicts from what mesa already does*.

| Home | What it costs | What it buys | Verdict |
| --- | --- | --- | --- |
| **A. `@frontierjs/mesa/browser`** — a subpath, `src/browser/` | one subpath, one line in `exports`, one drive dir | mesa's own `$$virtualEach` and `bindWindow` consume it by relative import (a package could not be: mesa is the leaf). It reaches every surface mesa reaches — `site/`, `widgets/`, jetty's `extension/`, through the dependency those already carry. **It is the pattern mesa already has**: `/runtime/terminal`, `/runtime/native`, `/drive`, `/vite` are each one host or one tool as a subpath | **Take it** |
| **B. `@frontierjs/browser-kit`** — a package beside `print-kit`, `email-kit`, `site-kit` | a package: `CLAUDE.md`, `README.md`, `PROJECT_STATE.md`, a CI row, an `exports.snapshot.md` row, a ring, a DRIVES row, and jetty's `file:` copy of mesa does not reach it | mesa stays a compiler + runtime | Refused for now. The three `*-kit` packages each carry a dependency or a server half (Chromium, an MJML replacement, a build). This kit has zero dependencies and ~10 lines per wrapper; a package is the heavier answer to the lighter thing. **The trigger that moves it out is named**: a dependency, a server half, or a second host implementation that `$$host` cannot carry |
| **C. Folded into `/runtime`** | nothing | one import | Refused. `runtime.js` is 6,262 lines and is what a terminal and a phone import too; a browser-only catalog inside it is paid by every host that cannot use it |

So: **the primitive goes in `runtime.js`** (host-neutral, every host's
subscriptions need it), **the ten go in `src/browser/`**, exported as
`@frontierjs/mesa/browser`, and **sierra adds the three that need config or the
router**, exported where sierra already exports the neighbor (`/theme`,
`/router`).

### The primitive — `subscribe(start)`

```js
// runtime.js — host-neutral. The one new reactive shape; everything in
// src/browser/ is this plus one platform API.
export function subscribe(start) {
  // start(update) runs when the first node reads, returns a stop; stop runs
  // when the last reader is disposed. update() bumps a version signal so
  // every reader re-runs. On a server render there is no reactive graph, so
  // track() is a plain call and start never runs.
  const [version, bump] = createSignal(0)
  const readers = new Set()               // per NODE, not per run
  let started = false, stop, v = 0
  const settle = () => { if (readers.size === 0 && started) { started = false; stop?.() } }
  return function track() {
    if (!_isClient || !_listener) return
    version()
    const node = _listener
    if (readers.has(node)) return
    readers.add(node)
    if (!started) { started = true; stop = start(() => bump(++v)) }
    onCleanup(() => { readers.delete(node); if (readers.size === 0) _resolved.then(settle) })
  }
}
```

Readers are a Set of nodes and the stop waits one microtask. An effect's re-run
clears its cleanups and reads again in the same tick, and a memo's recompute
does the same, so a count per run tore the listener down and started it again
on every update; a node gone for a whole microtask is gone.

Each wrapper is `subscribe` + a getter over the platform value:

```js
export function media(query) {
  const mql = isBrowserClient() ? window.matchMedia(query) : null
  const track = subscribe((update) => {
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  })
  return { get matches() { track(); return mql ? mql.matches : false } }
}
```

`bindWindow` is rewritten on it and `<mesa:window bind:prop>` keeps its
syntax: one subscriber per EVENT SET rather than per property, so every
`bind:innerWidth` and `bind:innerHeight` on a page is one `resize` listener.
`watchProxy` stays what `tab` and `session` are built from.

### The host rule — three environments, three answers

Mesa has three client hosts and a server render, and they are told apart today
by two flags: `_isBrowser` (a DOM is reachable) and `_isClient` (a reactive
graph is running). The terminal and native runtimes set `(false, true)`; a
server render sets `(true, false)`. **Every wrapper answers by that pair, and
the rule is one line each:**

| Environment | Flags | A wrapper's answer |
| --- | --- | --- |
| A browser tab | browser · client | the live value; `start` runs |
| A server render (happy-dom under `renderToHTML`) | browser · not client | **its default, subscribing nothing** — the page prerenders the same as it hydrates (`MediaQuery`'s SSR caveat, stated by name in each `.d.ts`) |
| A terminal or a phone | not browser · client | **a throw at the first call, by name**: `hotkey() has no terminal host`. A silent default here is a hotkey that never fires and an `online` that is always true, which is §V.9's wrong answer nothing reports. This is the rule `{@attach}` already lives by on a terminal (`FJS-2242`) |

`isBrowserClient()` is exported from `runtime.js` as the one spelling of
`_isBrowser && _isClient`, so a wrapper never reads a flag.

**Why the kit is named for the browser.** Half the list is host-neutral in
meaning — a clock, a hotkey, a persisted value, focus, a size — and a terminal
app (haven, `fli dev:tui`) wants each. They are not written host-neutral now
because the terminal's answers live behind `$$host` (`host/targets.js`) and the
storage, focus and resize seams there do not exist yet. **The names are chosen
so they port** — no `window` or `document` in any — and a terminal host is Q6,
answered when a terminal app asks, not before.

### The surface

```js
import {
  persisted, now, media, reducedMotion, colorScheme,   // signals, each a call
  tab,                                                // watchProxy object
  visible, size, dropzone,                            // attachments ({@attach})
  hotkey,                                             // listener, scoped
  copy, share, download, pickFiles, objectUrl,        // actions, Promise or value
} from '@frontierjs/mesa/browser'

import { title, meta, prefs } from '@frontierjs/sierra/router'   // #9, #1's prefix
```

**Four shapes, and a wrapper is one of them.** Knowing one teaches the next
(§V.4):

| Shape | Read as | Server | Example |
| --- | --- | --- | --- |
| **signal** — an object with getters, each read tracked | `persisted('rail').value`, `media(q).matches` | default | #1 #2 #3 |
| **object** — `watchProxy`-backed, like `session` | `tab.online` | defaults | #8 |
| **attachment** — `(el) => cleanup`, used as `{@attach visible(cb)}` | `{@attach visible(() => resource.more())}` | never runs (`attach()` is off the SSR path) | #4 #7 drop |
| **action** — a function returning a `Promise<Result>` or a value, never throwing for a missing API | `const r = await copy(text); r.via === 'execCommand'` | refused by name: an action has no server meaning | #6 #7 pick |

A `Result` is `{ ok, via, reason? }`: `via` names the path taken
(`'clipboard'`, `'execCommand'`, `'share'`, `'copy'`), so a fallback is
reported, never silent (§V.8). An absent API is `ok: false, reason:
'unsupported'`.

### The wrappers

```js
// #1 — a preference, never a credential
persisted(key, fallback, { parse = JSON.parse, format = JSON.stringify } = {})
  → { value /* get+set */, reset() }
// `key` is checked against /redact's credential predicate and a match THROWS
// by name: junction's tokenStorage owns tokens, and a token in a namespace
// nothing clears on sign-out is the failure. Cross-tab: `storage` event →
// update. A blocked or full localStorage warns once per key and holds a
// refused write in memory for the tab — the toggle works, it is not saved.
// The stored key is `${prefix}:${key}` and the prefix is sierra's (Q2):
// initRouter calls setPrefix(options.prefix), which virtual:sierra fills from
// config.prefix or the nearest package.json name; with no sierra, keys are
// bare. The prefix is read at every access, since a store module calling
// persisted() at import runs before the boot.

// #2 — one interval per resolution, parked while hidden
now({ every = 1000 } = {})  → { value }          // ms since epoch
// All readers of `every: 1000` share one setInterval, aligned to multiples
// of `every` since the epoch; it is cleared when tab.visible goes false and
// restarted (with an immediate tick) when it returns, so a tab brought back
// shows no stale minute.

// #3 — media
media(query)                → { matches }
reducedMotion()             → media('(prefers-reduced-motion: reduce)')
colorScheme()               → { value: 'dark' | 'light' }
breakpoint(name)            → media(css's query for `name`)         (Q3, Q8)
// Calls, not exported constants: a template read of an imported name
// compiles to a static value, so a module-level signal renders once — the
// reason sierra exports none (FJS-060). A component holds each in a `const`.

// #4 — observers, one per option set, pooled by a WeakMap on the options key
visible(cb, { root, rootMargin, threshold, once } = {})  → attachment
size(cb)                                                 → attachment  // cb(contentRect)
// cb(entry) is called with the observer's entry; `once` disconnects after
// the first true. The pool is keyed by the serialized option set, so two
// sentinels with the same options are one IntersectionObserver.

// #5 — a chord on the nearest delegation root
hotkey(chord, fn, { scope, when } = {})  → dispose
// chord: '<Mod-k>' | '<Esc>' | 'gd', vim's spelling (FJS-D1383); parsed by
// toolbelt /keys (keys.md 1.1). scope: an element; the listener goes on delegationRootOf(scope) —
// a new runtime export reading _delegateRoots — or on document when none.
// `<Mod-…>` is ⌘ on Apple platforms and Ctrl elsewhere. A chord fired inside an
// editable element is ignored unless the chord names a modifier. `when` is
// a getter; false means the binding is parked, not removed.

// #6 — out
copy(textOrBlob)            → Promise<Result>   // clipboard → execCommand
share({ title, text, url, files })  → Promise<Result>   // share → copy(url)
download(blob, filename)    → void              // moved from ui/utils.js

// #7 — in
pickFiles({ accept, multiple, capture } = {})  → Promise<File[]>
dropzone(cb, { accept } = {})                  → attachment   // drop AND paste
objectUrl(fileOrBlob)                          → string, revoked on onCleanup
// Each File is graded by /mime sniff against its name; a mismatch is in the
// returned list as `file.sniffed`, not thrown, since the caller decides.

// #8 — the tab. `page` is the router's (`FJS-D1122`)
tab   → { online, visible, focused }    // watched like session; one listener set, shared
// Armed by the first read, held for the tab. `online` is navigator.onLine —
// the interface, not the server; <mesa:window bind:online> is removed.

// #9 — the head (sierra, /router)
title(fn)   // fn() → string; the route's title with the app suffix appended
            // once; a no-op under prerender, where render.js already owns
            // the <title>
meta(name, fn)
```

### Layout

```
packages/mesa/src/
  runtime.js           + subscribe(start), isBrowserClient(), delegationRootOf(el)
                         bindWindow rewritten on subscribe
  browser/
    index.js           the surface; re-exports the files below
    persisted.js       #1  — setPrefix(), the credential refusal via toolbelt /redact
    clock.js           #2  — the interval pool, parked on tab.visible
    media.js           #3
    observers.js       #4  — the two pools; $$virtualEach imports this one
    hotkey.js          #5  — chord parser is toolbelt /keys (keys.md, pure)
    out.js             #6
    files.js           #7
    tab.js             #8
    result.js          { ok, via, reason } — one shape, one place
    browser.d.ts       the types; each wrapper's SSR answer is in its doc comment
packages/mesa/test/browser/kit/     one spec per wrapper on the shared CDP harness
packages/toolbelt/src/keys/         '<Mod-k>' → { key, mod }, and back (keys.md)
packages/sierra/src/router/head.js  #9; setPrefix(config.prefix) at boot
packages/ui/                        consumers: CopyButton, CommandPalette, Popover,
                                    Dialog, FileUpload, Form adopt the kit; utils.js
                                    loses download()
```

### What moves, what is removed

| Today | After |
| --- | --- |
| `bindWindow` eight listeners, `online` among them | `subscribe` over seven props; `online` is `tab.online` and `bind:online` is a compile error (`FJS-D1122`) |
| `$$virtualEach`'s own `IntersectionObserver` | `observers.js` pool, relative import |
| sierra `islands/loader.js`, `router/prefetch.js`, `mcp/index.js` observers | `visible()` / `size()` |
| sierra `theme/index.js` `localStorage` + `matchMedia` | `persisted()` + `colorScheme`; `theme.key` stays the key, the prefix comes off it |
| `ui/utils.js` `download()` | `browser/out.js` |
| 15 kit `document` keydown bindings | `hotkey()` |
| `FileUpload`'s object URL | `objectUrl()`, revoked |

### The drive

Mesa's browser drive on the shared CDP harness, one spec per wrapper, each
flipping the real condition: resize the viewport (`size`), emulate
`prefers-color-scheme` and `prefers-reduced-motion` (CDP
`Emulation.setEmulatedMedia`), `Network.emulateNetworkConditions` offline
(`tab.online`), a second tab writing `localStorage` (`persisted` cross-tab,
over `browser.newPage`), another tab activated with the drive's focus emulation off (`now` parks; `tab.visible` and `.focused` go false),
`Input.dispatchKeyEvent` chords (`hotkey`), a dropped file via
`DOM.setFileInputFiles` (`pickFiles`). The SSR half is one vitest file:
`renderToHTML` of a fixture reading every wrapper asserts defaults and that no
listener was added to the happy-dom window. **A wrapper with no drive is
`none` and lands as `none` in the spec table, not implied.**

---

## The nine (`PHILOSOPHY.md` § V), answered before any edit

1. **Origin** — each fact has one reader: the preference is the storage key,
   the time is one interval, the query is one `MediaQueryList`, the observer is
   one per option set. Today the private copies in mesa and sierra are a second
   origin for #4 and #8 and this removes them rather than adding beside them.
2. **Concept budget** — one new word, *subscriber* (the primitive); the ten
   wrappers are functions, not concepts, and carry the field's names. No
   dependency: everything here is the platform's own API behind a signal.
3. **Complexity** — the n-copies problem is the apps'; the subscriber is the
   one thing added, and without it each wrapper re-derives start/stop.
4. **Predictability** — four shapes (signal, object, attachment, action), each
   with one server answer, read with `$:` like `session` and `status`; an
   attachment is `{@attach}` like `drag` and `dndzone`. Knowing one teaches the
   next. The subpath is where mesa already puts a host.
5. **Derived** — the chord table, the credential predicate and the mime table
   are read from toolbelt, not restated; the prefix is read from config, where
   `shop_theme` and `shop_token` already imply it by hand. #3's breakpoints are
   read from css's `vocabulary.js` (Q3).
6. **Owner** — `bindWindow` is the existing owner of a window signal and is
   rewritten on the primitive rather than left beside it; `download` moves,
   it is not copied; junction keeps the token (`tokenStorage`); the theme
   switch keeps its own persistence until #1 lands, then reads #1; the
   delegation-root table stays in `runtime.js` and `hotkey` reads it.
7. **Boundary** — a caller gets a signal and never learns which event fires
   it; on the server every wrapper answers its default and subscribes nothing;
   on a terminal it throws by name rather than lying.
8. **Failure** — a credential key handed to `persisted()` is refused by name;
   a missing API falls back and says so in `Result.via` rather than throwing;
   storage quota or a blocked `localStorage` holds the write for the tab and
   saves nothing, which is a warning, since the page still works; a terminal call is
   a refusal, since a parked hotkey is destructive silence.
9. **Silence** — a wrapper that reports the wrong value nothing would notice.
   The artefact is § The drive: one spec per wrapper flipping the real
   condition, plus the SSR vitest asserting no listener on the server.
   `none` until each lands.

**Adjudications in tension** (§ IV): *batteries vs. smallness* — zero
dependencies and every wrapper is the platform's API, so the core grows by the
primitive only; *familiarity vs. precision* — the field's names (`persisted`,
`media`, `hotkey`) taken as is, because a developer arriving from VueUse or
Svelte should predict them; *paved road vs. the workaround* — the kit is the
road and the hand copy stays legal, graded by a `fli check` rule only once the
kit exists; *coherence vs. convention* — a `*-kit` package would match the
three kits' naming and is refused because the subpath matches what mesa does
with a host, and the mesa precedent is the nearer one. *Preservation vs.
evolution*: `bindWindow`'s `<mesa:window>` syntax is kept because it is a
compiler contract, its implementation is not.

**Tier** (§ VII): Assessment. A ruling on a `Q` below moves to the Register.

---

## Open questions

- ~~**Q1 — The home.**~~ **Answered 2026-10-16 (`FJS-D1097`): A, `@frontierjs/mesa/browser`** —
  priced in § Where it lives; B is refused with its trigger named, C with its
  cost.
- ~~**Q2 — Does #1 namespace by an app prefix from `sierra.config.js`, or by origin only?**~~ **Answered 2026-10-16 (`FJS-D1097`): a `prefix` key in sierra config**,
  defaulting to the app's `package.json` name — two apps on one dev origin
  (`FJS-740`'s world) otherwise read each other's preferences, and
  `shop_theme` / `shop_token` show the prefix being typed by hand today.
- ~~**Q3 — Where do breakpoints live?**~~ **Answered 2026-10-16 (`FJS-D1099`): a `breakpoints`
  table in css's `vocabulary.js`** — the scale was a `tokens.css` comment, now
  data; `breakpoint(name)` reads it and the vocabulary spec grades every
  literal `@media` width in css `src/` against it (Invariant 13).
- ~~**Q4 — Is #10 this plan's Phase 5 or `homestead.md`'s?**~~ **Answered 2026-10-16 (`FJS-D1099`): split** — the service worker is homestead's (release state),
  and this plan stops at the subscription half that hands a token to the
  notifications package.
- ~~**Q5 — Does `fli check` grade a hand-rolled `localStorage` or `addEventListener('keydown')` once the kit exists?**~~ **Answered 2026-10-16 (`FJS-D1099`): `warn`, scope `app`, only in an app that imports `@frontierjs/mesa/browser`**
  — the shape of `css-raw-literal`.
- ~~**Q6 — The terminal host. A clock, a hotkey, a persisted value, focus and size each mean something in haven and `fli dev:tui`. Lift them behind `$$host` now, or keep the kit browser-only and throw on a terminal?**~~ **Answered 2026-10-16 (`FJS-D1097`): throw now, lift when a terminal app asks** — the names
  already port, and a storage or focus seam in `host/targets.js` with no
  consumer is a seam nothing tests.
- ~~**Q7 — The `Result` shape for an action: `{ ok, via, reason }` returned, or a throw for `unsupported` and a plain value otherwise?**~~ **Answered 2026-10-16 (`FJS-D1097`): return** — a share button that cannot share must still copy, and the caller
  reads `via` to say *copied* rather than *shared*; a throw makes every
  caller write the fallback branch the kit exists to own.

---

- **Q8** — Where does `breakpoint(name)` read css's table? `FJS-D1099` put it in mesa reading `vocabulary.js`, but mesa is a leaf (*no framework-package dependency, ever*), and `vocabulary.js` is a classic script that exports nothing. Only the generated `vocabulary.json` (37 KB, now carrying `breakpoints`) can be imported. Found building 1.4.
  - **A** — sierra installs it, as it does the prefix (Q2): `virtual:sierra` reads `vocabulary.json` at build time and emits the five numbers, the router boot calls `setBreakpoints()`, and mesa's `breakpoint()` reads what was installed. A name off the table throws, listing the names; with no sierra it throws saying nothing installed one. Cost: a second setter beside `setPrefix`.
  - **B** — `breakpoint()` lives in sierra, over mesa's `media()`, importing `breakpoints` from `@frontierjs/css/vocabulary.json`. Cost: sierra gains a runtime dependency on css, the bundle relies on Vite tree-shaking a named JSON import, and the kit's surface splits across two imports.
  - **C** — drop `breakpoint()`: mesa ships `media()` and an app writes ``media(`(min-width: ${vocab.breakpoints.md}px)`)`` itself. Cost: the one `D1099` named — an app's off-scale `47.99rem` stays ungraded.
  - **Recommend A** — mesa stays a leaf, no JSON reaches the page, and the shape is one already in the tree (`setPrefix`), so a reader who knows how the prefix arrives can predict this. B charges every sierra app a css dependency for five numbers. Q9 under A: a table not installed throws at the first call, so it cannot be silently empty.

## Phases

### Phase 0 — Groundwork

Goal: the primitive, proved on the one window signal that exists.
Done when: `bindWindow` runs on `subscribe(start)`, mesa's browser drive still passes, and the subscriber's own spec shows `start` called once across two readers and torn down at zero.

- [x] 0.1 `subscribe(start)` in `runtime.js`, server-safe; `isBrowserClient()` and `delegationRootOf(el)` exported beside it — `test/subscribe.test.js`
- [x] 0.2 Rewrite `bindWindow` on it; `<mesa:window>` unchanged
- [x] 0.3 Rule Q1–Q7 — `FJS-D1097` (Q1, Q2, Q6, Q7), `FJS-D1099` (Q3–Q5)
- [x] 0.4 `src/browser/index.js` + `result.js` + `browser.d.ts` scaffolded, the `exports` line, the empty `test/browser/kit/` runner wired into `test:browser`

### Phase 1 — The signals

Goal: #1, #2, #3 and #8 — the four that are a signal and nothing else.
Done when: each has a drive on the CDP harness flipping the real condition, the SSR vitest shows defaults and no listener, and the theme switch reads #1 and #3 instead of its own copies.

- [x] 1.1 `persisted()` with the credential refusal and cross-tab sync; `setPrefix()` and sierra's `prefix` config per Q2 — kit drive `persisted` (15 rows); SSR half owed to the phase's vitest
- [x] 1.2 `tab` — online, visible, focused (`FJS-D1122`: `page` is the router's; `bind:online` removed, the compiler refuses an unbound prop) — kit drive `tab` (11 rows); SSR half owed to the phase's vitest
- [x] 1.3 `now()` on one interval per resolution, parked on `tab.visible` — kit drive `now` (15 rows); ticks land on multiples of `every`; parked by `watchPath(tab, 'visible')`, sierra `list.js`'s shape. `subscribe` now runs `start` with no owner and no listener: under the first reader's owner, the clock's watch was disposed when that reader unmounted while others still read (a row pins it). The kit drive now loads a fresh document per spec, since every wrapper holds its state for the tab; SSR half owed to the phase's vitest
- [x] 1.4 `media()`, `reducedMotion()`, `colorScheme()` — kit drive `media` (16 rows); one `MediaQueryList` and one listener per query. The two named queries are calls, since an exported signal object is static in a template (`FJS-060`). Css's `BREAKPOINTS` table landed in `vocabulary.js`, emitted into `vocabulary.json`, and `vocabulary: every @media width is on the breakpoint scale` grades every literal width in `src/`. `breakpoint()` moved to 1.6 behind Q8; SSR half owed to the phase's vitest
- [x] 1.5 The theme switch moved onto 1.1 and 1.4 — `initTheme` holds a `persisted(key)` (stored raw, since the `<head>` script reads it with `getItem`) and `colorScheme()` under one effect, so another tab's pick lands too; read in a tab only. The key is `prefix:key`: the `<head>` script restates the shape, pinned by a round trip in `prefetch-theme.test.js`, and the island entry calls `setPrefix`, since a static page has no router. `example` and `basecamp` drop their hand prefix (`shop_theme`, `basecamp_theme`) for the default `theme`. Found on the way: `tab.js` was built with `Object.defineProperties` at the top level, which a bundler keeps, so every import of the kit index shipped it — the router's `setPrefix` included. Now an object literal; sierra's bench spa and static floors are back under baseline
- [ ] 1.6 `breakpoint(name)` per Q3, reading the table as Q8 rules

### Phase 2 — The attachments

Goal: #4 and #5, and the kit components that stop binding `document` themselves.
Done when: `$$virtualEach`, sierra's islands loader, prefetch and the mcp panel read `visible()` / `size()`; CommandPalette, Popover and Dialog read `hotkey()`; the chord spec in toolbelt parses every chord the kit binds.

- [ ] 2.1 `visible()` and `size()` as attachments, one observer per option set
- [x] 2.2 Chord parser in toolbelt (`/keys`, `FJS-D1382`), `hotkey()` scoped to the delegation root — lands as `keys.md` 1.1 and 2.2, one engine the terminal shell also runs — kit drive `hotkey` (18 rows); the SSR half owed to the phase's vitest
- [ ] 2.3 Replace the four private observer copies and the fifteen keydown bindings

### Phase 3 — Out and in

Goal: #6 and #7.
Done when: CopyButton and FileUpload are built on the kit, `download` has one home, and `FJS-2474`'s leaked URL closes.

- [ ] 3.1 `copy()`, `share()`, `download()` returning `Result` per Q7
- [ ] 3.2 `pickFiles()`, `dropzone()`, `objectUrl()` revoked on cleanup; `/mime` sniff on each file
- [ ] 3.3 CopyButton, FileUpload, Form (`beforeunload`) on the kit

### Phase 4 — Head and the check

Goal: #9, and the rule that keeps the hand copy from coming back.
Done when: serpgrid's three title copies are one `title()` call, and `fli check` names a hand-rolled `localStorage` read in an app that has the kit (Q5).

- [ ] 4.1 `title()` and `meta()` in sierra's router, app suffix from config
- [ ] 4.2 The `fli check` rule per Q5
- [ ] 4.3 Sweep the prototypes onto the kit, counting what each phase removed

### Phase 5 — The push half

Goal: #10's subscription, the token handed to notifications.
Done when: a browser subscribes and a `notify()` reaches it as a push; the service worker itself is homestead's per Q4.

- [ ] 5.1 `pushSubscription()` → the notifications package's channel list
- [ ] 5.2 The drive: a notification delivered with the tab closed

---

## See also

- `calls-and-media.md` — the media kit this list leaves out, and the leaf-kit argument it shares
- `homestead.md` — the service worker and the precached shell (Q4)
- `list-motion.md` — View Transitions, left out here
- `ecosystem-gaps.md` § 16 — push delivery, the driver half of #10
- `packages/toolbelt/CLAUDE.md` — the purity license that splits every wrapper in two
- `packages/mesa/src/runtime.js` `bindWindow`, `_delegateRoots`, `setRenderEnvironment` — the window signal, the root table and the two flags the host rule reads
- `packages/mesa/CLAUDE.md` § Layout — the subpath-per-host precedent (`/runtime/terminal`, `/runtime/native`, `/drive`)
