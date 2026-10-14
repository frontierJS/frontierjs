---
id: browser-kit
status: proposed
dated: 2026-10-14
---

# Idea — Browser kit: the ten browser APIs every app wraps by hand, wrapped once as signals

**Status: PROPOSED.** Dated 2026-10-14. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Every noun below is
provisional until `decision-rules` has run on it; the open questions are at
the end and a ruling cites one by its `Q` number.

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
| 1 | **Persisted preference** — `persisted(key, default)` | `localStorage` 82 prototypes, 68 repo; 25 distinct `*_KEY` constants; no namespace per app, no cross-tab sync, credentials mixed with preferences (`portal_token` ×17) | `/redact` already answers *is this key a credential*, so the wrapper refuses a token key by name — junction's `tokenStorage` owns tokens | signal + the `storage` event for cross-tab; sierra adds the app-id namespace from config. The theme switch (`sierra/src/theme`) is the one existing instance |
| 2 | **Clock** — `now({ every })` | 42 copies of `now = Date.now()` + `setInterval` + cleanup | `/datetime` `relative()` and `format()` exist | one shared interval per resolution, paused while the page is hidden (#8) |
| 3 | **Media query** — `media(q)`, `reducedMotion`, `colorScheme` | `matchMedia` 8 prototypes, 14 repo; the same four queries retyped as rems (`47.99rem`, `64rem`) | none — and `@frontierjs/css` names no breakpoint (Grid derives its count from width), so the retyped rems have no source (Q3) | subscriber over `MediaQueryList`; `setScheme` in the theme switch is the first consumer |
| 4 | **Element observers** — `visible(el)`, `size(el)` | `IntersectionObserver` 18, `ResizeObserver` 7; mesa and sierra each hold private copies (virtual each, islands loader, prefetch) | — | one shared observer per option set, delivered through mesa `attach()`; infinite scroll becomes `visible(sentinel)` → `resource.more()` |
| 5 | **Hotkeys** — `hotkey('mod+k', fn, { scope })` | 9 app files and 15 kit components bind `document` keydown each their own way; Escape closing the wrong dialog is `FJS-2611` | the chord parser `'mod+k'` → `{ key, mods }` | scope is the nearest delegation root (Invariant 11); CommandPalette, Popover and Dialog consume it |
| 6 | **Clipboard, share, download** | `writeText` 6 repo + 12 prototypes; `download()` already sits in `ui/utils.js` — the precedent | — | `copy(text \| blob)` with the execCommand fallback, `share()` falling back to copy, `download` moved beside them |
| 7 | **Files in** — `pickFiles()`, `dropzone(el)`, `objectUrl(file)` | 25 files; the leaked object URL is `FJS-2474` | `/mime` `sniff` grades a name against its bytes — exists | object URL revoked on `onCleanup`; picker, drop and paste one shape; feeds the `attachments` bridge. `ui/dnd.js` is list reordering, a different gesture, and stays |
| 8 | **Page state** — `page.online`, `.visible`, `.focused` | `onLine` 7 repo + 12 prototypes; `bindWindow` carries `online` only; sierra `offline.js`, the live store's reconnect and the vscode extension each ask again | — | one object, `watchProxy`-backed like `session`; #2 and the live store pause on it |
| 9 | **Head** — `title(fn)`, `meta()` | `document.title` 12 (serpgrid: three copies of one suffix pattern); `<mesa:head>` exists for fragments | — | sierra: per-route title with the app suffix from config; a no-op on the server |
| 10 | **Push and install** | 0 copies, because nobody can: `ecosystem-gaps.md` § 16 (push is a driver gap), `homestead.md` names the service worker | — | not a wrapper but a rig: service-worker registration in sierra's postbuild and `PushManager.subscribe` → the notifications package's channel list. Highest ceiling, most work |

**Below the cut, named so they are not relitigated:** geolocation (3 copies,
`/geo` is the pure half, a `position()` signal is #8's shape and lands with
it); `BroadcastChannel` (rides #1's cross-tab half); View Transitions
(`list-motion.md` owns them); print, fullscreen, wake lock, vibrate (zero
demand). **Media capture is its own kit** by `calls-and-media.md` and is not in
this list.

## The homes

```
toolbelt     the pure halves: chord parser (new); /redact, /datetime, /mime, /geo (exist)
mesa         subscribe(start) — the primitive; #1–#8 as signals and attachments (Q1 names the subpath)
sierra       what needs config or the router: #1's namespace, #9, #10's registration
ui           the consumers: CopyButton, CommandPalette, Popover, FileUpload, Form adopt the kit
```

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
4. **Predictability** — every wrapper is `subscribe(start)` + a signal, read
   with `$:` like `session` and `status`; an attachment is `{@attach}` like
   `drag` and `dndzone`. Knowing one teaches the next.
5. **Derived** — the chord table, the credential predicate and the mime table
   are read from toolbelt, not restated. #3's breakpoints are the one value
   with no source (Q3).
6. **Owner** — `bindWindow` is the existing owner of a window signal and is
   rewritten on the primitive rather than left beside it; `download` moves,
   it is not copied; junction keeps the token (`tokenStorage`); the theme
   switch keeps its own persistence until #1 lands, then reads #1.
7. **Boundary** — a caller gets a signal and never learns which event fires
   it; on the server every wrapper answers its default and subscribes nothing,
   so a page renders the same under prerender (`MediaQuery`'s SSR caveat,
   stated by name in each `.d.ts`).
8. **Failure** — a credential key handed to `persisted()` is refused by name
   (silent acceptance would be a token in a namespace nothing clears on
   sign-out); a missing API (`navigator.share`, `clipboard`) falls back and
   says so in the returned result rather than throwing; storage quota or a
   blocked `localStorage` reads as the default and writes nowhere, which is a
   warning, since the page still works.
9. **Silence** — a wrapper that reports the wrong value nothing would notice.
   The artefact is mesa's browser drive on the shared CDP harness: one spec
   per wrapper, flipping the real condition (resize the viewport, emulate
   `prefers-color-scheme`, go offline via CDP, write `localStorage` from a
   second tab) and asserting the signal moved. **A wrapper with no drive is
   `none` and lands as `none` in the spec table, not implied.**

**Adjudications in tension** (§ IV): *batteries vs. smallness* — zero
dependencies and every wrapper is the platform's API, so the core grows by the
primitive only; *familiarity vs. precision* — the field's names (`persisted`,
`media`, `hotkey`) taken as is, because a developer arriving from VueUse or
Svelte should predict them; *paved road vs. the workaround* — the kit is the
road and the hand copy stays legal, graded by a `fli check` rule only once the
kit exists. *Preservation vs. evolution*: `bindWindow`'s `<mesa:window>` syntax
is kept because it is a compiler contract, its implementation is not.

**Tier** (§ VII): Assessment. A ruling on a `Q` below moves to the Register.

---

## Open questions

- **Q1** — The subpath. `@frontierjs/mesa/browser` beside `/runtime`, or
  folded into `/runtime` since `bindWindow` already lives there?
  **Recommend `/browser`** — a page that never reads one pays nothing, and the
  server bundle of `/runtime` stays what it is.
- **Q2** — Does #1 namespace by app id from `sierra.config.js`, or by origin
  only? **Recommend app id** — two apps on one dev origin (`FJS-740`'s world)
  otherwise read each other's preferences.
- **Q3** — Where do breakpoints live? `@frontierjs/css` names none today and
  the apps retype `47.99rem`. **Recommend css names them** in `vocabulary.js`
  and #3 reads them, so the spec that already checks the vocabulary against the
  CSSOM grades the queries too (Invariant 13).
- **Q4** — Is #10 this plan's Phase 5 or `homestead.md`'s? **Recommend
  homestead's** — the service worker is release state, and this plan stops at
  the subscription half that hands a token to the notifications package.
- **Q5** — Does `fli check` grade a hand-rolled `localStorage` or
  `addEventListener('keydown')` once the kit exists? **Recommend warn**, on the
  pattern `ui-hazards` already uses for `window.confirm`.

---

## Phases

### Phase 0 — Groundwork

Goal: the primitive, proved on the one window signal that exists.
Done when: `bindWindow` runs on `subscribe(start)`, mesa's browser drive still passes, and the subscriber's own spec shows `start` called once across two readers and torn down at zero.

- [ ] 0.1 `subscribe(start)` in mesa, server-safe (no-op off the browser)
- [ ] 0.2 Rewrite `bindWindow` on it; `<mesa:window>` unchanged
- [ ] 0.3 Rule Q1–Q5

### Phase 1 — The signals

Goal: #1, #2, #3 and #8 — the four that are a signal and nothing else.
Done when: each has a drive on the CDP harness flipping the real condition, and the theme switch reads #1 and #3 instead of its own copies.

- [ ] 1.1 `persisted()` with the credential refusal and cross-tab sync; sierra's namespace per Q2
- [ ] 1.2 `page` — online, visible, focused
- [ ] 1.3 `now()` on one interval per resolution, paused on `page.visible`
- [ ] 1.4 `media()`, `reducedMotion`, `colorScheme`; breakpoints per Q3
- [ ] 1.5 The theme switch moved onto 1.1 and 1.4

### Phase 2 — The attachments

Goal: #4 and #5, and the kit components that stop binding `document` themselves.
Done when: mesa's virtual each, sierra's islands loader and prefetch read `visible()`; CommandPalette, Popover and Dialog read `hotkey()`; `FJS-2611`'s Escape case closes.

- [ ] 2.1 `visible(el)` and `size(el)` as attachments, one observer per option set
- [ ] 2.2 Chord parser in toolbelt, `hotkey()` scoped to the delegation root
- [ ] 2.3 Replace the four private observer copies and the fifteen keydown bindings

### Phase 3 — Out and in

Goal: #6 and #7.
Done when: CopyButton and FileUpload are built on the kit, `download` has one home, and `FJS-2474`'s leaked URL closes.

- [ ] 3.1 `copy()`, `share()`, `download()` with their fallbacks reported, not thrown
- [ ] 3.2 `pickFiles()`, `dropzone()`, `objectUrl()` revoked on cleanup
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
- `packages/mesa/src/runtime.js` `bindWindow` — the one window signal that exists
