# CSS — Known constraints and quirks

> Moved from `PROJECT_STATE.md` (2026-10-09). Version tags (vX.Y) refer to the package version when written.

## Known constraints / quirks

### Artifact loader gotcha
The Claude artifact loader scans for `import 'pkg'` / `from 'pkg'` even inside
template-literal strings. Pedagogical import samples must obfuscate package
names via a unicode-escaped quote constant: `const Q = "\u0027"` then
`${Q}vite${Q}`.

### Tone limits on light hues
The 10/30/55 tinting recipe muddies very pale hues — why `secondary` is
dark/saturated across all themes.

### A rule that reads `--bg-mix` must sit on the toned element
`--bg-mix` / `--on-bg-mix` are registered with `@property … inherits: false`
in tones.css. Before that, a tone bled into every descendant that read it: an
untoned `.btn` or `.pill` inside `<div class="alert danger">` rendered red,
because `var(--bg-mix, fallback)` only reaches its fallback when the property
is unset on the element *and* every ancestor.

The cost is that a descendant can no longer read its ancestor's tone. Two
places needed that, and both now derive the value on the toned element and pass
it down as a normal (inheriting) property:

- **tables.css** — the `<tr>` computes `--row-tint`; the `<td>` reads it.
- **dialogs.css** — the `.dialog` computes `--dialog-header-*`; the header reads them.

Any new pattern that tints a child from a parent's tone must follow the same
shape. Browsers without `@property` (pre-Firefox 128) fall back to the old
inheriting behavior — leaky, but not broken.

### Feed timeline connector is geometry-sensitive
The connecting line (`top: 0.95rem; bottom: -1.25rem; left: 0.3125rem`) is tuned
to the dot geometry. Robust for typical content; worth eyeballing if entry
heights vary a lot or in the Elite theme (zero radii).

### ~~Three-way artifact sync~~ — resolved in v0.6
This used to say the source CSS, frontier-demo.html and the style guide each
carried their own copy, and a change had to be applied to all three. That is how
the guide ended up two versions behind — its embedded copy still had the
pre-v0.3 `--card-color` contract and the old 10/30/45%-black tone recipe.

**`guide/index.html` now `<link>`s the real `../index.css`** and keeps only its
own chrome (`guide/guide.css`), so it cannot drift again. The fix was possible
because the package stopped needing a build step; the copy existed to work
around UnoCSS.

frontier-demo.html still carries an inlined copy and is therefore stale. Either
regenerate it with `bun build ./index.css` or retire it — the guide covers the
same ground.

### Markup naming breaking changes
- `card-header` → `surface-header` (since v0.3). Old code needs renaming.
- `.btn.icon` → `.btn.square` (v0.10).
- **`.shell.fixed` → `.shell.viewport` (v0.10.1).** `fixed` is a core
  UnoCSS/Tailwind utility name, generated unlayered, so unlayered beat every
  layer and merely *installing* Uno turned the app shell into a
  `position: fixed` element. Measured, not theorised — see below.

### UnoCSS interop, measured (v0.10.1)
The package stopped *requiring* Uno in v0.6 and the docs then claimed it "no
longer cares either way". Measured against UnoCSS 66.7.5 + `presetWind3`, that
was false in four places. What is true:

- **The layer architecture does the right thing for free.** Uno's output is
  unlayered, everything here is layered, so every Uno utility beats every
  component — the escape hatch works with no ordering discipline.
- **`@unocss/reset/tailwind.css` flattens the package.** It is unlayered too,
  so it beats the components; `h1` 36px → 16px, `.btn` background →
  transparent, `.btn` padding → 0. **Load order does not help** — layer
  priority ignores it. Import the reset `layer(reset)`.
