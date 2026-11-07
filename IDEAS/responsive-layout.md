---
id: responsive-layout
status: proposed
dated: 2026-11-07
---

# Responsive layout — the 80% without breakpoint classes

**Status: BUILT, uncommitted.** Dated 2026-11-07. Every phase is ticked and
driven (css 762, cli 4498, example 72/36/47, workbench atlas 99, basecamp and
ELA build, website verify); Q1–Q10 ruled (`FJS-D2020`–`FJS-D2030`), and Q9's
Booking rework (`FJS-D2029`) is built and driven: on a 1400px page the widget
is one column in a 320, 400 and 470px slot and two in 490 and 700 (stub API;
the real one was mid-rename). Do not cite this file as describing behavior —
see `VERIFYING.md`.

The want (owner, 2026-11-07): some version of Uno/Tailwind-style breakpointing
that covers most cases without going all the way to a utility matrix. FCSS
ships no breakpoint variant (`guide/README.md` § the footprint table), and
Invariant 13 keeps it that way; this paper finds what the apps actually write
at a width and pays for the common shapes once.

---

## What exists

- **Intrinsic layout already does most of the work.** `.grid` is Every
  Layout's Grid (`layout.css`, auto-fit over `--grid-min`); the Aside collapses
  under a Screen below md (`aside.css`); the shell's sidebar gives way to a
  drawer and `.sidebar-toggle` (`frame.css`). maidtech went from 340 Uno
  breakpoint classes in `my.maid.tech` to zero width queries across 103
  `.mesa` files.
- **The scale is `BREAKPOINTS` in `vocabulary.js`** — sm 640 · md 768 · lg
  1024 · xl 1280 · 2xl 1536. `FJS-D1099` ruled the widths stay literals and
  that a spec grades them; the spec covers `packages/css/src` only, and the
  `breakpoint(name)` reader `D1099` names is not built.
- **Container queries are opt-in by name.** The package ships no
  `container-type` (`packages/css/docs/quirks.md`, a test enforces it); derived density
  answers `@container fjs (inline-size < 30rem)` and `< 20rem`, two widths no
  scale names.
- **`frame.css` refuses a `.md-up`/`.md-down` matrix** as "ten rules of
  somebody else's design system", and ships one contract-tied class,
  `.sidebar-toggle`, instead.

## The sample

Every width `@media`/`@container` in `.mesa` and `.css` under `frontierjs/`
and `fjs-prototypes/`, copies of FCSS's own bundle (lynx-spike, litestone
studio) and email-client CSS excluded: **111 queries**, 67 outside the
marketing website. `node scripts/width-census.mjs` prints the Ported column
and the scale count; `--hides` lists the show/hide rows sorted below. Against
them, the 769 `sm:`/`md:`/`lg:` classes in the legacy apps the prototypes were
ported from (ELA, my.maid.tech, remnant-v1) — a one-time count, since those
apps are frozen.

| Shape | Legacy Uno | Ported (67) |
| --- | --- | --- |
| Columns become one below a width, with the spacing that flips with them | ~50% | 55% (37) |
| Show or hide | 19% | 21% (14) |
| Custom reflow — a header reordered, a row regridded | <5% | 19% (13) |
| Padding step-ups, sizing, type | ~30% | 4% (3) |

Only **56 of 111** widths are on the scale; the rest are 900px, 60rem, 62rem,
56rem, 52rem, 34rem, 30rem and their `-1px` twins. One page layout had no
collapse at all: `darkroom/web/src/routes/index.mesa`, a panel beside a stage
(fixed in 1.3). `charter/web/src/routes/apps/[id].mesa` looked like a second
but collapses in JS — `matchMedia('(min-width: 64rem)')` moves the chat into
a tab below 64rem, which the census cannot see because it reads CSS only.

**Show/hide by what it hides** (13, decoration excluded):

- **Master-detail, one pane on a phone** (4) — serpgrid chat and thread,
  quo's inbox contact pane, serpgrid's client rail.
