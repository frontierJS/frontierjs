# css — package map

**`@frontierjs/css`** — the styling language of the framework (Invariant 13).
Semantics first: a **tone** (`danger`) and a **treatment** (`outlined`), never a
colour and never a utility class. Plain CSS, no build step required.

`bun run test` drives **headless Chrome** — needs Chrome on PATH or `$FJS_CHROME`.
`bun run demo` serves the guide on :5173 (`$PORT` overrides).

---

## Layout

```
src/
  index.css        the entry — @layer order is declared HERE
  foundation/      reset · tokens · tones · surface · layout · chip
                   reset.css is ONE rule in the first layer — `a:where([class])`
                   loses the UA underline, a bare `<a>` keeps it. The bar for
                   adding a second: a UA default actively fights a shipped term
                   AND the term cannot fix it itself
                   surface.css also owns the INTERACTIVE surface —
                   `:where(a, button)` on Card/Tile/Surface gets a cursor, a
                   1px lift and a tone-following border. Keyed on the element,
                   not a `.hover` class: an <a href> IS the interaction, so
                   the affordance cannot be misattached or forgotten
                   tokens.css owns TWO ladders now — --text-* and --space-*
                   — plus --density, the axis that multiplies the second
  components/      buttons · cards · tables · dialogs · drawers · popovers ·
                   tooltips · toasts · alerts · badges · pills · avatar ·
                   form-core · feedback · frame · icon · typography · code ·
                   overlays (how the whole Overlay tier enters and leaves)
  patterns/        nav · tabs · steps · lists · feed · facts · bars · disclosure
  a11y/            a11y.css · focus.css
  themes/          default · dark · midnight · forest · sunset · elite · basecamp
                   · notebook · press · field. press.css is the token-surface
                   probe — it changes face, scale, leading, density, rules, ring
                   and shadow shape and ships no selector of its own. field.css
                   is its dark counterpart, written for the pages a project
                   generates about itself; it is the reason
                   --heading-letter-spacing exists, and it clears AA on
                   --surface-raised for all seven tones (danger had to move)
  utilities.css    the deliberately small escape hatch
vocabulary.js      THE OTHER HALF — two exports, one subject.
                   VOCAB: 54 terms in 8 tiers, which element each is.
                   ANATOMY: which children 25 of them expect, 42 named parts,
                   one canonical markup block each — plus NOT_ANATOMY, the
                   hyphenated classes that are NOT parts and why.
                   Four readers: the guide's Vocabulary and Anatomy pages,
                   guide/search.js, and two specs
guide/             the reference — 50 pages, the thing to read before adding CSS.
                   guide.js is an ES MODULE (it imports glow); vocabulary.js,
                   decisions.js and search.js stay classic scripts because
                   test/run.js inlines them
guide/decisions.js the Learn wizard's routing tree — questions and near
                   misses. Every FACT about a term is read from vocabulary.js;
                   this file holds only what the reference cannot
                   The other Learn page is `Why this one` — the audit against
                   seven other frameworks, inside guide.js
guide/search.js    the ⌘K search: tokeniser, ranker, and the term entries built
                   from vocabulary.js. Also owns `slugify` — the section id and
                   the href a result builds to it must be one function
vocabulary.json    GENERATED from vocabulary.js, committed, shipped. The
                   consumer-readable half: the .js is a classic script and
                   exports nothing, so nothing outside the guide could read
                   it. Not built into dist/ — that is gitignored and wiped
                   every build, so an install from git would find it missing.
                   `bun run build:vocabulary` regenerates; the suite fails if
                   it drifts (vocabulary.spec.js reads a verdict the runner
                   computes by regenerating in memory)
build.js           optional dist/ bundle
build-vocabulary.js  vocabulary.js → vocabulary.json
test/run.js        the harness
```

---

## What bites here

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
  because relative colour syntax cannot read the surface a colour will land on;
  `dark.css`, `basecamp.css` and `field.css` do, and a new one that forgets is
  caught by `contrast:` / `code: every token clears AA in theme-*`, not by
  anything visual. code.css writes the clamp out per role instead of reading
  `--tone-ink`, because it needs six roles at once off six theme colours and
  `--tone-ink` is one tone per element.
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
  sees **45 rules** and finds neither lineage — an imported sheet is a
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
  ancestors. Correct is 28–35 per route, union 54.
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
  be** — a gutter centred against three lines sits opposite the SUBTITLE, so
  the switch is keyed `.item:has(.item-lead)`; a bare
  `.item { align-items: baseline }` fixes the palette and misaligns every
  badge-and-text row in the package. And **an `<li>` is block-level, so
  measuring the ROW cannot see a text block that failed to shrink** — the
  first shrink test passed against a build with `min-inline-size: 0` deleted,
  reporting 200px in both. Measure the child (409px inside a 200px row), and
  give the title `nowrap`, because wrapping text never exceeds its container
  and the question does not exist without it.
- **A box with one overflow axis set is not a box with one axis scrolling.**
  Setting `overflow-x` alone promotes the other axis from `visible` to `auto`,
  so `.tablist`'s sideways scroll plus `.tab`'s `-1px` underline bleed drew a
  **vertical** scrollbar on a horizontal strip — for four versions, because it
  reads as a stray widget in the corner rather than as a scrollbar. Found from
  outside, in litestone's Studio. Both axes are now stated in both directions:
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
  STATIC position, centred on its own trigger. The placement rules say
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
  with `Bootstrap` coloured as a keyword unless you say `txt`.
- **The compare page's worked example ships a live, UNSCOPED `<style>`.**
  `.brand { --bg-mix: #6d28d9 }` is injected with the section so the code
  sample and the preview are the same declaration — the claim being made is
  that one rule is enough, and scoping it would quietly weaken it. Nothing
  else in the guide uses `.brand`. `comparePage.init` then measures that
  button's contrast in the reader's browser; the colours must go through a
  canvas, because Chrome serialises the derived fill as `color(xyz-d65 …)`
  and reading those floats as 8-bit channels is wrong for every colour.

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
  (a colour changing) · `--motion-base` (a control changing shape) ·
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
  selector that was authored: `*, *::before, *::after` is serialised as
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
- **`#spacing` now rewrites to `#behaviour`.** The Spacing page documented a
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

## Proving a change

`bun run test`, then `example`: `bun run verify:ui` — the kit and the app render
on top of this.

The guide's data files ARE tested — `VOCAB` and `ANATOMY` against the CSSOM,
`decisions.js` against the vocabulary, `search.js` against both. The page
builders are not. What proves a change to those is a browser walk
— render every page, click every wizard path — driven by hand against
`bun run demo`. Two failures it has caught that nothing else could: three
sections silently dropped from `guide.js`, and a wizard path that led nowhere.
