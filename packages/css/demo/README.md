# Demo — Northwind Billing

The first thing in the repo to consume `@frontierjs/css`.

```bash
bun run demo          # → http://localhost:5173
```

It also opens straight from the filesystem — `demo/index.html` — because the
`@import` chain resolves over `file://`. The server exists for DevTools and
for testing on a phone.

## What it is

A realistic SaaS admin, not a component catalogue. `../guide/` already
shows every class in isolation; the point of this one is the opposite — to put
the vocabulary under the pressure of a screen that has to actually work, and
see what breaks.

That rule has exactly one exception, and it is quarantined to its own route
rather than allowed to soften the other five. See **Reference** below: two of
the 55 terms are not components at all, and the honest way to show them is to
say so rather than to stage a screen around them. Anything that needs a
caption to belong on a screen does not belong on a screen.

Five screens: Dashboard, Invoices, Invoice detail, Customers, Settings. Between
them they exercise the full Frame and Page tiers, both tab orientations, the
table with striped + toned rows composing, forms with native validation,
dialogs and drawers, toasts, and all seven themes. The invoices toolbar has a
density control — one number set on the Pane — which is the fastest way to see
that the third axis is real.

A sixth route, **Reference**, is the exception and says so on the page. It
holds the two terms a realistic screen cannot demonstrate honestly: Chip and
Surface are the two *lineages*, and you never choose them — you choose a
Button and get the chip lineage with it, or a Card and get Surface. The
guide's wizard refuses to offer them for the same reason. Putting them on a
working screen would teach that they are ordinary components.

It earns its place rather than being a dumping ground, and that is
measurable: with the Reference route removed, coverage across the five
screens is 52 of 54, and the two missing are exactly Chip and Surface.

**All 54 vocabulary terms appear across the six routes**, and each route's
footer says which of them are on it. That number is *derived* — see below —
so it cannot claim coverage the page does not have.

Three files:

| File | What it is |
|---|---|
| `index.html` | markup only — the structural half of the system, followed strictly |
| `demo.js` | the behavior the package refuses to ship (Principle 6) |
| `demo.css` | **a measurement.** Every rule in it is a gap in the package |

## The footer counts itself

Each route ends with *On this page* — the terms that route demonstrates,
grouped by tier, with a count. It is built by reading the live DOM and
matching it against `../vocabulary.js`, the same file the guide and the test
suite read.

A written list was the alternative and would have been wrong immediately. A
static scan of `index.html` misses **Toast** and **Progress** (created by
`demo.js` at runtime) and **Kbd**, **Text**, **Heading**, **Section** and
**Group** (carried by an element, with no class to search for) — seven terms
the page demonstrates and a hand-count does not see.

Two things in the derivation are judgement, and both were measured rather
than assumed:

- **The Frame tier is credited to every route.** App, Shell, Topbar, Sidebar
  and Screen are persistent by definition — scoping the scan to the active
  route would credit no route with the frame every route renders in.
- **Scanning `.shell` is the trap.** The Shell *contains* the Screen, so a
  scan of it sweeps up every route including the hidden ones, and all five
  pages report the whole vocabulary. Measured at 54/54 on every route, which
  reads as success. The frame roots are the ones *beside* the Screen; App,
  Shell and Screen are tested as ancestors instead. Correct behavior is
  28–35 per route, union 54.

## The behavior half

Principle 6 says visual treatment is a class and keyboard/focus/ARIA behavior
is a component, and every file header states the contract it expects. `demo.js`
is the other side of those contracts, in plain JS, no framework — which is
itself the test. If a contract needs more than a few lines of vanilla JS, it is
too demanding.

