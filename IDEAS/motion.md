---
id: motion
status: proposed
dated: 2026-11-14
---

# Idea — motion has three timing sources and no owner

**Status: proposed.** Prompted by [Wardic](https://wardic.dev/), a port of
Motion (formerly Framer Motion) to Solid. Probed against the tree 2026-11-14.
Claims marked *reading* come from the source and have not been driven.

Mesa animates an element entering and leaving, and `$.transition` animates a
whole change. Nothing in the framework animates a spring, a drag release or a
scroll position. The question is not which library to adopt. It is what owns
**timing** and **reduced motion** once more than one thing animates, because
today three things do and each one answers both on its own.

## 1. What exists

| Path | Where | Timing from | Reduced motion |
| --- | --- | --- | --- |
| `$.fade` / `$.slide` / `$.fly` | `mesa/src/runtime.js:2594` | literal ms defaults (200/250/220) written to `el.style.transition` | the `@frontierjs/css` guard (`tokens.css:901`) wins, because `!important` in a sheet beats an inline style. **No guard without the css package**, and `data-motion="still"` never reaches them because they read no token *(reading)* |
| `$.entrance({ in, out })` + `el.animate()` | 8 `@frontierjs/ui` components (Popover, HoverCard, Combobox, MultiSelect, CommandPalette, Toast, AlertProvider, ConfirmPanel) | each file's own numbers (Popover: 140 ms, `cubic-bezier(0.16,1,0.3,1)`) | **none.** A WAAPI animation is not a CSS animation, so `animation-duration: 0.01ms !important` does not touch it *(reading)* |
| `$.transition(fn)` | `runtime.js:2514` | the app's `::view-transition-*` CSS | none. The `*` guard does not match `::view-transition-*` (noted in `FJS-D1235`) |
| `--motion-*` tokens | `tokens.css:279` | four durations 120–200 ms, three easings | the guard plus `data-motion="still"` |

**Demand, measured:** of 51 apps in `../fjs-prototypes`, one uses a Mesa
animation path, and it is Portal's `BookmarkStage.mesa`. It does a hand-rolled
FLIP over `el.animate()` with its own `--stage-spring` (a `linear()` curve),
`--stage-move` and `--stage-morph`, read through `getComputedStyle`. **No
prototype imports Motion, GSAP or anime.js.** Every other animation in the
prototypes is a CSS `@keyframes`. The pull is real but small, and it comes from
the kit (8 components) more than from apps.

Already filed, and not repeated here:

- [`list-motion.md`](list-motion.md) covers a moved keyed row, which the
  reconcile owns. `FJS-D531` named it `$.flip`, and it is unbuilt. It also
  covers a keyed row's exit that may never play.
- `FJS-2257` / `FJS-D1235` (owed) ask what spring and travel tokens the kit
  adds.

## 2. Prior art

Wardic and Motion rows were read 2026-11-14 from the linked pages. The others
are from prior knowledge, and their links were not re-fetched.

| Who | Shape | What it teaches here |
| --- | --- | --- |
| **Wardic** ([guides](https://wardic.dev/guides/animate)) | Motion's `initial`/`animate`/`exit` props on Solid, engine on Effect, MIT | **Server-played entrances**: the server samples the same spring and tween and writes a CSS animation into `<head>`, and hydration takes over mid-flight, velocity included ([server-rendering](https://wardic.dev/guides/server-rendering)). **Reduced motion splits by key**: movement (`x`, `y`, `scale`, `width`…) snaps, while opacity and color still animate, with a per-animation opt-out for a spinner ([reduced-motion](https://wardic.dev/guides/reduced-motion)). **Features are à la carte**: hover 4 KB, drag 6 KB, layout 20 KB, lazy-loadable per page ([features](https://wardic.dev/guides/features)). **Layout** is measured at end of task, only when something flagged could have moved ([layout](https://wardic.dev/guides/layout)) |
| **Motion** ([animate](https://motion.dev/docs/animate)) | `animate(el, keyframes, opts)`; mini 3.2 KB on WAAPI, hybrid adds a JS engine; `scroll()`, `inView()` | Already the example in `entrance()`'s doc comment (`runtime.js:2525`): an `out` that returns `.finished` is exactly the `__mesa_exit` contract. It works with Mesa today and needs no change |
| **Svelte** ([svelte/motion](https://svelte.dev/docs/svelte/svelte-motion), [animate](https://svelte.dev/docs/svelte/animate)) | `animate:flip` in core; `Spring` / `Tween` as reactive values | Core owns only the move, which needs the reconcile. Springs are values, not element effects. This is the split `list-motion.md` already chose |
| **Vue** ([TransitionGroup](https://vuejs.org/guide/built-ins/transition-group.html)) | `<TransitionGroup>` applies a `move` class with FLIP | Same owner for moves: the list diff |
| **AutoAnimate** ([formkit](https://auto-animate.formkit.com/)) | One call on a parent; a `MutationObserver` animates add, remove and move | Moves without the reconcile cost an observer that guesses. That is `list-motion.md` § 1's argument against a userland FLIP |
| **The platform** | [`@starting-style`](https://developer.mozilla.org/en-US/docs/Web/CSS/@starting-style), [`linear()`](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear), [`animation-timeline`](https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline) | A spring is a `linear()` curve, so no solver is needed for a fixed spring (Portal already does it). Scroll-linked is CSS (`tabs.css:94` already uses `animation-timeline`). Entrances are `@starting-style` (`overlays.css` already uses it). What CSS cannot do is **retarget with velocity**: a drag release, or an interrupted spring |

## 3. The shape — three layers, no package

The `decision-rules` pass (2026-11-14) found that the options are layers, not
alternatives:

1. **In Mesa: only what needs the runtime or the compiler.**
   - One door for timing and reduced motion (Q1).
   - The moved row (`$.flip`, owned by `list-motion.md`).
   - Whether a prerendered element's entrance replays on hydration (Q2).
2. **Outside, through `$.entrance`: everything that needs physics.** Springs
   that retarget, drag, gestures and scroll-driven values come from Motion's
   `animate()` or the platform, with a guide recipe that passes the
   `--motion-*` tokens in. Mesa builds no spring solver and no gesture
   recognizer. That would be complexity of ours, and the problem's version
   already has a maintained owner.
3. **No `@frontierjs/motion`.** A package is a noun plus a dependency against
   the concept budget. Reopen when a second real app needs a retargeting spring
   that `$.entrance` plus Motion cannot express.

Wardic's whole surface (props, variants, presence, layout, gestures) is the
React/Solid shape: animation declared as element props. Mesa ruled the other
shape (`FJS-D132`): animation is an attachment built by a `$` helper. Wardic is
a source of mechanisms (server-played entrances, the reduced-motion split,
layout measured only when flagged), not of API.

## 4. Against the nine questions

| § V | Answer |
| --- | --- |
| origin | Timing has three origins today (tokens, helper literals, per-file WAAPI numbers). Q1 makes it one: the tokens, read at one door |
| concept | At most one helper in the existing `$` family (Q1 **C**) and no package. A spring is a token, not a concept |
| complexity | The problem's own: reduced motion for WAAPI cannot be done in CSS, and a hydration replay only the runtime can see. Physics stays outside |
| predictability | Knowing `--motion-enter` predicts what every kit overlay does, and `data-motion="still"` stops all of it |
| derived | Durations derive from tokens. Reduced motion derives from `reducedMotion()` (`mesa/src/browser/media.js`), which already exists |
| owner | Timing and reduced motion: the one door (Q1). Moves: `$$eachBlock`. Enter and exit: `__mesa_exit`. Physics: the library the app chose |
| boundary | `$.entrance`'s `in`/`out` signature is the boundary a library crosses, unchanged |
| failure | Cosmetic, except the hydration replay (Q2), which is a visible flash on every prerendered page that uses one |
| silence | Must stay true: under `prefers-reduced-motion: reduce` and under `data-motion="still"`, no kit component moves. Fails: a drive that emulates the media query, opens each of the 8 components and reads `getAnimations()`. Until then: none |

## Open questions

- **Q1 — Where do timing and reduced motion get decided for a WAAPI animation?**
  - **A** — `$.entrance` checks `reducedMotion()`. It skips `in` and resolves
    `out` at once. Small, but it kills an opacity fade too, which Wardic
    deliberately keeps.
  - **B** — each kit component checks for itself. Eight copies of the same
    rule, which is the drift this doc exists to end.
  - **C** — `$.animate(el, keyframes, opts)`, a thin wrapper over
    `el.animate()`. Duration and easing default to a named `--motion-*` token
    read from the element. Under reduced motion it snaps transform and size
    keys and keeps opacity and color, as Wardic does. It takes
    `respectReducedMotion: false` for a spinner. The 8 components and the
    three helpers route through it.
  - **Recommend C** — one owner for both answers. It also lets `$.fade`/`$.fly`
    honor `data-motion="still"`, and the reduced-motion split has a working
    precedent. Its name matches the WAAPI call it wraps.
- **Q2 — A prerendered element with `{@attach $.fade()}`: what happens on
  hydration?** *Reading*: the attachment runs on the client after the server
  has already painted the element visible, so it blinks to opacity 0 and fades
  back in. Phase 0 measures it first.
  - **A** — skip `in` for an element the client adopted rather than created.
    The page arrives settled and `out` still works.
  - **B** — Wardic's server-played entrance: the compiler emits the entrance
    as a CSS animation and hydration takes over. It plays before JavaScript,
    at the cost of a compiler path per helper.
  - **C** — nothing; document it.
  - **Recommend A**, and B only when a site asks for an entrance on first
    paint.
- **Q3 — Is a spring a token or a solver?** This is `FJS-D1235`'s ruling. Its
  option **B** (`--motion-travel` plus `--motion-ease-spring` as a `linear()`
  curve) covers every fixed spring in the tree. A retargeting spring stays a
  library call (§ 3.2). Rule `FJS-D1235` before Phase 1.

## Plan

### Phase 0 — measure the readings

Goal: every *reading* above is a measurement.
Done when: each step below records its result here.

- [ ] 0.1 Under emulated `prefers-reduced-motion: reduce`, open Popover and
  read `getAnimations()`. A running animation confirms the § 1 gap.
- [ ] 0.2 A prerendered page with `{@attach $.fade()}` on a static element:
  does hydration blink it (Q2)?
- [ ] 0.3 `data-motion="still"` on a subtree containing `$.fly`: does it still
  move?

### Phase 1 — one door for timing and reduced motion

Goal: tokens are the only timing source and reduced motion holds on every path.
Done when: the § 4 silence drive passes for all 8 components and the three
helpers.

- [ ] 1.1 Rule Q1 and Q3 (`FJS-D1235`).
- [ ] 1.2 Build the door Q1 chose, with defaults read from `--motion-*`.
- [ ] 1.3 Move the 8 `@frontierjs/ui` components and `$.fade`/`$.slide`/`$.fly`
  onto it.
- [ ] 1.4 Extend the reduced-motion guard to `::view-transition-*`.

### Phase 2 — moves

- [ ] 2.1 `$.flip`, per [`list-motion.md`](list-motion.md). It owns the steps
  and the drive.

### Phase 3 — hydration

- [ ] 3.1 Whatever Q2 rules, with a prerender drive that asserts no
  opacity-0 frame on an adopted element.

### Phase 4 — the outside layer

Goal: an app that wants physics has a verified recipe, not a dependency.
Done when: the recipe runs in a fence-tested guide page (Invariant 16).

- [ ] 4.1 `guide/runtime/animations.md` § Springs and gestures: Motion's
  `animate()` through `$.entrance`, reading `--motion-*`, plus CSS
  `animation-timeline` for scroll-linked effects.