- **Nav gives way to a toggle** (3) — workbench `.wb-nav`, sstime's topbar
  actions, the website's `.sitemenu`. The `.sidebar-toggle` contract, rewritten.
- **Secondary content drops out of a row** (6) — ELA's activity snippet,
  workbench laptop's row column, portal's bookmark url, Basecamp's own
  `.hide-sm`, workbench's search word, DatePicker's presets. Five of the six
  are a narrow component rather than a narrow screen.

**The cases a build is proved against**, one real file each:

| Shape | File |
| --- | --- |
| Fixed side, fluid main | `eventmark/…/schedules/Planner.mesa:177`, `ela/…/crm/ClientDetail.mesa:349` |
| Uneven split | `example/site/src/routes/index.mesa:295` (1.05 / .95 at 900px), `serpgrid/…/requests/[id]/index.mesa:397` |
| Column count at a width | `transit/fixtures/maid/reports/kpi-by-source/template.mesa:287`, `remnant/…/bible/Translations.mesa:170`, `example/web/src/routes/products/[id].mesa:483` |
| A child that must know the state | `ela/…/quotes/QuoteAside.mesa:132` (a rule only side by side), `website/…/tour/walkthrough.mesa:106` (sticky only side by side) |
| The container is the ruler | `calendly/widgets/src/Embeds/Booking.mesa:588`, `thod/…/reports/builder/[id].mesa:505` |
| Show or hide | Basecamp `_module.mesa:479`, workbench `_module.mesa:153`, `ela/…/panel/Activity.mesa:407` |
| Custom reflow, stays hand-written | workbench `_module.mesa:145`, `example/web/src/routes/cart/index.mesa:518`, darkroom `index.mesa` (a full-height split, Q7) |
| Missing collapse | darkroom `index.mesa` — fixed in 1.3, hand-written (Q7); charter `apps/[id].mesa` collapses in JS |

## The design

**A Switcher for the columns** (`FJS-D2020`). Every Layout's Switcher and Sidebar in one
class: children sit side by side while the Switcher is wider than
`--switch-at` and stack below it. It measures the box it is in, without
`container-type`, so the calendly and thod cases need no query; and a
threshold is a custom property, which no `@media` or `@container` condition can
read.

```css
.switcher {
  display:   flex;
  flex-wrap: wrap;
  gap:       var(--space-2xl);
}
.switcher > * {
  flex-grow:  var(--fr, 1);
  flex-basis: max(var(--side, 0px), calc((var(--switch-at, 48rem) - 100%) * 999));
}
.switcher > [style*="--side:"] { flex-grow: 0; }
```

`--fr` gives the uneven splits (`1.05` / `.95`); `--side` on one child gives
the fixed rail. The `max()` merge of the two Every Layout primitives is the
part to prove — Phase 1.1 measures it before anything adopts it.

**What the Switcher cannot do** is tell a child which state it is in: the wrap
is not observable. The six companion rules in the sample (a divider, a sticky
rail) need a real container query on an app-named container — Q5.

**Widths stay literals, and an app's are graded** — Q3.

**Visibility follows `frame.css`'s precedent**: a class tied to one contract,
not a matrix — Q4.

---

### Phase 0 — The sample

Goal: know what apps write at a width before designing for it.
Done when: the tables above are reproducible from one script.

- [x] 0.1 Extract and classify every width query in `frontierjs/` and `fjs-prototypes/`
- [x] 0.2 Sort the show/hide queries by what they hide
- [x] 0.3 Tally the legacy apps' Uno breakpoint classes by purpose
- [x] 0.4 The census becomes a committed script, so a rerun after Phase 3 shows the drop

### Phase 1 — The Switcher

Goal: the 55% that is "columns become one" is a class, not a query.
Done when: `bun run test` in `packages/css` measures a Switcher side by side
and stacked at two container widths, with `--fr` and `--side`; `verify:ui`
passes with the in-repo collapse queries deleted.