- **Three name collisions:** `container` (breaks `.container.narrow`),
  `text-xs…xl` (Uno's scale replaces this one), and `fixed` (now renamed).
  `table`/`tab` collide harmlessly.
- The verified recipe — layer order and a `blocklist` — is in README.md under
  *Using it with UnoCSS*, and on the guide's Install page.

### Solid fills may render slightly darker than the token (v0.6)
A tone used as a *solid fill* (btn, pill, badge) is luminance-capped so white
text clears 4.5:1. Ten of the 35 tone × theme combinations move, all subtly and
all hue-preserving — `#0d83dd` → `#0b78cb`, `#f4403a` → `#d93833`. Uniform XYZ
scaling is a scalar multiply on linear RGB, so chromaticity is exact and the
result never leaves sRGB gamut.

The other 25 are untouched, including every bright hue: those keep their color
exactly and take dark text instead, which is why Elite's lime stays lime. Ten
buttons use dark text; they are the yellows, limes and light oranges where that
is the conventional treatment anyway.

Surfaces, borders and text-on-surface still use the raw token — only solid fills
are capped. So `--color-primary` is unchanged everywhere it reads as a brand
accent; it is adjusted only where text has to sit on top of it.

To pin an exact fill, set `--tone-fill` — the knob the cap reads — and the text
follows. `--on-bg-mix` pins the text alone. Not `--_fill`: that is the capped
OUTPUT, and setting it leaves `--_on-fill` deriving from a color that is no
longer painted (`FJS-1192`, README § Which variables are yours).

### Surface variants now beat the tone tint (behavior change in v0.6)
`.raised` / `.outlined` / `.ghost` are declared after the tone recipe, so each
wins on the properties it owns. Previously they were declared *before* the
`:is(.primary, …)` tone rule at equal specificity and lost to it — a toned
`.outlined` card still drew a tinted background, and `.ghost` wasn't ghost at
all. Each variant keeps the tint on the parts it does render, so a toned
`.outlined` still gets a tinted border.

### A grid item needs `min-inline-size: 0` or it blows the layout out
Grid items default to `min-inline-size: auto`, so a wide child — a table, a long
`<pre>`, an overflowing flex row — pushes its grid track wider than the viewport
instead of scrolling inside itself. The whole app then scrolls sideways.

`.screen` sets `min-inline-size: 0` for exactly this reason; it is the single
line that stops a wide table taking the layout with it. Pair it with
`.table-wrap` so the table scrolls in its own box. Any new grid child that can
hold wide content needs the same.

### `!important` reverses layer order
Normal declarations resolve later-layer-wins. **Important declarations resolve
the other way** — an `!important` in the *first* layer beats one in the last.

This matters exactly once so far, and it is easy to get wrong. tokens.css has a
global reduced-motion guard that forces `animation-duration: 0.01ms !important`
on everything. That would freeze a spinner, which reads as a broken page rather
than a working one, so `.spinner` and `.btn.loading::after` get an exception:
1.6s and still looping — slow enough not to trigger vestibular symptoms, alive
enough to mean something.

That exception **has to live in tokens.css**, in the same layer as the guard.
Put it in feedback.css and the guard silently wins, because feedback.css is in a
later layer. Within one layer, specificity applies normally among important
declarations, so `.spinner` (0,1,0) beats `*` (0,0,0).

### Alias tokens must resolve at the use site
`--badge-radius: var(--btn-radius)` declared in `:root` looks like an alias and
silently isn't: the `var()` resolves once, against `:root`'s own `--btn-radius`,
and the resulting computed value inherits straight past any `.theme-*` override.
Elite squares off buttons and the badge stayed rounded.

The working form is a use-site fallback — `border-radius: var(--badge-radius,
var(--btn-radius))` on `.badge` — which resolves on the element, where the theme
override is visible. Any future "component X follows component Y's token" pairing
has to use the fallback form.

**It had already happened a second time.** `--ring: var(--color-primary)` sat in
`:root` through the whole of v0.6. Every theme overrides `--color-primary`; no
theme sets `--ring`; so **every focus ring in every theme was the default blue**,
and Elite's lime brand focused in navy-scheme blue. Nobody spotted it because a
blue focus ring looks like a focus ring.

`--ring` is now undeclared, exactly like `--badge-radius`, and every read is
`var(--ring, var(--color-primary))`. `focus.spec.js` walks all six themes.

The general rule, since this is now 2-for-2: **an alias token in `:root` is
always wrong.** If token A should follow token B, write the fallback at the use
site. There is no case where the `:root` form does what it looks like it does.

### Class names are global
The system has no namespace: `.center`, `.hover`, `.start`, `.end`,
`.item`, `.card`, `.field`, `.table` and the seven tone names are all global.
`.row` was already renamed to `.list-row` to dodge Bootstrap.

**The class taxonomy is the principle to resolve this against.** Treatment
classes are *designed* to be sprayed across arbitrary elements, so they carry
the highest collision risk and the strongest case for staying short and
unprefixed — a namespaced tone would defeat the purpose. Scoped modifiers carry
the least risk (`.icon` only ever appears next to `.btn`) but cause the most
confusion, because a short generic name implies free composition it doesn't
have. So the likely answer is not "prefix everything" but:

- **Treatment** — keep short and global; they are the vocabulary.
- **Element** — keep short; collisions here are real but rare and obvious.
- **Anatomy** — already effectively namespaced by their parent
  (`.alert-icon`, `.feed-dot`, `.surface-header`). Keep that pattern.
- **Scoped modifiers** — the actual problem. `.table.hover`,
  `.rows.divided`, `.items.menu` read as Treatments and aren't.

There are currently zero consumers, so renaming is free right now and won't be
later.

---


---

## What bites here — the full catalog

Moved verbatim from `CLAUDE.md`; the short list that stays there points here.

- **Three variable tiers and the name is the only thing carrying which.** A
  knob is set by a caller (`--bg-mix`, `--tone-fill`, `--surface-ground`,
  `--overlay-from`); a published one is read by a caller and is named in
  `README.md` or asserted by `tones.spec.js` (`--tone-ink`, `--tint-*`); a
  private one is a derivation step and carries `--_`. The tier is not a
  judgment call at the keyboard — before renaming or adding one, ask whether
  `README.md` tells an app to touch it, because `--tone-ink` and `--tint-*`
  both look internal and both are documented affordances with tests behind
  them. `tokens.spec.js` grades one owner per `--_`, no dead ones, and no
  published name gaining a private twin. It cannot grade an app reaching for
  `--_fill`; the mark is what warns (`FJS-1192`).
- **A stacking rung is `tokens.css`'s, and 0/1 are not rungs.** `--z-topbar`
  through `--z-skip-link` are one ladder in one place, ascending, each read by
  exactly one component. A component ordering two of its own parts inside a
  stacking context it just made uses 0 and 1 and stays off the ladder —
  `tokens.spec.js` allows exactly those two and a `var()`. `.dialog` and
  `.drawer` are `<dialog>` and sit in the top layer above every rung,
  including the skip link, so they have no number (`FJS-1191`).
- **`bun build` drops the `@layer` order declaration**, so `build.js` re-prepends
  it. A bundle without it cascades differently from the source — check the first
  lines of `dist/` output after any build change.
- **`getComputedStyle` goes stale after a class change** in headless Chrome.
  `el.matches()` and `document.styleSheets` report the new state while computed
  styles stay frozen at the pre-interaction values, and forcing layout does not
  help. To check a post-click style change, read the *rules that match the
  element*, not its computed style.
- **Headless Chrome delivers almost no rendering lifecycle after load** — set up
  anything behind `IntersectionObserver` before it, and do not wait on
  `requestAnimationFrame`.
- **A hyphen used to be the whole anatomy rule, and it was wrong five times.**
  `vocabulary.spec.js` treats any hyphenated class as Anatomy and skips it —
  which accepts `.alert-anything`, and mislabels `.code-inline` (an alias for
  the element), `.sidebar-first` (a modifier on Shell), `.skip-link` and
  `.visually-hidden` (a11y utilities) and `.list-row` (the Row term's own
  class). `ANATOMY` in `vocabulary.js` is the answer as data and
  `anatomy.spec.js` holds it: every part ships CSS **and does something where
  the markup puts it**, every anatomy class the stylesheet ships is claimed by
  exactly one term or excused in `NOT_ANATOMY` with a reason, and every markup
  block renders every part it claims. A part is OWNED once and BORROWED after
  — Card, Dialog, Drawer and Popover all take the Surface sub-regions, and
  listing them four times would say there are four headers.
- **The anatomy spec found the vocabulary lying about an element.** VOCAB said
  Tooltip is a `<div role="tooltip">`; the stylesheet's own anatomy comment,
  the guide twice and `@frontierjs/ui` all ship a `<span>` — and they have to,
  because `.tooltip` is chip lineage and `.tooltip-anchor` is an inline-flex
  `<span>`, so a `<div>` there is not phrasing content. The one element the
  vocabulary named was the one the anatomy could not legally contain.
- **`NOT_A_TERM` is in `vocabulary.js`, not in the spec.** It is the register
  of every shipped class that is deliberately not vocabulary, grouped by what
  it is instead — tone, treatment, density, scoped modifier, container,
  anatomy, heading. It moved out of `vocabulary.spec.js` when the guide's
  class index needed to answer *what kind of class is this*: a register only
  the tests can read is one the documentation has to guess at. **Do not
  re-declare it in the spec** — both are inlined into one page as classic
  scripts, so two `NOT_A_TERM` declarations is a SyntaxError that takes the
  whole suite with it.
- **New vocabulary is a design decision, not a class.** The vocabulary lives in
  `vocabulary.js` — one file, read by the guide AND by
  `test/specs/vocabulary.spec.js`, which checks BOTH directions against the real
  CSSOM. Shipping a class the vocabulary does not name now fails the suite, and
  the fix is a decision: name it, or classify it in `NOT_A_TERM` with a reason.
  The reverse claim ("all N terms ship CSS") was true for four versions while
  the forward one was false eighteen times — `table` had its own guide page and
  no term, and `chip`/`surface` were not in the list at all.

- **The code theme styles markup this package does not produce.** `glow()` in
  `@frontierjs/toolbelt` emits it; `test/run.js` imports glow, renders three
  samples and hands them to the page on `window.__FJS_GLOW__`, so
  `code.spec.js` asserts against the real thing. Hand-written markup that
  looked like glow's would pass while glow emitted something else.
- **A tone used as TEXT goes through a window; it is never painted raw.** A tone
  is tuned as a fill behind white text and mostly fails the other job — as low
  as 1.19:1 across the shipped themes. `--tone-ink` (tones.css) is that tone
  with its lightness clamped into `--tone-l-min`/`--tone-l-max`, hue and chroma
  untouched, and it is unset on an untoned element so `var(--tone-ink, X)` is
  how a rule says what it looks like with no tone. Clamped rather than blended,
  which is measured both ways: `--tint-ink`'s 55% toward `--ink` leaves
  `sunset`/`warning` at 4.05:1. **A dark theme must invert the window**,
  because relative color syntax cannot read the surface a color will land on;
  `dark.css`, `basecamp.css` and `field.css` do, and a new one that forgets is
  caught by `contrast:` / `code: every token clears AA in theme-*`, not by
  anything visual. code.css writes the clamp out per role instead of reading
  `--tone-ink`, because it needs six roles at once off six theme colors and
  `--tone-ink` is one tone per element.
- **A sibling combinator behind an `:is()` ancestor is paid for page-wide.**
  `:is(.card, …) > * + *` was tried against every element and marked every
  parent's children as sibling-dependent, so one DOM removal anywhere
  restyled the whole subtree under its parent — 300 ms a keystroke in a
  22,000-line `CodeInput` (`FJS-1621`). The same `* + *` behind a plain
  `.field-row >` measured free. Write the child as `:where(:not(:first-child))`.
  Find one with Chrome's invalidation trace, which names the selector's
  effect on the node (`Related style rule`), never by reading the CSS.
- **`theme-notebook`'s `--ink-mute` is 2.67:1 and under AA wherever it is
  text** — nine files use it. Pre-existing, `FJS-125`; the code theme reads it
  for comments and does not compensate.

- **The wizard must be able to reach every term.** `guide/decisions.js` routes
  to a vocabulary term and nothing else knows when it stops being able to. Ship
  a component and forget the wizard and `decisions: every vocabulary term is
  reachable` fails — the same both-directions insight as `vocabulary.spec.js`,
  and the reverse direction is again the one nothing else would catch.
- **The cheat sheet's Bases section reads the lineage out of the CSSOM, and
  the walk must descend through `@import`.** `index.css` is 44 imports and
  almost nothing else, so a walk that only descends into `@layer`/`@media`
  sees **only the imports** and finds neither lineage — an imported sheet is a
  separate `CSSStyleSheet` on the rule (`r.styleSheet.cssRules`), not a
  nested rule list. `findRule()`/`tokenValue()` already had that branch;
  a new walk that forgets it returns empty and renders a base with no
  members. The hand-written list it replaced had drifted: 13 of the 16 real
  members, silently missing `pagination-link`, `tooltip`, `avatar`,
  `step-marker` and `tile`. Anchor the match on a selector that is a WHOLE
  `:where(...)` opening with the base — `dialog:where(.dialog, .drawer,
  .surface):not([open])` in surface.css is the closed-dialog guard and would
  shorten the block lineage to three.
- **`.sg-lineage` was already taken.** The guide ships a lineage DIAGRAM
  (guide.css ~665) whose vertical variant is `.sg-lineage:has(.sg-lineage-base)
  { grid-template-columns: 1fr }`. A second component reusing those names
  matches that rule and silently collapses to one column. The cheat sheet's
  version is `.sg-basis-*` for that reason.
- **`demo/` is skipped for CSS and checked for MARKUP.** The runner's
  `SKIP_DIRS` keeps demo.css out of the shipped-stylesheet collection, which
  is right — that file is a measurement of what the package makes a consumer
  write. Its markup is not tooling: the demo claims to speak the vocabulary
  fluently and wrote `class="page"` on every pagination control, a class
  `nav.css` documents by name as deliberately NOT shipped, so the pagination
  rendered as raw UA links (`rgb(0,0,238)`, no padding, no radius) for as
  long as it existed. `demo.spec.js` closes it in both directions. Note that
  `run.js` must `escapeForInlineScript` the demo HTML *even though*
  `JSON.stringify` already quoted it — the demo carries its own `</script>`
  tags, and the parser ends the inline block at the first one regardless of
  the JavaScript around it; the spec then reads `undefined` and reports every
  term absent.
- **The demo's footer counts itself, and the obvious way to compute it is
  wrong.** Each route ends with the vocabulary terms on it, derived from the
  live DOM against `vocabulary.js` — a written list misses the seven terms a
  static scan cannot see (Toast and Progress are created by `demo.js`; Kbd,
  Text, Heading, Section and Group are carried by an element and have no
  class). The trap is the frame: scanning `.shell` to credit the persistent
  tier sweeps up the Screen it CONTAINS, hidden routes included, and every
  page reports the whole vocabulary. Measured at 54/54 on all five routes,
  which reads as success. Scan the roots BESIDE the Screen (`.topbar`,
  `.sidebar`, the dialogs, the toast stack) and test App/Shell/Screen as
  ancestors. The union is every term.
- **A wizard sample is markup nothing else owns, and four of them did not
  render.** `anatomy.spec.js` checks ANATOMY's canonical block; the wizard's
  is a second, smaller block in `decisions.js`, and the only check on it asked
  whether the classes it *does* write are shipped — a class you never write is
  never wrong. Feed wrote `<ol class="feed"><li><article>`: no `.feed-item`
  grid, so no dot column and no connecting line, which is the whole
  distinction between a Feed and a stack of Items. Steps omitted
  `.step-marker`, which draws the disc *and* the connector between discs.
  `decisions: a wizard sample writes the parts its term cannot render without`
  is the check. It resolves a borrowed part's optionality **through the owner**
  — `uses` is a bare class list and the `'optional'` flag lives on the term
  that owns the part, so reading `uses` as required reports all three Surface
  sub-regions against Card, Dialog, Drawer and Popover, which are right.
  Required parts only, because a wizard sample is the smallest thing that
  renders and demanding a `.surface-header` would teach that a Card needs one.
- **A treatment can be listed on the right term and written onto the wrong
  ELEMENT.** `.items.menu .item` puts the modifier on the CONTAINER, so
  `<li class="item menu">` renders a control that changes nothing. Five of the
  wizard's first treatment lists were wrong this way, and none of them are
  visible from the data — `decisions: every treatment it offers actually does
  something` asks whether the generated markup matches a rule it did not match
  before.
- **`allRules()` now descends into CSS nested rules, and did not before.**
  `surface.css` declares `&.raised` and `&.outlined` by nesting, and the walk
  was written around `@layer`/`@media` — so those rules were invisible to every
  spec that reads the CSSOM, and `.raised`/`.outlined` looked like classes the
  package does not ship. `allSelectors()` is the same walk with `&` resolved
  against its parents, for anything that wants to hand a selector to
  `matches()`.
- **There is no Menu term, and that is a ruling not an omission.** A dropdown
  menu is `.popover` + `.items.menu` + `role="menu"` and arrow keys, and the
  third part is not CSS — naming it would promise a keyboard contract the
  package cannot keep (same reasoning as Bar vs Toolbar). `@frontierjs/ui`'s
  `DropdownMenu` is that composition. The wizard routes to Popover and says so.
- **`.item` on a `<button>`/`<a>` gets a control reset; on an `<li>` it does
  not.** `.items :is(button, a).item` — scoped through `.items` on purpose,
  because `.items.menu .item` is (0,3,0) and a bare rule loses on a disabled
  row. Only the control parts: `.item` already owns display/align/gap, and
  restating them is exactly how the kit's copy drifted the gap.
- **`.item` grew an anatomy because the same four classes existed twice.**
  `.item-text` / `-title` / `-sub` / `-lead` in `lists.css`, all optional, so
  a one-line Item is untouched. The two copies they replace were the guide's
  ⌘K (`.sg-search-*`) and `@frontierjs/ui`'s CommandPalette (`.cp-row-*`), the
  second in literals no token or `.dense` could reach. Two traps came out of
  building it. **`.item` is `align-items: center` and a stacked Item must not
  be** — a gutter centered against three lines sits opposite the SUBTITLE, so
  the switch is keyed `.item:has(.item-lead)`; a bare
  `.item { align-items: baseline }` fixes the palette and misaligns every
  badge-and-text row in the package. And **an `<li>` is block-level, so
  measuring the ROW cannot see a text block that failed to shrink** — the
  first shrink test passed against a build with `min-inline-size: 0` deleted,
  reporting 200px in both. Measure the child (409px inside a 200px row), and
  give the title `nowrap`, because wrapping text never exceeds its container
  and the question does not exist without it.
- **`.tablist`'s edge fade is a scroll-driven animation, and headless Chrome
  never ticks it.** `--tab-fade-start/-end` read `0px` from `getComputedStyle`
  whether or not the strip overflows, so the spec asserts the animation is
  attached to a `ScrollTimeline` rather than a computed value. The two tokens
  are registered, so `tokens.css` § shadow tree resets them on `:host *` by
  hand. `.stretch` narrows by padding: a tab's inline padding is part of its
  min-content width, and `flex: 1` alone cannot shrink below it (`FJS-2383`).
- **A box with one overflow axis set is not a box with one axis scrolling.**
  Setting `overflow-x` alone promotes the other axis from `visible` to `auto`,
  so `.tablist`'s sideways scroll plus `.tab`'s `-1px` underline bleed drew a
  **vertical** scrollbar on a horizontal strip — for four versions, because it
  reads as a stray widget in the corner rather than as a scrollbar. Found from
  outside, in Litestone Studio. Both axes are now stated in both directions:
  the vertical variant needs `overflow: visible` and not `overflow-x`, or the
  hidden y-axis it inherits draws a horizontal bar instead. `components: a
  scrolling strip does not grow a scrollbar on the other axis` holds all four.
- **`.clamp-1/2/3` is a utility, and the two spellings are ordered on
  purpose.** `display: -webkit-box` is a whole box model, so the prefixed
  triple is the floor and `@supports (line-clamp: 2)` puts `display` back to
  `flow-root`. Reversing the blocks still clamps in Chrome, which is exactly
  what would make the lost fallback silent. It is a utility rather than
  anatomy on Item because a card description and a table cell want it too —
  and it ships at all because a snippet that grows makes a list jump as a
  query narrows, which is the list's failure, not the paragraph's.
- **`[popover]` is in the top layer, so a `position: relative` parent does
  nothing** — and `.popover-anchor` is the plain-element half, not a fix for
  that. The anchor gives a `.popover` a containing block AND a default
  placement (below the trigger, start-aligned; `.align-end` flips it), which
  is what made the term usable at all: absolute with no inset resolves to its
  STATIC position, centered on its own trigger. The placement rules say
  `:not([popover])`, so the stylesheet cannot place a top-layer popover
  against the viewport by accident. Anchor positioning is still the answer for
  a native one, and for any edge other than below.
- **`getComputedStyle` answers a USED pixel value for `top: auto` on a
  positioned element**, so "is this unplaced" cannot be asked by reading an
  inset — an unplaced popover reports `0px` or `-20.06px`, not `auto`. Ask
  the geometry, or ask whether the selector matches.

- **The compare page counts its own numbers.** `Why this one` derives every
  claim about THIS package from `VOCAB` and the live CSSOM at render time — a
  comparison page is the easiest place in a repo to leave a stale number,
  because nothing renders wrong when it rots. Numbers about other frameworks
  are dated and sourced instead, which is the closest available equivalent.
- **`code(src, 'txt')` skips the highlighter.** glow has no "plain" mode — an
  unknown language still gets the common-word rules — so a diagram comes out
  with `Bootstrap` colored as a keyword unless you say `txt`.
- **The compare page's worked example ships a live, UNSCOPED `<style>`.**
  `.brand { --bg-mix: #6d28d9 }` is injected with the section so the code
  sample and the preview are the same declaration — the claim being made is
  that one rule is enough, and scoping it would quietly weaken it. Nothing
  else in the guide uses `.brand`. `comparePage.init` then measures that
  button's contrast in the reader's browser; the colors must go through a
  canvas, because Chrome serializes the derived fill as `color(xyz-d65 …)`
  and reading those floats as 8-bit channels is wrong for every color.

- **A theme ships no selector, so every look is a token — and three of the
  four gaps were tokens that stopped at one element.** `--border-width` is
  the structural hairline (card, field, table, topbar, code block, tab
  strip); `--surface-shadow` is resting elevation on the Block tier, `none`
  by default, with `--shadow-*` the ladder above it; `--app-bg` /
  `--topbar-bg` / `--sidebar-bg` / `--dialog-bg` are the frame's grounds;
  `--space-*-base` is the ladder's shape. `theming.spec.js` measures each on
  a DESCENDANT of the element carrying the token, which is the only way the
  original defects are visible. Three rules came out of it:
  - **A default that is another token is a use-site fallback, never a `:root`
    declaration** — `--topbar-bg: var(--surface)` at `:root` resolves once and
    inherits past every `.theme-*`. Same alias trap as `--ring`.
  - **A token a THEME must reach cannot be declared on the component** —
    `.table { --table-border-width: var(--border-width) }` wins over the same
    token set on an ancestor, so it is read as `var(--table-border-width,
    var(--border-width))` at the two use sites instead. `--table-bg` and
    friends stay declared, because those are for a caller styling one table.
  - **What is drawn WITH `border` and is not a border does not scale** — a
    spinner ring, a tooltip arrow, a step marker's disc. Scaling geometry with
    the hairline distorts a shape. The one pair that must stay related is the
    tab indicator, which is `calc(var(--border-width) + 1px)` and bleeds by the
    strip's own weight: at 3px a literal 2px underline reads as a gap in the
    line.
- **Motion is four rungs and two loops, named for the job.** `--motion-fast`
  (a color changing) · `--motion-base` (a control changing shape) ·
  `--motion-enter` (overlays) · `--motion-slow` (a measurement moving), plus
  `--motion-spin` and `--motion-shimmer`. `theming.spec.js` sweeps every rule
  for a literal duration, with two exclusions that are the point rather than
  housekeeping: anything inside `prefers-reduced-motion` (the READER's setting
  — tokens.css crushes durations there and hands the spinner back a slower
  1.6s, and a theme must move neither) and any rule from a stylesheet with no
  `href`, which is the harness's own `transition: none !important`.
  **A spinner's easing is deliberately not a token** — `linear` at the use
  site, because a spinner that eases reads as broken hardware.
- **`--overlay-time` is read at the use site, never aliased at `:root`.**
  `:root { --overlay-time: var(--motion-enter) }` resolves once and inherits
  past every `.theme-*`, so a theme retuning the ladder would move everything
  except the overlays. It is `var(--overlay-time, var(--motion-enter))` in
  each declaration instead — which puts a comma INSIDE a transition segment,
  so a spec that splits the list on `,` cuts a segment in half and reports
  every property as missing its `allow-discrete`. `overlays.spec.js` splits on
  top-level commas only.
- **The focus ring's style is a fixed list, enforced by `@property`.**
  `--ring-style` is registered `syntax: "solid | dashed | double"`, so a value
  outside it is invalid at computed-value time and falls back to `solid`: a
  theme writing `none` gets a solid ring, not no ring. That is what makes the
  ring restylable without being weakenable — there is no spelling of "off",
  and `dotted` is excluded for the same reason `none` is.
- **A tone rendered as text goes through the window in BOTH ramps.**
  `--tone-ink` is the tone on `--surface`; `--tint-ink` is the 55% blend on
  `--tint-surface`, and it is clamped too — the blend alone put sunset's
  warning at 3.86:1. Three jobs, three checks in `contrast.spec.js`: a tone as
  a FILL, a tone as TEXT, and a toned BLOCK. They fail apart.
- **An unregistered custom property computes to its TOKEN STREAM.**
  `getPropertyValue('--space-2xl')` answers `calc(1rem * 1)`, so a test that
  parses a number off it is measuring the source text. Read a rung through a
  use site — set `padding-top: var(--rung)` on the element and measure that.
- **The space ladder is declared on `*`, and that is not a style choice.**
  `--space-sm: calc(0.5rem * var(--density))` at `:root` substitutes
  `--density` once, against `:root`, and inherits the resulting fixed length
  past every `.dense`. Silent, because the token still holds a good value —
  just the wrong one everywhere. Same mechanism `tones.css` uses for the
  tint ramp, and `space.spec.js` goes red in three places if it moves back.
- **A registration does not reach a widget's shadow root.** An `@property`
  rule in a shadow root's stylesheet is ignored, so every registered token
  is unregistered there, with no initial value and with inheritance on.
  `tokens.css` § *Inside a shadow tree* restores each by hand on `:host` /
  `:host *`. A new `@property` token needs its line there, and
  `shadow.spec.js` is what catches a missing one (`FJS-1989`). A token the kit
  only READS inherits the host page's value through the boundary, so each is
  reset to `initial` on `:host` as well (`FJS-2080`); the spec collects every
  `var()` name from the CSSOM, so a new read token fails it until it has a line.
- **`--align` is unregistered, and that is what lets a Bar split.** A
  registered property needs an initial value, and then `var(--align,
  space-between)` could never fall back. `.align-start` writes `normal`, not
  `start`: `start` on a Stack shrinks every child to its content, which is
  not the layout of a region nobody aligned. Overlays reset it, so a
  Popover's `.align-end` places the popover and not its text.
- **Spec helpers share one global scope.** Every spec is inlined as a classic
  script, so a top-level `function css()` in one spec replaces another's —
  the band spec's contrast test passed alone and threw in the full run.
  Prefix a helper with its spec's subject.
- **A tone does not inherit; density does.** That is the whole difference
  between the two axes, and both are deliberate: a danger Card must not turn
  its button red, and `.dense` on a Pane must reach every Card inside it.
  `@property` with `inherits: false` / `inherits: true` is where it is
  stated.
- **The package ships no `container-type`, and a test enforces it.**
  Inline-size containment means the box can no longer be sized by its
  contents — measured, a `.card` in a `.cluster` went from 83px to 42px, the
  width of its own padding, and the same in an auto-sized grid track. It
  also becomes the containing block for `position: fixed` descendants.
  Dialog and Popover are unaffected: the top layer escapes containment. So
  derived density is opt-in — the app writes `container: fjs / inline-size`,
  and the *named* query means nothing reacts to a container created for some
  other reason.
- **A bleed margin must be the same rung as the padding it escapes.**
  `.card > .surface-header` was `-1.25rem` against a `1.25rem` padding; once
  padding moves with density a literal stays put and every card inside a
  `.dense` region misaligns. Anything negative that mirrors a padding is
  `calc(var(--space-*) * -1)`.
- **Overlay motion is owned by `components/overlays.css`, not by the four
  components.** Each of them states only `--overlay-from`, its direction.
  `allow-discrete` fails by doing nothing at all, which is indistinguishable
  from the bug it fixes, so it is not something to restate per file.
- **You cannot measure a top-layer transition in this harness.** Measured:
  under `--virtual-time-budget`, opening a dialog reports opacity and
  transform through `getAnimations()`, closing one reports only the discrete
  pair, and `transitionrun`/`transitionend` never fire — not even for the
  entry that demonstrably runs. A Toast, not in the top layer, reports the
  whole lifecycle. `overlays.spec.js` therefore asserts the mechanism is
  DECLARED and says so at the top.
- **`test/run.js` turns every transition off globally** with an unlayered
  `!important`, so `transition-property` on a live node reads as the
  harness. Read the rule.
- **The CSSOM expands a shorthand and then refuses to split it.**
  `padding: var(--space-lg)` becomes four longhands that each answer `""`,
  so iterating `rule.style` reported 287 false positives. Read
  `rule.cssText`.
- **`tokenValue(prop)` looks a custom property up BY PROPERTY, not by
  selector, and that is not a preference.** The CSSOM does not hand back the
  selector that was authored: `*, *::before, *::after` is serialized as
  `*, ::before, ::after` — the redundant `*` is dropped — so an exact match on
  the written string finds nothing while the rule sits right there. That is
  what made the two-axes diagram render its tint ramp as no swatches at all.
  `getPropertyValue` is exact for a custom property in a way it is not for
  `gap`: a custom property is never a shorthand.
- **A guide page that documents source must READ the source.** Three of them
  were quoting `layout.css` and `typography.css` by hand and all three rotted
  the day those files started reading tokens — the page showed `gap: 1rem`
  for a rule that no longer said it, and nothing rendered wrong.
  `ruleText(selector)` in `guide.js` is the one reader. It parses authored
  `cssText`: iterating `rule.style` expands `gap: var(--space-sm)` into two
  longhands that each answer `""`, which prints as `row-gap: ;`.
- **`#spacing` now rewrites to `#behavior`.** The Spacing page documented a
  4px numeric scale the package never had and margin utilities it does not
  ship. Its subject was really *who owns the space*, which is what
  `How things behave` is; the ladder itself lives on `Density & space`.
- **The search corpus is HARVESTED, and the harvest shares `tagSections`.**
  `buildSearchIndex()` in `guide.js` renders all 51 pages into a detached node
  at idle after boot and reads the sections back out — a written index goes
  stale on the first heading anyone edits, silently, because a missing entry
  looks like a page with less in it. It calls the same `tagSections()` the
  live render calls, so a result's href and the id it lands on are produced
  once, duplicate-heading numbering included. Anything that changes how a
  section gets its id changes both by construction.
- **A title outranks any weight of body text, and that is tuned not guessed.**
  A guide repeats its own vocabulary constantly; rank mentions near titles and
  the answer to "card" is whichever page talks about cards the most. Frequency
  is a tiebreak capped at +5 — added because without it "dense" answered with
  a table's Variants section, which says the word once, above three sections
  of the Density page that are about nothing else.
- **`vocabClass(row)` is in `vocabulary.js` and is asked, never restated.**
  An absent fourth element means the lowercased term; an explicit `null` means
  the term has no class. A truthiness reading turns Heading into `.heading` —
  a class the stylesheet does not ship — and `vocabulary.spec.js` is what says
  so.
- **Eleven of the wizard's sixteen questions draw themselves; five must not.**
  `WIZ_SKETCH` in `guide.js` is 50 CSS wireframes, keyed by question and then
  by option, with the five omissions and their reasons in its own header — a
  Button and a Link are the same shape, and drawing them would say the choice
  is visual. Two traps, both measured: `align-items: center` on a sketch row
  collapses a `flex: 1` box to a hairline, and a fill mixed into `--rule`
  disappears against `--surface-sunken` — `--rule` is tuned as a hairline
  divider, so area fills mix into `--ink` instead.