| Contract | Cost |
|---|---|
| Tabs — roving tabindex, arrows, Home/End, both orientations | ~30 lines, shared by horizontal and vertical |
| Dialog + drawer open/close | ~15 lines — `showModal()` supplies the focus trap, Escape, inertness and backdrop |
| Toasts | ~15 lines — the exit is a transition on `hidden`, so the JS sets the attribute and reclaims the node afterwards |
| Density | **~4 lines.** One `--density` on the Pane; the table, its cells, the bar above it and every badge in that bar follow, because it inherits |
| Routing + `aria-current` | ~20 lines |
| Theme switching | 1 line |
| Form validation | **0 lines.** `.field:user-invalid` is the whole implementation |

That last row is the strongest result in the demo. The form is `novalidate`,
nothing watches the fields, and an invalid input still turns its border, its
focus ring and its hint red — from one declaration in the package.

## What the demo found

Eight bugs, all in shipped code, none of which the 165-assertion suite caught,
because a test suite only asks the questions you already thought to ask.

**Fixed, with regression tests:**

1. **Every closed `<dialog>` rendered as though open.** The UA hides an
   inactive dialog with `dialog:not([open]) { display: none }`, and an *author*
   `display` beats a UA one at any specificity. The surface base sets
   `display: block` on every composite, `.dialog` and `.drawer` included. So the
   nav drawer, the filter drawer and the delete confirmation were all on screen
   at page load. `frame.css` already documents this exact trap for
   `.view[hidden]` — the lesson had just never been carried to the two
   composites that are real `<dialog>` elements.

2. **`.btn.ghost` and `.btn.raised` were silent no-ops.** The README lists
   `raised` / `outlined` / `ghost` as Treatments — "composes onto anything" —
   and `surface.css` honors all three. `buttons.css` implemented only
   `.outlined`, so a toolbar of ghost icon buttons rendered as a wall of solid
   primary blue. Same failure the v0.6 tone work fixed for tones: a Treatment
   only some components honor is not a Treatment.

3. **The `.switch` was squashed into a checkbox.** `form-core.css` documents
   `<label class="field-check"><input class="switch">` and then sizes every
   input in a `.field-check` to 16×16 at (0,1,1), out-specifying `.switch` at
   (0,1,0). The package's own documented markup rendered the one control whose
   entire affordance is its shape as a small round checkbox.

4. **A tone on a `.field-check` never reached the switch track.** `--bg-mix` is
   element-scoped; the checkbox already crossed that boundary via
   `--check-accent` and the switch had never been wired into it.

5. **The skip link smeared a shadow across every page.** Moved off-screen with
   a transform, but `--shadow-lg` paints 16px past the box — a faint gray band
   at the top of every page that had one. Found by zooming into a screenshot.

**Moved into core in v0.10** — these were the `demo.css` rules, reviewed and
promoted:

6. **Icons had no size outside a `.btn`.** An `<svg>` with no dimensions
   defaults to 300×150, so an icon in a nav link, a field addon or an alert
   destroyed the layout. Reviewing it turned up that the rule was *already in
   the package three times* — `buttons.css`, `pills.css`, `feedback.css` —
   hand-copied with three different sizes, two property spellings, and one
   missing the `[class*=" i-heroicons"]` branch, so a multi-class icon silently
   had no size there. Now `icon.css`: one rule, `--icon-size` per component,
   plus `.icon` as the Icon vocabulary term proper. **This forced the
   `.btn.icon` → `.btn.square` rename** — a breaking change, noted in the root
   README.

7. **No responsive visibility utilities.** `frame.css` collapses the sidebar
   below `md` and hands its contents to a drawer — but the button that opens it
   has to be hidden above `md`. The package created the need and had no way to
   express it. `frame.css` now ships `.sidebar-toggle`, scoped to that one
   contract rather than a general `.md-up` / `.md-down` matrix.

8. **`.field` was always `width: 100%`.** Now `--field-inline-size`, defaulting
   to `100%`.

