# FrontierJS CSS — Project State (v0.6)

> A minimal, composable, semantics-first CSS framework. Plain CSS, no build
> step, no UnoCSS. Drop this whole doc + the source files into a fresh chat
> to continue.

---

## What this is

**FrontierJS CSS** (npm: `@frontierjs/css`, under the **FrontierJS** umbrella) is
a design system Kobami is building primarily for **SaaS apps and internal
tooling** — Maid.Tech, Clean Affinity admin/ops, and other Svelte projects.
The ~68 client marketing sites (cleaning services, landscaping, pools) and the
`ksite` static-site generator are **downstream consumers of a subset** of the
system, not the primary target.

> Naming note: this was called **ksite-styles** through v0.4. It was renamed to
> FrontierJS CSS during the v0.5 cycle. Old references to "ksite" as the design
> system mean this package; "ksite" now refers only to the static-site generator.

The system is **two halves, equally weighted**:

1. **Structure** — what HTML a given UI element is actually made of: which tag,
   what ARIA it carries, how the pieces nest.
2. **Style** — how it gets dressed, using a utility-first vocabulary pitched one
   level above Tailwind/UnoCSS.

Neither half is decoration on the other. A Card is an answer to both questions
at once — `<article>` (structure) and `.card` (style) — and the term isn't
settled until both are. Work that only answers one is half-done.

Within the style half, the goal is **maximum leverage from minimum CSS** by
compounding basics on basics: each layer is the contract the next reads from.

---

## The two halves

### Half 1 — Structure

Which element each concept uses, what ARIA it carries, how pieces nest. It is
expressed as the **Principles** and **Vocabulary** further down. Part of it
ships as CSS (the Anatomy classes below); the rest is a contract the markup has
to honour. FrontierJS apps follow it strictly; outside projects are
"recommended to."

### Half 2 — Style: utility-first, one level up

Tailwind and UnoCSS utilities are **one CSS property each**. FrontierJS
utilities are **one UI concept each**. Same composition model — chain
single-purpose classes, no cascade fights, no per-page stylesheets — but the
vocabulary sits at the element tier:

```
Tailwind / Uno   class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded
                        border border-red-600 text-red-600 bg-white"

FrontierJS       class="btn outlined danger"
```

**This is not a component framework.** In Bulma or Bootstrap, `is-primary`
belongs to `.button` and means nothing anywhere else. Here `.danger` is
free-standing: it works on a card, a `<tr>`, a field, a button, a link, a feed
dot, and means the same thing on each. That property *is* the point — it's what
"utility-first" buys at this altitude, and it's the reason the v0.6 tone work
mattered. Before it, `.muted` on a card silently did nothing, because each
component decided which tones it accepted. That's component thinking, and it
made the utility claim false.

### Three kinds of class

Only two of the three compose freely, and the system reads better once they're
named apart:

| Kind | Composes | What it is |
|---|---|---|
| **Element** | onto valid markup | Names *what a thing is* — `.btn` `.pill` `.badge` `.card` `.alert` `.field` `.link` `.table` `.dialog` `.drawer` `.popover` `.toast` `.feed` `.rows` `.items` `.bar` `.disclosure` |
| **Treatment** | onto anything | Orthogonal, element-agnostic — the 7 tones, `.raised` `.outlined` `.ghost`, `.text-*`, `.stack` `.cluster` `.center` `.split` |
| **Anatomy** | no — names a slot | Names *a position inside* an Element — `.alert-icon` `.alert-content`, `.feed-item` `.feed-dot` `.feed-content`, `.list-row` `.row-actions`, `.disclosure-summary` `.disclosure-body`, `.surface-header` `-body` `-footer`, `.field-group` `.field-hint` `.pill-close` |

Element and Anatomy are two ends of one relationship: several Element classes
carry an **anatomy contract** — `.alert` expects an icon and a content slot,
`.feed` expects items with dots, `.disclosure` expects a summary and a body.
Chaining is for Treatments; Anatomy nests.

**Anatomy classes are where the two halves meet** — Half 1 expressed as CSS
rather than prose. If you're wondering whether something belongs in the
Vocabulary, the test is whether it carries an anatomy contract.