- [x] 1.1 `.switcher` in `layout.css`, its `VOCAB` row and guide page, a spec that measures both states — the `max()` merge measured as designed at 900px/500px; two additions the measurement forced: `--fr`/`--side` registered `inherits: false` (a nested Switcher inherited its rail's width) and `inline-size: 100%` for Grid's reason (a centered Stack shrank it). Q6 came out of it.
- [x] 1.2 Port `example`: site hero, `products/[slug]`, `products/[id]` detail, BuyBox — four queries deleted, every `--side`/`--fr` inline (Q6 held); `verify` 72, `verify:ui` 36, `verify:site` 47. Left: the hero's `.hero-art` cap at `max-width: 899px` is a companion rule that now fires on the viewport while the Switcher flips on the band's own width — a 4.1 case.
- [x] 1.3 Port Basecamp deployments, workbench atlas and workbench page; fix charter and darkroom's missing collapse — deployments and both atlas layouts ported (three queries gone; `verify:atlas` 99, basecamp `build:web` clean); the workbench page stays a custom reflow (column-reverse puts the wings on top); darkroom is a two-line query (Q7); charter already collapsed in JS. Left: the deployment page was not rendered (its dev port is held by another session); the deployments rail is the old range's ceiling, 24rem, not its 18rem floor; the atlas rings rail is 30rem where the old `auto` column was max-content.
- [x] 1.4 Try `.grid` with `--grid-min` on the column-count cases; a `--cols-md` knob is raised as a question only if it fails — no knob: example `.stats` is `grid` at `--grid-min: 10rem` (3 / 3 / 2 columns at 1280 / 768 / 420, measured; the old query gave 3 / 2 / 2), transit's KPI cards at 9rem (unrendered; Q8 is the 3+1 band). remnant's four translation columns stay hand-written: the count is coupled to hiding BSB below 48rem.

### Phase 2 — Widths on the scale

Goal: a width off the scale is reported, in the package and in an app.
Done when: the vocabulary spec grades `@container` widths, and the Q3 rule
reports the sample's off-scale widths.

- [x] 2.1 Extend `vocabulary: every @media width is on the breakpoint scale` to `@container`, against a named density list — `CONTAINER_STEPS = { narrow: 480, cramped: 320 }` beside `BREAKPOINTS` in `vocabulary.js`, shipped as `containerSteps`; the spec grades `fjs` container widths in rem or px (css suite 759)
- [x] 2.2 A `fli check` warn, scope app, for a width off the scale (`FJS-D2022`) — `css-width-off-scale`, reading the installed `vocabulary.json`; twins within 1px under a step allowed; example baselines its one finding (the hero's `899px` cap, a 4.1 case), basecamp and workbench are clean (cli suite 4498)
- [x] 2.3 Run it over `fjs-prototypes/`; fix or answer each finding — seven moved to a step (calendly 60→64rem; page-performer 780→767px in CSS and its `innerWidth` test; portal 52→48rem ×2, 60→64rem; thod 60→64em); calendly's Booking twins are Q9; master-detail's 960px and 1100px wait on `master-detail.md`; the rule also reads `--switch-at`, which caught the example hero's 900px (4.1). Census: 56 of 102 on the scale, from 49 of 111



### Phase 3 — Visibility by contract

Goal: the 13 show/hide sites use a class that names what it hides.
Done when: the census in 0.4 finds no hand-written `display: none` at a width
in the nav or secondary-content groups. Met 2026-11-07: `--hides` lists nine
— serpgrid ×2 and quo (`master-detail.md`); DatePicker ×2 and workbench laptop
(kept, 3.2); page-performer's waterfall head and portal's view buttons, each a
control dropped inside a column-count reflow at a step on the scale.

- [x] 3.1 Workbench, sstime and the website adopt `.topbar-nav`/`.sidebar-toggle`, or the contract grows to fit them — workbench's `.wb-nav` and sstime's `.topbar-actions` carry `topbar-nav` and their `display: none` lines are gone (sstime's fallback is its bottom `.mobile-menu`, at the same 767px); Basecamp's Primary nav row took `topbar-nav` too (3.2). The website keeps its measured 56rem: Q10
- [x] 3.2 One class for secondary content that drops below sm or in a narrow `fjs` container; its name settled with the class (`FJS-D2023`) — `.spare` (`utilities.css`; `NOT_A_TERM.utility`, a Responsive-page guide section, three specs; css suite 762): `max-width: 639px` and `@container fjs (inline-size < 30rem)`. Adopted by Basecamp's topbar (four `hide-sm` spans, threshold 767→639), workbench's search word, ELA's `.act-snippet` ×6, portal's `.url`. Kept as queries: workbench `laptop` (the hide changes the column count in the same rule) and DatePicker's presets (its unlayered `display: flex` beats a layered `.spare` — `docs/quirks.md`). Not checked: Basecamp's topbar at 640–767px, where the Focus span, kbd and Dot now show (its dev port was held)
- [x] 3.3 Master-detail gets its own paper — four apps, and a pattern with state, not a class — `IDEAS/master-detail.md` (proposed 2026-11-07): the detail is a route and the two-pane screen is the wide enhancement; Phases 0–2, Q1–Q5 open there. Its sample found three more collapses written in `matchMedia` the census cannot see (ELA Desk, messages, InboxBoard), and that serpgrid's ClientRail is a 3.1-shaped nav and quo's contact pane a third pane, not master-detail

### Phase 4 — Children that know the state

Goal: the companion rules have one paved spelling.
Done when: QuoteAside and the walkthrough rail use it.

- [x] 4.1 The guide's Switcher page shows the app-named `@container` for a companion rule, and a "not for" line (a fixed-height split that scrolls inside itself, Q7); QuoteAside, the walkthrough rail and the example hero's `.hero-art` cap adopt it — the spelling: the app puts `container: <name> / inline-size` on the Switcher itself, so the query measures the content box `--switch-at`'s `100%` measures, and the two agree to the pixel. ELA's `.record-page` (Switcher at 64rem, aside `--side: var(--sidebar-width)`, divider under `@container record`; built, not rendered — a live app, its dev db is prod), the walkthrough `.stage` (62→64rem, rail `--side: 17.5rem`, sticky under `@container stage`; website verify green, rendered at 900/1280) and the example hero (900→64rem, cap under `@container hero`; verify:site 47, rendered at 700/1000/1100/1280; its baseline entry is gone, so `css-width-off-scale` is clean in every app)

## Open questions

- ~~**Q1 — What is the Switcher called?**~~ **Answered 2026-11-07 (`FJS-D2020`): A — `.switcher`, Every Layout's name.** `.sidebar` is the shell nav, `.switch`
  the toggle control, `.split` the two-up space-between row.
  - **A** — `.switcher`, Every Layout's name.
  - **B** — `.columns`.
  - **Recommend A** — discovered, not invented, as `.grid` is; *columns* reads
    as a count the class does not take.
- ~~**Q2 — Do container queries get their own width scale?**~~ **Answered 2026-11-07 (`FJS-D2021`): A — one scale: `BREAKPOINTS`, with the two density steps named beside it and graded by the vocabulary spec.** Tailwind v4 ships a
  separate 13-step container scale (`@xs` 20rem … `@7xl` 80rem); FCSS's only
  container widths are two density steps, and nothing grades them.
  - **A** — one scale: `BREAKPOINTS`, with the two density steps named beside
    it and graded by the vocabulary spec.
  - **B** — a container scale in `vocabulary.js`.
  - **Recommend A** — no second consumer, and the Switcher needs no query.
- ~~**Q3 — How does an app keep its widths on the scale?**~~ **Answered 2026-11-07 (`FJS-D2022`): B — literals stay (`FJS-D1099`); a `fli check` warn, scope app, reports a width off the scale, its `-1px` and `.99` twins allowed.** 56 of 111 widths in
  the sample are on it.
  - **A** — `@media (--md-down)` expanded by a Vite transform reading
    `BREAKPOINTS`, refusing an unknown name.
  - **B** — literals stay (`FJS-D1099`); a `fli check` warn, scope app, reports
    a width off the scale, its `-1px` and `.99` twins allowed.
  - **C** — neither.
  - **Recommend B** — keeps `FJS-D1099`, adds no spelling, and is the same shape
    as `css-raw-literal`; A spells one fact a third way and matches nothing
    when unexpanded.
- ~~**Q4 — What replaces hiding secondary content at a width?**~~ **Answered 2026-11-07 (`FJS-D2023`): A — one class that names the content and drops it below sm or inside a narrow `fjs` container (working name `.droppable`).** Six sites; five
  are a narrow component rather than a narrow screen. `.secondary` is a tone.
  - **A** — one class that names the content and drops it below sm or inside a
    narrow `fjs` container (working name `.droppable`).
  - **B** — a `.md-down-hidden`/`.md-up-hidden` pair.
  - **C** — keep the refusal; apps keep writing the query.
  - **Recommend A** — names the content rather than the width, as a tone does,
    and a viewport query gets the five narrow components wrong.
- ~~**Q5 — How does a child learn the Switcher stacked?**~~ **Answered 2026-11-07 (`FJS-D2024`): A — the app names a container and writes `@container <name> (inline-size >= …)` on the scale.** The wrap is not
  observable; six sites draw a divider or a sticky rail only side by side.
  - **A** — the app names a container and writes `@container <name>
    (inline-size >= …)` on the scale.
  - **B** — `.switcher` ships `container-type`.
  - **Recommend A** — B is refused by `packages/css/docs/quirks.md`: containment changes how
    a box is sized, which breaks layouts nobody changed.
- ~~**Q6 — How does a Switcher child become a rail that does not grow?**~~ **Answered 2026-11-07 (`FJS-D2026`): A — `.switcher > [style*="--side:"] { flex-grow: 0 }`: the rail is spelled inline. A `--side` from a stylesheet sets the floor and the child still grows; `layout.spec.js` pins both that limit and that `--sidebar-width` does not match.** `--side`
  gives the width; something must also zero `flex-grow`, and CSS cannot read
  "is `--side` set" without `sign()`. Built as A in 1.1, pending the ports.
  - **A** — `.switcher > [style*="--side:"] { flex-grow: 0 }`: the rail is
    spelled inline. A `--side` from a stylesheet sets the floor and the child
    still grows; `layout.spec.js` pins both that limit and that
    `--sidebar-width` does not match.
  - **B** — a second knob (`--side-grow: 0`) or a `.rail` class, so a
    stylesheet can declare the rail.
  - **C** — `flex-grow: calc(1 - sign(var(--side)))`; `sign()` is not a
    baseline function yet.
  - **Recommend A** — one declaration says "rail"; B restates it twice. Reopen
    for B if a 1.2/1.3 port sets `--side` from a class, for C when `sign()` is
    baseline.
- ~~**Q8 — Four equal cards in a Grid: is the 3+1 band acceptable?**~~ **Answered 2026-11-07 (`FJS-D2028`): A — accept it; a card row is not a table of pairs. Applied to the transit fixture provisionally 2026-11-07.** Every
  Layout's Grid fits as many columns as `--grid-min` allows, so four cards
  pass through a band one `--grid-min` plus a gap wide where three fit and the
  fourth wraps (transit's KPI cards: boxes 464–623px). The old query pair
  gave 2×2 there.
  - **A** — accept it; a card row is not a table of pairs. Applied to the
    transit fixture provisionally 2026-11-07.
  - **B** — a `--cols-md` knob on `.grid`, the count at a width.
  - **C** — that file keeps its query pair.
  - **Recommend A** — B is the breakpoint matrix by another name (`FJS-D2020`
    chose derived counts); C is one fixture.
- ~~**Q7 — Does a full-height split pane use the Switcher?**~~ **Answered 2026-11-07 (`FJS-D2027`): B — a two-line query: one column and `block-size: auto` below 48rem. Applied provisionally 2026-11-07; the page carries the pointer here.** darkroom's editor
  fixes its block-size to the window and scrolls each pane inside itself. The
  Switcher port measured in 1.3 needed the class, an inline `--side`, `gap: 0`,
  `inline-size: calc(100% + 2 * pad)` (its own `100%` stops a negative-margin
  bleed), `max-block-size: 100%` on the children (a wrapped flex line is
  content-tall, so the panel overflowed and stopped scrolling) AND a viewport
  query for `block-size: auto` when stacked — ten lines, two thresholds.
  - **A** — the Switcher plus that companion query.
  - **B** — a two-line query: one column and `block-size: auto` below 48rem.
    Applied provisionally 2026-11-07; the page carries the pointer here.
  - **Recommend B** — a fixed height with inner scrolling is the layout, not
    a column shape; A needs its own escape hatches and still the query. The
    guide's Switcher page gets a "not for" line in 4.1. Reopen when a second
    fixed-height split appears (charter's collapse is in JS).
- ~~**Q9 — calendly's Booking widget: two queries at 34rem for one column.**~~ **Answered 2026-11-07 (`FJS-D2029`): A — the widget root takes `container: fjs / inline-size`; one `@container fjs (inline-size < 30rem)` carries every rule; the media twin goes. The threshold moves 544→480px, so it needs a drive in a narrow slot on a wide page before it lands.**
  `widgets/src/Embeds/Booking.mesa:588` writes `@container (max-width: 34rem)`
  and `:591` a `@media` twin that also restyles `.times`, `.head` and `.body`.
  Nothing in the widget declares a `container-type`, so the container query
  never matches and the media twin does all the work — against the file's own
  comment that a dropped-in widget must not measure the viewport. 34rem is on
  neither scale (`FJS-D2022`).
  - **A** — the widget root takes `container: fjs / inline-size`; one
    `@container fjs (inline-size < 30rem)` carries every rule; the media twin
    goes. The threshold moves 544→480px, so it needs a drive in a narrow slot
    on a wide page before it lands.
  - **B** — keep both measures, moved to 480px and 640px.
  - **C** — baseline the two findings.
  - **Recommend A** — one measure for one layout state, and the step
    (`CONTAINER_STEPS.narrow`) already exists; B keeps two origins, C hides
    the finding. Nothing built.
- ~~**Q10 — Does the website's topbar nav join the `.topbar-nav` contract?**~~ **Answered 2026-11-07 (`FJS-D2030`): A — keep the measured 56rem query (its comment says re-measure when a link joins); baseline the one `css-width-off-scale` finding with a note. Built as A — nothing changed.**
  3.1 named the website; its menu row measures 650px of links plus a 77px
  brand and gaps, so it needs about 791px and overflows by up to 23px in
  768–790, the band `.topbar-nav` would show it in. The website also has no
  Shell sidebar: its menu is a native `popover` opened by `.navtoggle`, and
  `frame.css` ties `.sidebar-toggle` to the sidebar drawer.
  - **A** — keep the measured 56rem query (its comment says re-measure when a
    link joins); baseline the one `css-width-off-scale` finding with a note.
    Built as A — nothing changed.
  - **B** — adopt `.topbar-nav`/`.sidebar-toggle` and trim a link or the gaps
    so the row fits at 768.
  - **C** — move the query to `lg` (`max-width: 1023px`): on the scale, no
    overflow, but no inline row in 768–1023.
  - **Recommend A** — B lets layout dictate content and stretches
    `.sidebar-toggle` past its name; "the contract grows to fit them" wants a
    second consumer first, as Q2 argued. C if the one baseline entry bothers.