9. **No text size scale.** This one was never in `demo.css` — it showed up as
   `style="font-size: .8125rem"` written by hand **fourteen times**, which is
   what a missing utility looks like from the outside. Principle 3 already
   promised "visual size via utility classes"; `.h1`–`.h6` were half of it.
   Now `.text-xs` … `.text-xl`.

**Withdrawn — not a gap after all:**

10. Five `style="margin-block-start: 1rem"` overrides. On review these were all
    sibling blocks in a container I had forgotten to make a `.stack`. Wrapping
    them removed every one. The package was right; the demo author was lazy.
    Worth recording because it is the failure mode of this whole exercise — a
    measurement only means something if you check that what it measured is real.

**Not a bug, but a naming inconsistency worth a decision:**

11. The drawer's edge variants are `.from-left` / `.from-right` / `.from-top` /
    `.from-bottom`. Writing the demo I reached for `.end`, because `.bar` uses
    `.start` / `.center` / `.end` and the rest of the package is written in
    logical properties throughout (`inline-size`, `border-inline-end`,
    `margin-block`). The drawer is the one place that is physical, and it reads
    as an exception you have to remember. `.from-inline-end` is a mouthful, but
    two vocabularies for "which edge" is worse. Folds into the scoped-modifier
    naming decision that is already open.

**Found by covering the whole vocabulary:**

12. **Both Feeds rendered with no timeline.** The demo wrote
    `<li class="feed-item">`, collapsing the two elements ANATOMY keeps
    apart. The connecting line is drawn by
    `.feed > li:not(:last-child) .feed-item::after` — a *descendant*
    selector — so the collapsed form matches nothing: measured at
    `content: none`, zero height, a column of dots and no line between
    them. The same defect was in the guide's Learn wizard (`FJS-130`), and
    neither could be seen by any check that asks whether a class is
    present. The `<article>` inside the `<li>` is load-bearing.

13. **A Popover needs two rules before the term is usable, and the package
    ships neither.** `.popover` is `position: absolute` with no inset, so
    without a positioned ancestor it anchors to the page, and without an
    offset it resolves to its static position centered *on* its trigger —
    measured at 265px tall, y = −39, hanging off the top of the viewport.
    `.tooltip-anchor` ships in the package and solves exactly this for
    Tooltip; Popover has no counterpart. These are the two rules now in
    `demo.css`, and unlike the sprite rule they are arguably a real gap:
    every consumer of a named term has to write them.

## What came out of the box

Worth stating, because the list above is all failures: after the v0.10 review,
`demo.css` was **one rule** — collapsing the SVG sprite, which is specific to
the sprite-and-`<use>` technique and deliberately stayed out of the package.
Covering the full vocabulary added **two more**, both Popover positioning
(finding 13). Three rules total, and the count is the point: it is what the
package makes a consumer write.

No layout scaffolding, no spacing utilities, no color, no component CSS, no
responsive work, no icon sizing, no type scale. The frame, panes, cards, tiles,
table, feed, steps, facts, forms, overlays, navigation and all seven themes come
out of the package as-is, and the markup in `index.html` follows the vocabulary
without fighting it. Most inline `style=` attributes that remain are token
assignments — `--avatar-size`, `--field-inline-size` — which is the intended
API rather than a workaround. The exceptions are the Skeletons, which take an
`inline-size` because a skeleton is shaped like the content it stands in for
and only the consumer knows that shape, and one `min-block-size` giving the
Center something to center within.

The one place the vocabulary came up short is that it has **no term for a
route** — the switchable top-level content of a Screen. `Pane` is a labeled
subdivision, `View` is a tab panel; neither is "the page you navigated to". The
demo used bare `<div data-route>` (the Group term) rather than inventing a
class, but a real router needs an answer.

## Honest scope

This is a demo, not a production consumer. It has no build step, no data, no
router, and no real users. It does not settle whether the vocabulary is *right*
— only that it is usable and that eight things in it were wrong. The blocker in
`PROJECT_STATE.md` still stands until something ships to real users.