There is a fourth group worth being honest about: **scoped modifiers** that read
like Treatment but aren't. `.icon` only works on `.btn`, `.removable` only on
`.pill`, `.striped`/`.compact` only on `.table`, `.divided`/`.hover` only on
`.rows`, `.menu` only on `.items`. They're legitimate, but they're component
modifiers living in a utility system, so they need a naming convention of their
own or they'll be read as free-standing utilities and applied where they do
nothing.

> **Consequence for naming.** Because Treatment classes are *meant* to be
> applied broadly, generic unprefixed names are a bigger liability here than in
> a component framework, not a smaller one. `.center`, `.hover`, `.start`,
> `.end`, `.item` and the seven tone names are all global. `.bar.center` already
> depends on layer order to survive the collision with `.center`. See the naming
> constraint below — this taxonomy is the principle to resolve it against.

---

## Architecture — the style half's layers

```
1. Primitives          CSS vars in tokens.css
   ↓ overridable by
2. Themes              token overrides in the .theme-* files
   ↓ consumed by
3. Tones               .primary / .danger / … — one variable each
   ↓ consumed by
4. Classes             Element + Treatment + Anatomy (the rendered surfaces)
5. A11y                Last layer, so .visually-hidden cannot be outranked
```

These map onto the cascade layers declared in `index.css`.

> Through v0.5 this was drawn as four layers with the Vocabulary + Principles
> as a fourth "governing" layer on top, marked doc-only. That framing is
> retired: they are not a layer stacked above the CSS, they are the other half
> of the system.

### Leverage axes (layer 4)

**Inline atoms (chip lineage):**
```
chip                inline-flex layout base
├── pill            chip + rounded-full + small
├── badge           chip + categorical statuses
└── btn             chip + button chrome
```

**Block surfaces (surface lineage):**
```
surface             bg + border + radius + tonal recipe
├── card            surface + padding
├── alert           surface + row layout
├── toast           surface + fixed + slide-in
├── dialog          surface + native modal sizing
├── popover         surface + absolute + slide-in
└── drawer          surface + off-canvas + slide-from-edge
```

**Block patterns (NEW in v0.5 — layout-only, no surface):**
```
bar                 horizontal action strip (+ .start/.center/.end/.bordered)
section-header      heading + trailing affordance
divider-label       centered label on a rule
items / item        lightweight list entries (+ .menu variant)
rows / list-row     record entries with trailing actions (+ .divided/.hover)
  + row-actions
feed                chronological stream w/ connecting timeline
  + feed-item / feed-dot / feed-content
disclosure          native <details> expand/collapse
  + disclosure-summary / disclosure-body
```

**Cross-cutting tones:**
```
tones.css (.primary, .info, .danger, .success, .warning, .muted, .secondary)
  └── sets --bg-mix on any element  (one variable — that's the whole tone)
       └── surfaces derive their tint from it
       └── chip.css derives a readable fill + text color from it
```

**Standalone (don't fit the surface mold):**
```
field (form input) — own var contract, reads tones for state borders
table (tabular)    — own structure, tones on <tr> for row tinting
```

### Composition tricks (1, 3, 5, 6 reworked in v0.6)

1. **Two `:where()` lineage bases** — chip.css is the inline base (btn/pill/
   badge), surface.css the block base (card/alert/toast/…). Both are plain CSS
   at zero specificity. This replaced the Uno shortcuts, which expanded to
   *utilities* rather than to the base class — so `.card` never actually
   carried `.surface`, which is why surface.css had to enumerate composites
   in the first place.
2. **`:where()` selector groups** — surface.css writes ONE rule body targeting
   every surface composite. Add a composite = add its name to the `:where()` list.
3. **Tones as single source** — tones.css is the only place mapping tone names to
   colors, and now the only place naming them at all. Every consumer derives its
   tint from `--bg-mix` with an untoned fallback, so no component enumerates tone
   classes. Adding a tone really is one line in tones.css and zero component
   edits; until v0.6 it took edits in four files, and surface.css, form-core.css,
   tables.css and dialogs.css each supported a *different subset* of the seven
   tones (`.secondary` and `.muted` were silent no-ops on every surface).
4. **`color-mix()` for derivation** — surface tints and row tinting all derive
   from `--bg-mix`. No manual color math.
5. **Cascade layers** — index.css declares
   `@layer tokens, themes, tones, base, layout, components, patterns, a11y` and imports
   each file into its layer. Layer order beats specificity, so the old "don't
   reshuffle the imports" convention is now an explicit contract. Unlayered CSS
   beats every layer, so consumer styles override the package without
   `!important`. `layout` sits before `components`/`patterns` so `.bar` wins the
   `display` property against `.center` — see the naming note below.
6. **Tones are element-scoped** — `--bg-mix` / `--on-bg-mix` are registered
   `inherits: false`, so a tone applies only to the element carrying the class.
   See the constraint below.
7. **Contrast is derived, not asserted** — chip.css reads the fill's relative
   luminance (the `y` channel of `xyz-d65` is exactly WCAG's L) and branches:
   bright hues keep their color and take dark text, everything else keeps white
   text and is dimmed to the luminance where white reaches 4.5:1. Verified 0 AA
   failures across all 35 tone × theme combinations, worst 4.58:1 — and it holds
   for hues no theme has defined yet. `--on-bg-mix` is now an override rather
   than a per-tone assertion.

---

## Half 1 in detail — Structure

The structural half of the system: six principles that decide element choice,
and a vocabulary of 29 terms that fixes the answer for each concept. Where a
term needs CSS to hold its shape, that CSS is an Anatomy class.

### Six principles

1. **Minimal DOM.** Every element earns its place.
2. **Articles inside Sections, not Sections inside Sections.** Discrete
   self-contained units inside a Section are `<article>`, never nested
   `<section>`. Drives element choice for Card contents, Feed entries, Pane
   subsections, Alert/Toast/Popover/View.
3. **Heading levels carry structure, not size.** Outline via `<h1>`–`<h6>`;
   visual size via utility classes.
4. **Native elements over reinvention.** `<dialog>`, `<details>`, `<button>`.
5. **Tone is a single signal.** `.success` OR `.danger`, never both.
6. **Components only for behavior.** Visual treatment = class; keyboard/focus/
   ARIA behavior = component. Most "components" are class-only.

### Vocabulary — six tiers, 29 terms

| Tier | Terms |
|---|---|
| **Frame** | App `<body>`, Topbar `<header>`, Sidebar `<nav>`, Shell |
| **Page** | Screen `<main>`, Pane `<section aria-labelledby>`, View `<article role=tabpanel>` |
| **Region** | Section (`<section>` or `<article>` when nested), Group `<div>`, Bar `<div>` |
| **Block** | Card `<article>`, Tile, Item `<li>`, Row `<li>`/`<tr>`, Feed `<ol>`+`<li><article>`, Alert `<article>` |
| **Inline** | Button, Link, Pill, Badge, Field, Heading, Text, Icon |
| **Overlay** | Dialog `<dialog>`, Drawer `<dialog>`, Popover `<article>`, Tooltip `<div>`, Toast `<article>` |

The **article-vs-div line** is now a real diagnostic: a term with `<article>` is
a self-contained unit you could lift out; `<div>` is structural infrastructure.

**v0.5 article sweep** changed these from `<div>` to `<article>` to satisfy
Principle 2: View, Alert, Toast, Popover (with a documented edge case — a
menu-only popover can stay `<div role="menu">`). Tooltip stays `<div>` (it's an
attachment, not a unit). Bar/Group/Item/Row stay non-article (strips, clusters,
list members).

---

## File map

All files live **flat** in the package root. The groupings below are logical
(and match the `@import` order in `index.css`), not directories.

```
@frontierjs/css/
├── package.json                   ← manifest; "." → index.css, "./*.css" → flat files
├── index.css                      ← single entry point (one import covers all)
├── tokens.css                     ← :root defaults + border-box + reduced-motion guard
│
│  themes ─────────────────────────────────────────────────────────
├── default.css                    ← blue brand + neutral surfaces
├── sunset.css                     ← warm orange
├── forest.css                     ← deep green
├── midnight.css                   ← purple accent
├── dark.css                       ← neutral dark
├── elite.css                      ← navy + lime + Montserrat (real client theme)
│
│  foundation ─────────────────────────────────────────────────────
├── tones.css                      ← tone vocabulary (.primary, .danger, …)
├── chip.css                       ← inline visual base (:where group)   (NEW v0.6)
├── surface.css                    ← block visual base (:where group)
├── layout.css                     ← stack / cluster / center / split + .container (NEW v0.6)
│
│  components ─────────────────────────────────────────────────────
├── typography.css                 ← h1-h6, .text-* utilities
├── buttons.css                    ← .btn (+ .icon added v0.4.x)
├── pills.css                      ← .pill (+ .removable / .pill-close added v0.4.x)
├── badges.css                     ← .badge
├── cards.css                      ← .card
├── alerts.css                     ← .alert
├── toasts.css                     ← .toast
├── popovers.css                   ← .popover
├── drawers.css                    ← .drawer
├── form-core.css                  ← .field, .field-group, .field-hint, .field-check
├── tables.css                     ← .table + variants + row tones
├── dialogs.css                    ← .dialog
│
│  block-tier patterns ────────────────────────────────────────────
├── bars.css                       ← .bar, .section-header, .divider-label   (NEW v0.5)
├── lists.css                      ← .items/.item, .rows/.list-row/.row-actions (NEW v0.5)
├── feed.css                       ← .feed/.feed-item/.feed-dot/.feed-content (NEW v0.5)
├── disclosure.css                 ← .disclosure + summary/body              (NEW v0.5)
│
│  accessibility ───────────────────────────────────────────────────
└── a11y.css                       ← .visually-hidden, .skip-link            (NEW v0.6)
```

> **Not yet in the repo:** `README.md`, and the deliverables listed below
> (`style-guide.jsx`, `frontier-demo.html`, `TicketDetail.svelte`) live outside
> this package.

### Deliverables / artifacts

- **`style-guide.jsx`** (~9,600 lines) — single-file React docs site. Renders
  every component live with theme switching; nav groups: Start Here / Foundation
  / Structure / Components / Patterns / Utilities / Reference.
  - Start Here: Overview, Principles, Install, Composition, Conventions
  - Foundation: CSS Variables, Tonal, Themes, Colors
  - Structure: Vocabulary (29 terms, 6 groups)
  - Components: Buttons, Links, Headings, Cards, Alerts, Toasts, Popovers,
    Drawers, Tables, Dialogs, Inputs, Tags & Pills, Icons
  - Patterns (NEW v0.5): Bar, Section Header, Items, Rows, Feed, Disclosure, Divider
  - Utilities: Layouts, Spacing, Typography
  - Reference: Cheat sheet
- **`frontier-demo.html`** (NEW v0.5) — single self-contained HTML file with all
  CSS inlined (Uno shortcuts translated to plain CSS) + a full component gallery
  + theme switcher + TicketDetail marquee. Opens in any browser, no build step;
  also pasteable into CodePen. The standalone test/preview surface.
- **`TicketDetail.svelte`** — the dogfooded reference screen (v5/v6): Pane
  structure, article subsections per Principle 2, real heroicons, real Block
  patterns. Demonstrates the system end-to-end.
- **`frontierjs-layout-converter-prompt.md`** (NEW v0.5) — system prompt for a
  separate Claude Project that converts mockup images → **FJL** (FrontierJS
  Layout), an indented DSL that's the review layer between image and HTML.

---

## Conventions (must keep consistent)

### Tone vocabulary (one place: tones.css)
```
primary, secondary, muted, info, success, warning, danger
```
Each sets exactly one variable, `--bg-mix`. That's the whole tone. Contrast is
derived from it, not declared alongside it: surfaces mix their own tint,
chip.css derives a readable fill and text color. `--on-bg-mix` still exists but
is now an *override*, not a per-tone assertion.

A tone is a Treatment class, so it must work on every element that reads it —
if you add a consumer, it takes all seven or it's a bug.

### Class composition (utility chain, element altitude)
`class="btn outlined danger"` — Element class first, then Treatment classes in
any order. Treatments are commutative; nothing depends on the order you write
them in.

The chain is the composition mechanism, the same way it is in Tailwind. What
differs is the altitude: each class names a UI concept rather than a CSS
property. So `class="card raised danger"` is three decisions (what it is, how
it sits, what it signals), not thirty declarations.

Anatomy classes are the exception — `.alert-icon` inside `.alert`, `.feed-dot`
inside `.feed-item` — because those name a *position in a structure*, not a
treatment. They aren't chained, they're nested.

### Element choice (Half 1's contract)
- A discrete self-contained unit inside a Section → `<article>` (Principle 2)
- A labeled major subdivision of a Screen → `<section aria-labelledby>` (Pane)
- A visual cluster with no identity → `<div>` (Group)
- A list member → `<li>` (Item/Row)
- See the Vocabulary page / table above for every term's element + ARIA.

### Icons
`<span class="i-heroicons:NAME" aria-hidden="true">`. Icon-only buttons:
`.btn.icon` + `aria-label` on the button.

**Supplying the icons is the consumer's job** as of v0.6 — the package no longer
depends on UnoCSS, so it doesn't ship the heroicons preset. It only *sizes* what
it finds: `.btn.icon` sets `1.15em` on a child `<svg>` or any class starting
`i-heroicons`. Use Uno's preset-icons, Iconify, or inline SVG; the
`i-heroicons:*` naming is what the sizing rule expects.

(Note: Panel.svelte still uses `<i>`; docs prefer `<span>`. Unresolved, accepted
either way.)

### Breakpoints (literals, not tokens)
```
sm 640  ·  md 768  ·  lg 1024  ·  xl 1280  ·  2xl 1536
```
Tailwind's scale, which is also UnoCSS's default, so an app running Uno
alongside gets one set of breakpoints rather than two that nearly agree.

They are **deliberately not custom properties**. `@media (min-width: var(--bp-md))`
does not work and never has — a custom property cannot be used in a media
query — so shipping `--bp-*` tokens would look themable and silently do
nothing. The numbers are written literally where the package needs them.

What *is* themable is the outcome: `--container-max`, `--container-narrow` and
`--container-pad` are ordinary tokens, so a theme can change the page width and
the gutters without touching a media query.

### Accessibility primitives (a11y.css, last layer)
`.visually-hidden` takes an element out of the visual rendering while leaving it
in the accessibility tree — the real label on an icon-only control, a table
caption, a live region. It is **not** `display:none` or `visibility:hidden`;
both of those remove the element from the accessibility tree too.

It only works if nothing outranks it on position/size/clip, which is why most
libraries protect it with `!important`. Here it sits in an `a11y` layer declared
after every other layer, so it wins without one — while a consumer's own
unlayered CSS still overrides it, which is correct.

`.visually-hidden.focusable` reveals on `:focus`/`:focus-within`, and
`.skip-link` is the off-screen-until-focused jump link. Give the skip target
`tabindex="-1"`, or some browsers move the viewport without moving focus.

### Theming (one class on body)
`class="theme-default"` (or sunset/forest/midnight/dark/elite). Themes nest.

### Sub-regions
`surface-header` / `surface-body` / `surface-footer` (shared across surface
composites; NOT `card-header`). These are Anatomy classes — they mean nothing
outside a surface composite, and they aren't chained onto it, they nest inside.

---

## What's been done (chronological)

### Foundation (v0.1–v0.2)
- ✅ Three-tier architecture; chip→pill/badge/btn lineage; `--bg-mix`/`--on-bg-mix`
- ✅ tones.css single source; lighten/darken rules; six themes; reduced-motion guard
- ✅ Layout shortcuts (stack/cluster/center/split)

### Surface lineage (v0.3–v0.4)
- ✅ surface.css `:where()` base; tonal recipe (10/30/55); cards 80→14 lines
- ✅ Alerts, Toasts (v0.3); Popovers, Drawers (v0.4); shared sub-regions

### Repositioning + contract layer (v0.5)
- ✅ Renamed ksite-styles → FrontierJS CSS (`@frontierjs/css`)
- ✅ Repositioned: SaaS/tooling primary, marketing sites downstream
- ✅ Principles page (6 principles)
- ✅ Vocabulary page (6 tiers, 29 terms, two-level sidebar TOC)
- ✅ Article sweep: View/Alert/Toast/Popover → `<article>`; Section no longer
  self-nests; Components pages (Alerts/Toasts/Popovers) aligned to match Vocab

### Block tier (v0.5)
- ✅ `.btn.icon`, `.pill.removable` + `.pill-close` (session extensions)
- ✅ bars.css (.bar + section-header + divider-label)
- ✅ lists.css (.items/.item, .rows/.list-row/.row-actions — `.row` renamed to
  `.list-row` to dodge Bootstrap)
- ✅ feed.css (.feed + parts, with connecting timeline)
- ✅ disclosure.css (native details/summary, CSS caret)
- ✅ All four wired into index.css and documented as Components/Patterns pages

### Dogfooding + tooling (v0.5)
- ✅ TicketDetail.svelte iterated to v6 (article subsections, real icons, real
  Block patterns)
- ✅ frontier-demo.html single-file build for CodePen/local testing
- ✅ FJL image-to-layout converter prompt

---

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

### Three-way artifact sync
Source CSS, frontier-demo.html (inlined copy), and style-guide.jsx (embedded
STYLESHEET copy) each carry the CSS. Changes to a pattern must be applied to all
three. As of v0.5 they're in sync.

### Markup naming breaking change
`card-header` → `surface-header` (since v0.3). Old code needs renaming.

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

To pin an exact fill, set `--on-bg-mix` (text) or override `--fill` directly.

### Surface variants now beat the tone tint (behavior change in v0.6)
`.raised` / `.outlined` / `.ghost` are declared after the tone recipe, so each
wins on the properties it owns. Previously they were declared *before* the
`:is(.primary, …)` tone rule at equal specificity and lost to it — a toned
`.outlined` card still drew a tinted background, and `.ghost` wasn't ghost at
all. Each variant keeps the tint on the parts it does render, so a toned
`.outlined` still gets a tinted border.

### Alias tokens must resolve at the use site
`--badge-radius: var(--btn-radius)` declared in `:root` looks like an alias and
silently isn't: the `var()` resolves once, against `:root`'s own `--btn-radius`,
and the resulting computed value inherits straight past any `.theme-*` override.
Elite squares off buttons and the badge stayed rounded.

The working form is a use-site fallback — `border-radius: var(--badge-radius,
var(--btn-radius))` on `.badge` — which resolves on the element, where the theme
override is visible. Any future "component X follows component Y's token" pairing
has to use the fallback form.

### `.center` and `.bar.center` mean different things
`.center` (layout.css) is "centre on both axes, via grid". `.bar.center` (bars.css)
is "centre this bar's contents, still flex". Both are single-class selectors on
the `display` property, so specificity cannot separate them — the layer order
does, with `layout` before `patterns` so `.bar` wins.

That works, but it is load-bearing on layer order for what is really a name
collision. The system has no namespace: `.center`, `.hover`, `.start`, `.end`,
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
- **Scoped modifiers** — the actual problem. `.bar.center`, `.table.hover`,
  `.rows.divided`, `.items.menu` read as Treatments and aren't.

There are currently zero consumers, so renaming is free right now and won't be
later.

---

## What's worth doing next (ranked)

### High-leverage
1. **Use it in a real project.** Drop `@frontierjs/css` into Clean Affinity
   admin or a client buildout. Real usage surfaces gaps docs can't.
2. **Audit Tabs.svelte against the View vocab.** It still renders
   `<div role="tabpanel">`; the contract is now `<article role="tabpanel">`.
   Also a hardcoded `#4f81e5` should be `var(--color-primary)`.
3. **"Is the system done?" audit** — walk frontier-demo.html with all real CSS,
   confirm every pattern renders across all six themes, fix or document gaps,
   then consider a v1.0 cut.

### Medium-leverage
4. **Cards page article sweep** — 19 `div.card` instances; Card accepts both, so
   not compelled, but consistency has value.
5. **Tooltip component** — the last Overlay term without CSS/a Components page.
   Stays `<div role="tooltip">` (attachment, not unit).
6. **Clickable Vocab → Components cross-links** — notes currently say "documented
   on the X page" as prose; make them navigable.
7. **Build the FJL→HTML compiler prompt** — the inverse of the converter, so the
   image→FJL→HTML loop is complete.

### Lower-leverage
8. **Tile / Feed-as-progressive (`role="feed"`) Components pages** — vocab terms
   without dedicated pages yet.
9. **Per-theme typography/radius override docs** — Elite already does it; not
   documented as a reusable pattern.
10. **Theme builder UI** — slide tokens, export a theme file.

---

## Files to bring to a fresh chat

1. **`style-guide.jsx`** — docs artifact (`/mnt/user-data/outputs/style-guide.jsx`)
2. **The full CSS source** — the flat `*.css` files in the package root
   (there is no `styles/` directory and no `uno.config.ts`; both are gone as of
   v0.6)
3. **`frontier-demo.html`** — single-file test/preview build
4. **`TicketDetail.svelte`** — dogfooded reference screen
5. **This doc** — `PROJECT_STATE.md`

Reasonable opening prompt:

> I'm continuing work on FrontierJS CSS (was "ksite-styles"). The two halves,
> the class taxonomy, and the file layout are in PROJECT_STATE.md. Current
> version is v0.6 — plain CSS, no build step, no UnoCSS. Interactive docs are
> style-guide.jsx; single-file test build is frontier-demo.html. I want to
> [...goal...].

The new Claude should read PROJECT_STATE.md first to absorb context without
re-deriving it — especially **the two halves** (structure and style are
co-equal, not layered), **the three kinds of class** (Element / Treatment /
Anatomy, and which compose freely), and the six principles.

The most common way to get this system wrong is to treat it as a component
framework — writing a class that only works on one element and calling it a
utility, or adding a Treatment that only some components honour. Both have
happened; see the v0.6 tone work.

---

## Versioning history

- **v0.1** — chip lineage; base components (btn/pill/badge/card/dialog/field/
  table); six themes; tonal mixing rules
- **v0.2** — tones.css refactor; reduced-motion; layout shortcuts; Install +
  Layouts pages; theme secondaries fixed
- **v0.3** — surface.css `:where()` refactor; Alerts + Toasts; sub-region rename
  (card-header → surface-header)
- **v0.4** — Popovers + Drawers (drawer on `<dialog>` for free focus trap); edge
  variants
- **v0.4.x** — `.btn.icon`; `.pill.removable` + `.pill-close`; Icons page
- **v0.5** — **rename to FrontierJS CSS**; repositioning (SaaS-first); Principles
  page; Vocabulary page (29 terms); article sweep (View/Alert/Toast/Popover →
  `<article>`); Block tier (bars/lists/feed/disclosure + 7 Patterns pages);
  single-file frontier-demo.html; FJL image→layout converter prompt;
  TicketDetail dogfood to v6
- **v0.6** — **the package actually ships and actually loads.** Added
  `package.json`; fixed `index.css`, whose every `@import` pointed at
  `./themes/` and `./utilities/` directories that do not exist, so the entry
  point resolved nothing. **Dropped UnoCSS** — the component shortcuts moved
  into plain CSS (new chip.css inline base, new layout.css), `uno.config.ts`
  deleted, border-box shipped since Uno's preflight was supplying it. Radius
  tokens now reach `.btn`/`.badge`, so Elite's sharp corners work. Added
  **cascade layers**. Registered `--bg-mix`/`--on-bg-mix` as `inherits: false`,
  fixing tones bleeding into untoned descendants. **Removed every tone-name
  list**, so all seven tones work on every consumer. Wired up `--surface-raised`
  (previously read by nothing), defined `.link` (referenced but never defined),
  added `color-scheme` + readable shadows to the dark theme, and swept dead code
  (three redundant reduced-motion guards, a phantom `.feed-item` reset, a
  hardcoded single-icon selector, four `lighten`/`darken` rules that wrote
  variables nothing read). Finally, **derived contrast**: tones.css asserted
  `--on-bg-mix: white` regardless of hue, failing WCAG AA on 15 of 35
  tone × theme combinations (worst 1.99:1, Elite's primary button). Fills and
  text are now both derived from the fill's relative luminance — 0 failures,
  worst 4.58:1, with 25 of 35 brand colors untouched.
- **v0.6 docs** — reframed around **two co-equal halves** (structure and style)
  rather than four layers with the semantic contract bolted on top as a
  "doc-only" fifth. Named the style half for what it is: **utility-first one
  level above Tailwind/UnoCSS — one class per UI concept, not per CSS
  property**, which retires the "Bulma-style chain" description (Bulma is a
  component framework; this isn't). Added the **Element / Treatment / Anatomy**
  taxonomy plus the scoped-modifier fourth group, which gives the namespacing
  question a principle instead of case-by-case judgment, and gives "is this
  class right?" a test: does it compose the way its kind is supposed to.
- **v0.6 responsive + a11y** — the package previously contained **one media
  query in total** (the reduced-motion guard). Added a documented breakpoint
  scale, `.container` (+ `.narrow` / `.wide`) with gutters that step at 768 and
  1280, and `.table-wrap`, because a `<table>` cannot scroll itself and a wide
  one took the whole page layout with it. Added **a11y.css** — `.visually-hidden`
  (+ `.focusable`) and `.skip-link` — in a final `a11y` layer so they win
  without `!important`. The system had no accessible-labelling primitive at all
  before this, which made icon-only controls impossible to label properly.
