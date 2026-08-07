# FrontierJS CSS — Project State (v0.12)

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
| **Element** | onto valid markup | Names *what a thing is* — `.btn` `.pill` `.badge` `.card` `.alert` `.field` `.link` `.table` `.dialog` `.drawer` `.popover` `.toast` `.feed` `.rows` `.items` `.bar` `.disclosure` `.steps` `.facts` `.avatar` `.avatars` `.kbd` `.code` `.icon` |
| **Treatment** | onto anything | Orthogonal, element-agnostic — the 7 tones, `.raised` `.outlined` `.ghost`, `.text-*`, `.stack` `.cluster` `.center` `.split` |
| **Anatomy** | no — names a slot | Names *a position inside* an Element — `.alert-icon` `.alert-content`, `.feed-item` `.feed-dot` `.feed-content`, `.list-row` `.row-actions`, `.disclosure-summary` `.disclosure-body`, `.surface-header` `-body` `-footer`, `.field-group` `.field-hint` `.pill-close`, `.step-marker` `.step-label` `.step-hint` |

Element and Anatomy are two ends of one relationship: several Element classes
carry an **anatomy contract** — `.alert` expects an icon and a content slot,
`.feed` expects items with dots, `.disclosure` expects a summary and a body.
Chaining is for Treatments; Anatomy nests.

**Anatomy classes are where the two halves meet** — Half 1 expressed as CSS
rather than prose. If you're wondering whether something belongs in the
Vocabulary, the test is whether it carries an anatomy contract.

There is a fourth group worth being honest about: **scoped modifiers** that read
like Treatment but aren't. `.square` only works on `.btn`, `.removable` only on
`.pill`, `.striped`/`.compact` only on `.table`, `.divided`/`.hover` only on
`.rows`, `.menu` only on `.items`. They're legitimate, but they're component
modifiers living in a utility system, so they need a naming convention of their
own or they'll be read as free-standing utilities and applied where they do
nothing.

> **Consequence for naming.** Because Treatment classes are *meant* to be
> applied broadly, generic unprefixed names are a bigger liability here than in
> a component framework, not a smaller one. `.center`, `.hover`, `.start`,
> `.end`, `.item`, `.icon` and the seven tone names are all global. `.bar.center` already
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
5. A11y                Last layer, so .visually-hidden and the focus ring
                       cannot be outranked by anything above them
```

These map onto the cascade layers declared in `index.css`.

> Through v0.5 this was drawn as four layers with the Vocabulary + Principles
> as a fourth "governing" layer on top, marked doc-only. That framing is
> retired: they are not a layer stacked above the CSS, they are the other half
> of the system.

### Leverage axes (layer 4)

**Inline atoms (chip lineage):**
```
chip                inline-flex layout base + auto-contrast
├── pill            chip + rounded-full + small
├── badge           chip + categorical statuses
├── btn             chip + button chrome
├── page            chip + pagination link           (NEW v0.6)
├── tooltip         chip + attached bubble           (NEW v0.6)
├── avatar          chip + fixed square + initials   (NEW v0.8)
└── step-marker     chip + numbered circle           (NEW v0.8)
```
> `.step-marker` is an Anatomy class, not an Element — the only one in the
> lineage. It is there because "solid tone fill with text on it" is exactly
> what the base solves, and steps.css deriving it by hand produced 14 AA
> failures on the first attempt: picking the text color is only half the job,
> the fill has to be luminance-capped too.

**Block surfaces (surface lineage):**
```
surface             bg + border + radius + tonal recipe
├── card            surface + padding
├── tile            surface + compact metric layout          (NEW v0.6)
├── alert           surface + row layout
├── toast           surface + fixed + slide-in
├── dialog          surface + native modal sizing
├── popover         surface + absolute + slide-in
└── drawer          surface + off-canvas + slide-from-edge
```

**App frame (NEW in v0.6 — closes the Frame + Page tiers):**
```
app                 <body> surface: reset, sunken bg, base font
shell               the grid — topbar spans, sidebar + screen beneath
  + .sidebar-first  sidebar runs full height, topbar beside it
  + .fixed          shell is one viewport; screen scrolls internally
topbar              sticky, --topbar-height
sidebar             --sidebar-width, collapses below md
screen              the routed body (min-inline-size:0 — see below)
pane                labelled subdivision, 2rem rhythm
view                switchable panel, [hidden] restated
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
tabs / tablist / tab  switching between Views          (NEW v0.6)
  + .pills / .stretch / .vertical (v0.8), selected keyed off aria-selected
breadcrumb          hierarchy trail, separator via ::before   (NEW v0.6)
pagination / page   page links, current = solid fill          (NEW v0.6)
  + page-gap
navlist / navlink   sidebar links, current = tinted           (NEW v0.6)
  + navlist-label
steps / step        multi-stage flow, current = aria-current  (NEW v0.8)
  + step-marker / step-label / step-hint, + .complete, + .vertical
facts               <dl> label/value pairs, no Anatomy classes (NEW v0.8)
  + .divided, stacks below sm
avatars / avatar    people markers, overlapping group         (NEW v0.8)
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
  + .switch (native checkbox + role=switch)
  + .field-row / .field-addon (attached prefixes, suffixes, buttons)
  + :user-invalid drives the tone with no JavaScript
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
   `@layer tokens, themes, tones, base, layout, components, patterns, utilities, a11y` and imports
   each file into its layer. Layer order beats specificity, so the old "don't
   reshuffle the imports" convention is now an explicit contract. Unlayered CSS
   beats every layer, so consumer styles override the package without
   `!important`. `layout` sits before `components`/`patterns` so `.bar` wins the
   `display` property against `.center` — see the naming note below.
6. **Tones are element-scoped** — `--bg-mix` / `--on-bg-mix` are registered
   `inherits: false`, so a tone applies only to the element carrying the class.
   See the constraint below.
7. **One focus ring, in the last layer** (NEW v0.7) — focus.css writes the
   whole recipe once, for every focusable surface, at `:where()` specificity in
   the `a11y` layer. Layer order is doing the real work: a component that
   declares `outline: none` — or, as actually happened, `box-shadow: none` on
   the property the ring was living in — cannot switch it off. Variation goes
   through `--ring-color` / `--ring-width` / `--ring-offset`, so there is never
   a second recipe. Adding a focusable component means adding its class to the
   one selector list; forgetting shows up in focus.spec.js as "has no focus
   indicator at all".
8. **Contrast is derived, not asserted** — chip.css reads the fill's relative
   luminance (the `y` channel of `xyz-d65` is exactly WCAG's L) and branches:
   bright hues keep their color and take dark text, everything else keeps white
   text and is dimmed to the luminance where white reaches 4.5:1. Verified 0 AA
   failures across all 42 tone × theme combinations on each of btn/pill/badge,
   and — because it is a derivation, not a table — for invented hues too. It holds
   for hues no theme has defined yet. `--on-bg-mix` is now an override rather
   than a per-tone assertion.

---

## Half 1 in detail — Structure

The structural half of the system: six principles that decide element choice,
and a vocabulary of 35 terms that fixes the answer for each concept. Where a
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

### Vocabulary — six tiers, 35 terms

| Tier | Terms |
|---|---|
| **Frame** | App `<body>`, Topbar `<header>`, Sidebar `<nav>`, Shell |
| **Page** | Screen `<main>`, Pane `<section aria-labelledby>`, View `<article role=tabpanel>` |
| **Region** | Section (`<section>` or `<article>` when nested), Group `<div>`, Bar `<div>`, Divider `<hr>` |
| **Block** | Card `<article>`, Tile, Item `<li>`, Row `<li>`/`<tr>`, Feed `<ol>`+`<li><article>`, Alert `<article>`, Steps `<ol>`+`<li>`, Facts `<dl>`+`<dt>`/`<dd>`, Code `<pre>`+`<code>` |
| **Inline** | Button, Link, Pill, Badge, Field, Heading, Text, Icon, Avatar `<img>`/`<span>`, Kbd `<kbd>` |
| **Overlay** | Dialog `<dialog>`, Drawer `<dialog>`, Popover `<article>`, Tooltip `<div>`, Toast `<article>` |

The **article-vs-div line** is now a real diagnostic: a term with `<article>` is
a self-contained unit you could lift out; `<div>` is structural infrastructure.

**v0.5 article sweep** changed these from `<div>` to `<article>` to satisfy
Principle 2: View, Alert, Toast, Popover (with a documented edge case — a
menu-only popover can stay `<div role="menu">`). Tooltip stays `<div>` (it's an
attachment, not a unit). Bar/Group/Item/Row stay non-article (strips, clusters,
list members).

**Coverage: complete.** As of v0.6 every one of the then-29 terms shipped CSS;
v0.8 added six more (Steps, Facts, Divider, Avatar, Kbd, Code) and shipped each
with the term. The
Frame and Page tiers landed in frame.css (App, Shell, Topbar, Sidebar, Screen,
Pane, View), Tile in tiles.css, and Tooltip in tooltips.css — thirteen terms
that had been prose with no styling behind them.

The vocabulary is no longer a promissory note: if a term is in the table, there
is a class for it, and the two halves of the system finally describe the same
thing.

---

## File map

Stylesheets live under **`src/`**, grouped into directories that mirror the
cascade layers declared in `index.css`, so the tree teaches the order rather
than competing with it. The package root holds only the manifest, the docs and
the tooling directories.

`src/` earns its name as of v0.11: `bun run build` bundles it into
`dist/frontier.css` + `.min.css` for consumers who want one file. The default
`import '@frontierjs/css'` is unchanged and still needs no build — the bundle
is a convenience artifact, not the product.

> Directories were tried once before, and are why v0.6 exists — every `@import`
> pointed at a `./themes/` and `./utilities/` that had never been created, so
> the entry point resolved nothing and the package did not load at all.
>
> Two tests make the layout safe now. **`meta: every @import in index.css
> resolved`** catches an import with no file (a failed `@import` is otherwise
> silent — the rule stays in place with a null `styleSheet`). **`meta: every
> shipped stylesheet is reachable from index.css`** catches the opposite: a
> file that exists and nothing imports, which is what a move makes easy and
> which breaks nothing loudly. Move a file, run `bun run test`.

```
@frontierjs/css/
├── package.json                   ← manifest; exports map hides src/ from the
│                                     public path (@frontierjs/css/themes/…)
├── build.js                       ← src/ → dist/, one file            (NEW v0.11)
│
└── src/
├── index.css                      ← single entry point (one import covers all)
├── utilities.css                  ← .text-* size + colour; late layer, beats
│                                     components                        (v0.10.1)
│
├── foundation/ ─────────────────────────────────────────────────────
│   ├── tokens.css                 ← :root defaults + border-box + reduced-motion
│   ├── tones.css                  ← tone vocabulary (.primary, .danger, …)
│   ├── chip.css                   ← inline visual base (:where group)   (NEW v0.6)
│   ├── surface.css                ← block visual base (:where group)
│   └── layout.css                 ← stack / cluster / center / split + .container
│
├── themes/ ─────────────────────────────────────────────────────────
│   ├── default.css                ← blue brand + neutral surfaces
│   ├── sunset.css                 ← warm orange
│   ├── forest.css                 ← deep green
│   ├── midnight.css               ← purple accent
│   ├── dark.css                   ← neutral dark
│   └── elite.css                  ← navy + lime + Montserrat (real client theme)
│
├── components/ ─────────────────────────────────────────────────────
│   ├── frame.css                  ← Frame + Page tiers: app shell        (NEW v0.6)
│   ├── typography.css             ← h1-h6, .link, kbd, code
│   ├── icon.css                   ← THE icon sizing rule + .icon        (NEW v0.10)
│   ├── buttons.css                ← .btn (+ .square, .ghost, .raised)
│   ├── pills.css                  ← .pill (+ .removable / .pill-close)
│   ├── badges.css                 ← .badge
│   ├── cards.css                  ← .card
│   ├── tiles.css                  ← .tiles/.tile + label/value/delta     (NEW v0.6)
│   ├── avatar.css                 ← .avatar (chip lineage) + .avatars     (NEW v0.8)
│   ├── feedback.css               ← .spinner .progress .skeleton .empty  (NEW v0.6)
│   ├── alerts.css                 ← .alert
│   ├── toasts.css                 ← .toast
│   ├── popovers.css               ← .popover
│   ├── tooltips.css               ← .tooltip + .tooltip-anchor            (NEW v0.6)
│   ├── drawers.css                ← .drawer
│   ├── form-core.css              ← .field, .field-group, .field-hint,
│   │                                .field-check, .switch, .field-row/-addon
│   ├── tables.css                 ← .table + variants + row tones
│   └── dialogs.css                ← .dialog
│
├── patterns/ ───────────────────────────────────────────────────────
│   ├── bars.css                   ← .bar, .section-header, .divider-label (NEW v0.5)
│   ├── lists.css                  ← .items/.item, .rows/.list-row         (NEW v0.5)
│   ├── feed.css                   ← .feed/.feed-item/.feed-dot            (NEW v0.5)
│   ├── disclosure.css             ← .disclosure + summary/body            (NEW v0.5)
│   ├── facts.css                  ← <dl> label/value pairs                (NEW v0.8)
│   ├── steps.css                  ← .steps/.step + marker/label/hint      (NEW v0.8)
│   ├── tabs.css                   ← .tabs/.tablist/.tab                   (NEW v0.6)
│   └── nav.css                    ← .breadcrumb .pagination .navlist      (NEW v0.6)
│
└── a11y/ ───────────────────────────────────────────────────────────
    ├── focus.css                  ← THE focus ring — one recipe, all of it (NEW v0.7)
    └── a11y.css                   ← .visually-hidden, .skip-link          (NEW v0.6)

   guide/                          ← the interactive reference (49 pages)
   ├── index.html                  ← shell; <link>s the real ../index.css
   ├── guide.js                    ← data, page builders, hash router
   └── guide.css                   ← chrome only (.sg-*)

   demo/                           ← a realistic SaaS admin, the first consumer
   test/                           ← the assertion suite                    (NEW v0.7)
   ├── run.js                      ← driver: builds a page, runs Chrome, reports
   ├── harness.js                  ← in-page assertions + computed-style rulers
   └── specs/*.spec.js             ← meta · focus · tables · tones · contrast ·
                                     layers · components · core-gaps
```

> **In the repo:** all 36 `*.css` files, `package.json`, `README.md`,
> `guide/`, and `test/`. **Not in the repo:** `frontier-demo.html` and
> `TicketDetail.svelte` — both predate v0.6 and describe the pre-Uno-removal
> system, so treat anything in them as stale until re-checked.

### Deliverables / artifacts

- **`test/`** (NEW v0.7) — the assertion suite. `bun run test`, or
  `bun run test focus tone` to filter, or `--keep` to leave the generated page
  on disk. 202 assertions in headless Chrome against real computed styles;
  zero dependencies (the page computes its own results and `--dump-dom` carries
  them back, so there is no puppeteer). `specs/meta.spec.js` tests the harness
  rather than the CSS — see the note about trusting your own ruler below.
- **`guide/`** — the docs site. Plain HTML + JS, no framework and no build step:
  `index.html` (shell), `guide.js` (data, 45 page builders, hash router),
  `guide.css` (chrome only). Open the file directly, or `bun run demo` and go to
  `/guide/`. It `<link>`s the real `../index.css`, so what it shows cannot drift.
  Converted from `style-guide.jsx` (a ~9,600-line single-file React site, retired
  2026-08-02 — it needed React and a bundler the package itself does not).
  Renders every component live with theme switching; nav groups: Start Here /
  Foundation / Structure / Components / Patterns / Utilities / Reference.
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
`.btn.square` + `aria-label` on the button.

**Supplying the icons is the consumer's job** as of v0.6 — the package no longer
depends on UnoCSS, so it doesn't ship the heroicons preset. It only *sizes* what
it finds: `.btn.square` sets `1.15em` on a child `<svg>` or any class starting
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

### Style interactive state from ARIA, not a class
The selected tab is ``.tab[aria-selected="true"]``, deliberately not
``.tab.active``. With a class you can render a tab that *looks* selected while
announcing itself as unselected — the two drift the moment someone updates one
and forgets the other. Keying the CSS off the ARIA attribute makes that
divergence unrepresentable: if it looks selected, it is selected as far as
assistive tech is concerned.

Breadcrumb, pagination and the sidebar nav list all key their current item off
``[aria-current="page"]`` for the same reason, and there are tests asserting
that adding ``.active``, ``.current`` or ``.selected`` fails to fake it.

Forms take it further: ``.field:user-invalid { --bg-mix: var(--color-danger) }``
is the entire validation implementation. The border, the focus ring and any
``.field-hint`` in scope all derive from ``--bg-mix`` already, so one line turns
the whole field red at the right moment — and ``:user-invalid`` fires only after
the user has actually interacted, unlike ``:invalid``, which shouts at an empty
required input the instant the page loads.

Apply the same rule to anything with a state a screen reader can observe —
``[aria-expanded]``, ``[aria-current]``, ``[aria-disabled]``, ``[hidden]``.
The attribute is the source of truth; the class is the styling hook only when
no attribute exists.

### Theming (one class on body)
`class="theme-default"` (or sunset/forest/midnight/dark/elite/basecamp). Themes
nest.

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
- ✅ `.btn.square`, `.pill.removable` + `.pill-close` (session extensions)
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

### A seventh theme — `basecamp` (v0.12, 2026-08-06)
- ✅ `themes/basecamp.css`, ported from the Basecamp UI prototype's `T` object
  (`packages/basecamp/docs/mock/BasecampUI.jsx`) — a design that carried its
  palette as 18 keys read by 2,761 inline `style={{}}` objects
- ✅ **The prototype's neutrals failed WCAG AA and nobody had measured**:
  `T.sec` 3.24:1 and `T.muted` 1.53:1 as body text. Both lifted by uniform
  linear-RGB scaling — the operation chip.css uses to cap a fill — so the hue
  is unchanged and only the luminance moves. Targeted at 7:1 and 4.6:1
  respectively rather than both at the floor, so the three-step ink ramp
  survives instead of collapsing into two
- ✅ Added to the `THEMES` array in `contrast`, `components` and `core-gaps`
  specs, so it is held to the same bar as the other six from the first commit
  rather than exempted. **208 passing** (was 205)
- ✅ First theme in the package where `.btn.outlined` clears AA (5.63:1) —
  recorded in the FJS-027 finding, which stays open at six of seven
- ⚠️ `T.sidebar` and `T.modal` had nowhere to land: frame.css paints the topbar
  and the sidebar with `--surface` and there is no `--sidebar-bg`/`--dialog-bg`
  token. Left as one surface; noted in the theme file as the argument for the
  token if the separation turns out to matter

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

To pin an exact fill, set `--on-bg-mix` (text) or override `--fill` directly.

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

> Rewritten for v0.6. The old list was a v0.5 artefact — half of it (Tooltip,
> Tile, the Tabs audit) has since shipped.

### The one that actually matters
1. **Use it in a real project.** Still **zero production consumers**. 202
   browser assertions prove the CSS does what it says; they cannot prove it is
   the right thing to say. Clean Affinity admin remains the obvious target.

   **Started, v0.9–v0.10:** `demo/` is the first thing in the repo to import
   the package — a five-route SaaS admin (`bun run demo`). It is a demo, not a
   consumer: no build step, no data, no real users. But it found **eight
   shipped bugs the test suite had never thought to ask about** (all fixed,
   with regression tests) and **four core gaps** (all filled in v0.10, leaving
   `demo.css` at a single rule). See `demo/README.md`. Eight bugs and four gaps
   from one afternoon against a green suite is the whole argument for doing (1)
   properly.

### Decisions worth making before there are consumers
2. **The scoped-modifier naming question.** `.square` only works on `.btn`,
   `.striped` only on `.table`, `.divided` only on `.rows`, `.menu` only on
   `.items`, `.compact`, `.hover`, `.start`/`.center`/`.end`. They read as
   Treatments and are not. The class taxonomy gives you the principle; the
   decision is still open.

   **One of the four named cases is resolved.** v0.10 renamed `.btn.icon` to
   `.btn.square` — forced, because `.icon` became the Icon term. It is a useful
   precedent for the rest: the rename cost about twenty markup sites and one
   test pinning why the two meanings cannot coexist. It also showed the cost of
   waiting, since the breakage is *quiet* rather than loud.

   Related, from the demo: the drawer's `.from-left` / `.from-right` are
   physical while the whole rest of the package is logical. Same decision.
3. **Cut v1.0, or say why not.** The vocabulary is complete, contrast is
   verified, the package loads. The honest blocker is (1).

### ~~Known defects, small~~ — all fixed in v0.7, with tests
4. ~~**Focus rings are four recipes.**~~ Unified into `focus.css`. Fixing it
   turned up a fifth thing nobody had noticed: `.btn.outlined` and `.btn.link`
   had **no focus indicator at all**, because `box-shadow: none` and the ring's
   `box-shadow` were the same specificity in the same layer.
5. ~~**`.table.striped` out-specifies row tones.**~~ Stripe, hover and tone now
   compose through `--row-base` instead of competing for `background`.

### ~~Gaps~~ — the SaaS list is shipped as of v0.8
Steps, Avatar (+ group), Facts (the `<dl>`), `kbd` / code block / `<hr>`, and
vertical tabs all ship with tests. Toast stacking already existed as
`.toast-stack` and had simply never been written down.

A theme-builder UI is the only thing left on that list, and it is a tool rather
than CSS — it belongs in the style guide, not the package.

### ~~The style guide is two versions behind~~ — closed 2026-08-03
1b. The guide had no page for anything added since v0.7: nothing for **Avatar,
   Facts, Code blocks, vertical Tabs, the `.text-*` size scale, or
   `icon.css`**, only glancing coverage of Steps and Kbd, a **v0.6** badge, and
   a Vocabulary page claiming **29 terms** where 35 ship. A reference that omits
   a third of the components sends people to read the CSS instead.

   **Now 49 pages.** Added: Avatar, Facts, Steps, Code & Kbd. Rewritten: Icons
   (for `.icon` / `--icon-size` / the three-way drift it replaced) and the
   Typography type scale. Extended: Tabs gained a vertical section. The
   Vocabulary table lists all 35 terms and every one has a page.

   Four claims were false rather than merely missing, and are fixed:
   - The type scale table listed **eight** Tailwind-shaped tokens
     (`text-base`, `text-2xl` … `text-4xl`) at Tailwind's pixel values. Five of
     the eight had no rule behind them; the real scale is `xs/sm/md/lg/xl`.
   - The Buttons → Sizes demo used two of those non-existent classes, and the
     other three were inert — see the `utilities` layer note above.
   - `.text-center`, `.leading-*` and `.tracking-*` were documented and ship
     nowhere. The page now says so.
   - `guide.css` redefined `.text-*` **unlayered**, so it beat the package's
     own utilities: every `text-sm` in the guide was rendering guide chrome,
     and the Typography page was demonstrating itself. Removed.

   Also fixed while in there: the tonal-ramp strips on Themes, Colors and the
   Cheat sheet rendered **unpainted** — they set `--bg-mix` on a parent and
   mixed it in the children, and `--bg-mix` is registered `inherits: false`, so
   the `color-mix()` was invalid at computed-value time. They use a guide-owned
   inheriting variable now. The config modal was titled `uno.config.js` and
   carried a stale copy of `index.css`; it now fetches the real file when
   served over http.

### Found while building v0.8, not yet decided
4. **Accent-as-text has no contrast guarantee.** The chip lineage caps a tone
   used as a *fill* so text on it clears AA. Nothing caps a tone used as
   *text on a surface* — and `.link`, `.tab[aria-selected]`,
   `.navlink[aria-current]`, `.tile-delta` and `.field-hint` all do exactly
   that. `--color-primary` on `--surface` is 3.96:1; a light brand hue is
   worse. steps.css sidesteps it (the current marker's number is `--ink`, and
   only the ring is accent), but that is one component avoiding the problem,
   not the problem being solved.

   It is a real fix — probably a `--on-surface-accent` derived the way `--fill`
   is — but it changes the look of five shipped components, so it wants a
   deliberate decision rather than a drive-by.
5. **`.text-*` utilities enumerate the seven tones.** utilities.css lists
   `.text-primary` … `.text-danger` by hand, so "adding a tone is one line in
   tones.css" is not quite true. They dodge `tones.spec.js` because the class
   names are prefixed. Low harm, but it is the same shape as the bug the whole
   v0.6 tone cycle was about.

   ~~**And they were inert on any component that set the same property.**~~
   Fixed in v0.10.1: they lived in the `components` layer beside `.btn`, which
   declares its own `font-size`, so all five size steps rendered at 14px on a
   button and the guide showed five identical buttons under a caption
   explaining how they differ. They now have their own `utilities` layer,
   after `patterns` and before `a11y`, with a regression test in
   `layers.spec.js`.

6. **The package ships no alignment, leading or tracking utilities.** The
   guide documented `.text-center`, `.leading-snug` and `.tracking-wide` —
   all Uno shortcuts through v0.5, none replaced when the config was deleted.
   The guide now says so; the open question is whether to ship them or keep
   pointing at Uno.

### Deliberately not doing
Combobox, date picker, command palette, data grid. All behaviour-heavy;
Principle 6 says behaviour belongs in a component, and shipping CSS for them
invites half-implementations.

---

## Picking this up cold

**Read first, in this order:**

1. **This doc** — especially *the two halves* (structure and style are co-equal,
   not layered), *the three kinds of class* (Element / Treatment / Anatomy, and
   which compose freely), and the six principles.
2. **`README.md`** — the consumer-facing view. Shorter, and a good check on
   whether the mental model survives contact with a reader.
3. **`index.css`** — the layer order is the architecture in one screen.

**The files:** 41 `*.css` files under `src/`, grouped since v0.11 into
`foundation/`, `themes/`, `components/`, `patterns/` and `a11y/` — folders that
mirror the cascade layers, with `index.css` and `utilities.css` at the top of
`src/`. `dist/` is generated by `bun run build` and gitignored. There is no
`uno.config.ts`.

**The bundler drops the layer order declaration.** `bun build` inlines each
`@import` as an `@layer name { … }` block but does not emit the
`@layer a, b, c;` statement, so a naive bundle falls back to first-appearance
order. Today that agrees with the declaration; it does not have to. Measured:
move the utilities import above the first components import and rebuild, and
`.btn.text-lg` goes 16px → 14px in the bundle while the source stays 16px.
`build.js` reads the statement out of `index.css`, prepends it, and refuses to
write a bundle without it.
`guide/` is the interactive reference (49 pages, all 35 vocabulary terms) and `<link>`s the real
`index.css`, so it can never drift from the source again.

**Verification is empirical here.** Do not trust a claim in this doc — including
this one — without running it. The whole v0.6 cycle started because the docs
described a system that did not exist: the entry point imported directories that
had never been created, and three headline invariants were false in code.

As of v0.7 the harness is **checked in**: `bun run test` in this package runs
202 assertions in headless Chrome against real computed styles. It is worth
being precise about what that does and does not buy you.

It is very good at invariants you thought to state. It caught `.btn.outlined`
having no focus ring at all, every theme's focus ring being the wrong color,
and an `--ink-mute` AA failure that had shipped since v0.1 — all while fixing
two unrelated defects.

It is blind to two whole categories:

- **Composition.** Two bugs in v0.8 passed every assertion and were caught only
  by rendering the page and looking at it: a `counter-increment` that never ran,
  and a `.divided` rule with a hole in the middle where the grid gap was. The
  `content` was right; a border did exist. **Screenshot the page.**
- **Questions nobody asked.** The demo app found eight shipped bugs in an
  afternoon against a green suite of 165. A suite only ever asks what you
  already thought to ask; a consumer asks what it actually needs.

It cannot tell you the vocabulary is right. Only a real consumer can.

**Where it is easy to go wrong:**

- **Treating this as a component framework.** Writing a class that only works on
  one element and calling it a utility; adding a Treatment only some components
  honour. Both have happened — see the v0.6 tone work.
- **Forgetting tones are element-scoped.** `--bg-mix` is `inherits: false`, so a
  child cannot read its parent's tone. Derive it into a normal property and pass
  that down — `--row-tint`, `--tab-accent`, `--check-accent` all do this.
- **`!important` reverses layer order.** An important declaration in the *first*
  layer beats one in the last. The reduced-motion spinner exception has to live
  in tokens.css for exactly this reason.
- **Trusting your own test harness.** Roughly a third of the failures in v0.6
  were bugs in the assertions, not the CSS — `inline-flex` blockifying to
  `flex`, `margin: auto` reporting a used px value, every `CSSStyleRule` having a
  truthy empty `.cssRules`, backslashes collapsing inside template literals.
  When a result contradicts the spec, suspect the ruler first.

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
- **v0.4.x** — `.btn.square`; `.pill.removable` + `.pill-close`; Icons page
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
- **v0.6 tooltips** — the last contract-only term. `.tooltip` +
  `.tooltip-anchor`, joined to the chip lineage in one edit so the bubble gets
  auto-contrast. Revealed on `:hover` **and** `:focus-within`, so a keyboard
  user gets it by tabbing; kept at `opacity: 0` rather than `display: none` so
  `aria-describedby` still resolves; `[hidden]` restated so it beats hover.
  **All 29 vocabulary terms now ship CSS.**
- **v0.6 forms** — `.switch` (a real checkbox with `role="switch"`; the knob is
  a background gradient rather than a pseudo-element, since pseudo-elements on
  replaced elements are not guaranteed by spec), `.field-row` + `.field-addon`
  for attached prefixes/suffixes/buttons, and `:user-invalid` driving the tone
  with **no JavaScript and no class to toggle**. `.field-check` now derives
  `--check-accent` so a tone on the label reaches the input — `--bg-mix` is
  element-scoped and could not cross that boundary on its own.
- **v0.6 nav** — `.breadcrumb`, `.pagination` / `.page`, and `.navlist` /
  `.navlink` for the sidebar. All three take their current item from
  `[aria-current="page"]`. `.page` joined the chip lineage — one edit — so the
  current page gets the auto-contrast fill machinery for free. The breadcrumb
  separator uses the `content: "/" / ""` alt-text form so screen readers do
  not read "slash" between every crumb. `.navlink` is the answer to the
  `.items.menu` problem flagged in the v0.6 audit: it goes on a real `<a>`,
  so it is focusable and announced, where `.items.menu .item` styles a
  non-focusable `<li>` to look clickable. lists.css now says so.
- **v0.6 tabs** — `.tabs` / `.tablist` / `.tab` (+ `.pills`, `.stretch`),
  reusing the existing View term as the panel. **Selected state is keyed off
  `[aria-selected="true"]`, not a class**, so the visual and announced states
  cannot diverge — verified by a test asserting that a `.active` class fails to
  fake selection. Tone travels from `.tablist` via an inheriting
  `--tab-accent`, since `--bg-mix` is element-scoped. Keyboard behavior
  (roving tabindex, arrows, Home/End) stays the app's job per Principle 6 and
  is documented in the file header.
- **v0.6 tiles + feedback** — **Tile** ships (tiles.css), added to the surface
  `:where()` list as a single edit — the cost that list is supposed to have,
  and was five edits before v0.6. `.tiles` is an auto-fit grid, so the column
  count responds without a media query. Added **feedback.css**: `.spinner`,
  `.progress` (on native `<progress>`, so the value is announced for free),
  `.skeleton`, `.empty`, plus `.btn.loading`. The reduced-motion guard needed
  an exception for spinners — see the `!important` note above.
- **v0.6 frame** — shipped the **Frame and Page tiers** (frame.css), closing
  eleven of the twenty-nine vocabulary terms: App, Shell, Topbar, Sidebar,
  Screen, Pane, View. Shell is a two-row grid with `.sidebar-first` and
  `.fixed` variants; the sidebar collapses below md, where its contents belong
  in a `<dialog class="drawer">`. Only Tile and Tooltip remain contract-only.
- **v0.10** — **demo.css reviewed; four gaps promoted into core.** The demo's
  stylesheet is a measurement — every rule in it is something a consumer has to
  hand-write — so it got read line by line and each item ruled in or out. It
  went from four items to **one**.

  **Icon sizing moved in, and deleted code doing it.** The rule was already in
  the package three times — buttons.css, pills.css, feedback.css — hand-copied
  with three different sizes (1.15em / 0.85em / 1em), two property spellings
  (`width` vs `inline-size`), and feedback.css missing the
  `[class*=" i-heroicons"]` branch, so a multi-class icon silently had no size
  there. The four-focus-recipes pattern in miniature. Now one rule in
  `icon.css`, sized by `--icon-size`, covering the components the package owns
  plus a real `.icon` class for anywhere else. **The Icon vocabulary term
  shipped no CSS before this**, so "every term ships CSS" had been false.

  **BREAKING: `.btn.icon` → `.btn.square`.** `.icon` now means "this element IS
  an icon"; one class cannot also mean "a button shaped to hold one", or
  `<button class="btn icon">` sizes the button itself to 1.15em. Note the
  breakage is *quiet*: with border-box a width under padding+border clamps, so
  a stale `.btn.icon` floors at 30x30 and looks approximately right while
  having lost its aspect-ratio and padding. PROJECT_STATE had listed `.icon` as
  one of the four "actual problem" scoped modifiers; this resolves one of them.

  **A text size scale**, `.text-xs` … `.text-xl`. Principle 3 has always said
  "visual size via utility classes" and `.h1`–`.h6` were half of it; the demo
  hand-wrote `font-size: .8125rem` fourteen times before anyone noticed. Size
  and color are separate axes and chain.

  **`--field-inline-size`** so a toolbar `<select>` can stop being 100% wide,
  and **`.sidebar-toggle`** in frame.css — the frame collapses the sidebar
  below md and hands its contents to a drawer, so the frame owes you the
  control that opens it. Deliberately one class for one contract, not a general
  `.md-up`/`.md-down` matrix.

  **One item was withdrawn.** Five `margin-block-start: 1rem` overrides looked
  like a spacing gap and were not: they were sibling blocks in containers the
  demo had forgotten to make `.stack`s. Wrapping them removed all five. The
  measurement is only worth something if you check that what it measured is
  real.
- **v0.9** — **the first consumer, and what it cost.** `demo/` is a five-route
  SaaS admin (`bun run demo`) that imports the real `index.css` — Dashboard,
  Invoices, Invoice detail, Customers, Settings, plus `demo.js` implementing
  the behavior contracts the file headers describe (tabs both orientations,
  dialogs, drawers, toasts, routing) in plain JS with no framework.

  It found **eight shipped bugs in an afternoon**, none of which 165 passing
  assertions had caught, because a suite only asks what you thought to ask.
  Five are fixed with regression tests:

  **Every closed `<dialog>` rendered as though open** — the UA's
  `dialog:not([open]) { display: none }` loses to any *author* `display`, and
  the surface base sets `display: block` on `.dialog` and `.drawer`. frame.css
  documents this exact trap for `.view[hidden]`; it was never carried across.
  **`.btn.ghost` and `.btn.raised` were silent no-ops** — Treatments that only
  surface.css honoured, so a toolbar of ghost buttons rendered solid blue; the
  same failure the v0.6 tone work fixed for tones. **The `.switch` was squashed
  into a checkbox** by `.field-check input` at (0,1,1) beating `.switch` at
  (0,1,0) — inside the markup form-core.css itself documents. **A tone on a
  `.field-check` never reached the switch track.** **The skip link painted a
  `--shadow-lg` smear across the top of every page**, because a transform moves
  the box off-screen but not what it casts.

  Three are left standing as gaps, written up in `demo/README.md`: **icons have
  no size outside a `.btn`** (the biggest one — every consumer hits it
  immediately), **no responsive visibility utilities**, and **`.field` is always
  `width: 100%`**.

  What did *not* go wrong is the other half of the result: `demo.css` is one
  media query and two sizing rules. Everything else came out of the package
  as-is, and the form-validation contract cost **zero lines** —
  `.field:user-invalid` is the entire implementation.

  One vocabulary gap surfaced: there is **no term for a route**. Pane is a
  labelled subdivision, View is a tab panel; neither is "the page you navigated
  to". The demo used bare `<div data-route>` rather than invent one.
- **v0.8** — **the SaaS gap list, shipped.** Six new vocabulary terms, each
  with CSS and tests: **Steps** (`.steps`/`.step` + marker/label/hint, current
  from `aria-current="step"`, `.complete`, `.vertical`), **Avatar**
  (`.avatar` + the overlapping `.avatars` group), **Facts** (a `<dl>` of
  label/value pairs, `.divided`, stacking below sm), **Kbd**, **Code**
  (inline + `<pre class="code">`) and **Divider** (`<hr>`). Plus
  `.tabs.vertical`. Vocabulary 29 → 35.

  Two things are worth carrying forward. **`.avatar` and `.step-marker` joined
  the chip lineage** rather than getting their own background rules — the
  one-line edit that list is designed to cost. steps.css first derived contrast
  by hand and produced **14 AA failures**, because picking white-or-black text
  is only half the job and the fill has to be luminance-capped too; the base
  already knew that. **Facts has no Anatomy classes** — `<dt>` and `<dd>`
  already name those positions, so adding `.fact-label` would be minimal-DOM
  violated for nothing.

  **Two bugs got through the test suite and were caught only by rendering the
  page and looking at it.** A `counter-increment` on `.step-marker::before`
  never runs when the marker has its own content — `content: none` means no
  pseudo-element — so one hand-written checkmark renumbered every step after
  it: ✓, 1, 2. And a border cannot span a grid gap, so `.facts.divided` drew
  its rule as two segments with a hole between the columns. Every assertion
  involved passed the whole time: the `content` was right, and a border did
  exist. It just had a hole in it. Both have regression tests now, but the
  general lesson is the one to keep — **computed-style tests cannot see
  composition.** Screenshot the page.

  Two more traps, both silent: `min(max-content, 40%)` is
  invalid (min() takes `<length-percentage>`, `max-content` is not one), so the
  whole `grid-template-columns` declaration was dropped and the Facts grid
  quietly collapsed to one column — `fit-content(40%)` is the track function
  that means what was intended. And a `<dd>` carries 40px of UA
  `margin-inline-start`, which inside a grid does not indent but shoves the
  entire value column sideways.
- **v0.7** — **the invariants became testable, and three of them were false.**
  Checked in `test/` — 141 assertions in headless Chrome against real computed
  styles, no dependencies (the page computes its own results; `--dump-dom`
  carries them back). `meta.spec.js` tests the harness, because a third of the
  v0.6 failures were bugs in the assertions.

  The two known defects are fixed. **Focus rings** collapsed from four recipes
  into one `focus.css`, in the last cascade layer so a component cannot switch
  the ring off by accident — which is precisely what had been happening:
  `.btn.outlined` and `.btn.link` had **no focus indicator at all**, because
  `.btn.outlined { box-shadow: none }` and `.btn:focus-visible { box-shadow:
  <ring> }` are both (0,2,0) in the same layer and the variant was declared
  later. Focusing a plain `.btn` also erased its resting `--shadow-sm` for the
  same reason. **`.table.striped`** no longer out-specifies row tones: stripe,
  hover and tone compose through `--row-base` instead of fighting over
  `background`, so a tone survives a stripe and the stripe still shows through
  beneath it.

  Writing the tests turned up two more. **No theme's focus ring was ever its
  own color** — `--ring: var(--color-primary)` in `:root` is the alias-token
  trap already documented for `--badge-radius`, resolving once against `:root`
  and inheriting past every `.theme-*`. Fixed the same way, and the rule is now
  general: an alias token in `:root` is always wrong. And **`--ink-mute` failed
  WCAG AA** — 3.62:1 on `--surface`, 3.32:1 on `--surface-sunken`, in all five
  light themes, since v0.1. That is placeholder text, table headers, field
  hints and nav labels at 11–13px. Both `--ink-mute` values were rescaled
  uniformly in linear RGB — the same operation chip.css uses to cap a fill, so
  chromaticity is exact and it is the identical grey, only dark enough to read.

  `--ring-width` went 3px → 2px: it only ever reached the three translucent
  box-shadow halos, which needed the spread; a solid ring does not, and 2px is
  what every v0.6 ring had already hardcoded.
- **v0.6 responsive + a11y** — the package previously contained **one media
  query in total** (the reduced-motion guard). Added a documented breakpoint
  scale, `.container` (+ `.narrow` / `.wide`) with gutters that step at 768 and
  1280, and `.table-wrap`, because a `<table>` cannot scroll itself and a wide
  one took the whole page layout with it. Added **a11y.css** — `.visually-hidden`
  (+ `.focusable`) and `.skip-link` — in a final `a11y` layer so they win
  without `!important`. The system had no accessible-labelling primitive at all
  before this, which made icon-only controls impossible to label properly.

---

## Open finding — `.btn.outlined` fails WCAG AA in six of seven themes (2026-08-03)


*Tracked as **`FJS-027`** in `../../ISSUES.md`. The analysis below is the
argued detail; the register is where it is counted.*

Found by the FrontierJS website (`website/`), which is this package's second
consuming app. Measured with `getComputedStyle` in headless Chrome, not estimated.

Untoned `.btn.outlined` paints `color: var(--bg-mix, var(--color-primary))` on
`background: var(--surface)`:

| default | sunset | forest | midnight | dark | elite | basecamp |
| ------- | ------ | ------ | -------- | ---- | ----- | -------- |
| 3.96    | 2.35   | 3.30   | 4.23     | 4.40 | 1.99  | **5.63** |

Six of the seven are below the 4.5:1 threshold for body-size text; elite is the
worst at 1.99:1.

`basecamp` is the exception and does not weaken the finding — it clears AA by
accident of being a dark theme, where a mid-brightness accent on a near-black
surface has a lot of room. It is evidence for the diagnosis rather than against
it: the ratio is a property of the theme's ground, which is exactly why an
accent used as text needs `--ink-soft` and not a contrast guarantee nobody
checked. Re-measured 2026-08-06 in headless Chrome; the six original figures
reproduce unchanged.

**The reasoning for the fix is already in this package.** `buttons.css`, in the
comment above `.btn.ghost`:

> Untoned it takes `--ink-soft` rather than the brand accent. A ghost button's
> text IS the button, and an accent on a surface has no contrast guarantee
> (`--color-primary` on `--surface` is 3.96:1); `--ink-soft` is 7.3:1 …

That is the same 3.96 measured above. `.ghost` applies the conclusion; `.outlined`
does not, and inherited the failure.

**Suggested fix** — the same move `.ghost` already makes:

```css
.btn.outlined {
  color:        var(--bg-mix, var(--ink));
  border-color: var(--bg-mix, var(--rule-strong));
}
```

A tone class still opts into the accent deliberately, exactly as with `.ghost`,
`.field-hint` and `.tile-delta`. Untoned falls back to neutral ink.

This is a visual change to a shipped v0.10 component, so it is a judgement call
whether it lands as a patch or a breaking change. The website currently carries
the override locally in `site.css`, with the measurements in a comment.

### Smaller ergonomics note — `.code` is the block variant

`typography.css` ships both treatments correctly: `code, .code-inline` is inline,
`.code` is the block (`display:block`, 0.875rem padding, border, `overflow-x`).
A consumer reading "the code class" reasonably assumes it matches `<code>`, which
is an inline element in HTML — writing `<code class="code">` inline produces a
full block box. It cost this site 26 wrong usages before it was noticed.

Non-breaking suggestion: add a `.code-block` alias and keep `.code` working, so
the pair reads `.code-inline` / `.code-block` and neither is the surprising default.

---

## Fixed — a chip on an `<a>` kept the UA underline (2026-08-03)

Found by the Sierra example app (`packages/sierra/example`) on its first hour as
a consumer: every navigating button — `<a class="btn primary">New lead</a>`,
`<a class="btn outlined">Open the list</a>` — rendered with a line through the
label.

The chip base sets layout, colour and contrast but never touched
`text-decoration`, and the shipped demo only ever uses `<button>`, so nothing in
the package exercised the case. A link-shaped button is not an edge case; it is
half of all buttons in an app with routes.

Fixed in `foundation/chip.css`, in the `:where()` base so it stays at zero
specificity:

```css
:where(.chip, .btn, .pill, .badge, .page, .tooltip, .avatar, .step-marker) {
  text-decoration: none;
}
```

`.btn.link` (buttons.css) and `.link:hover` (typography.css) still turn the
underline back on — those are deliberate, this is a default. Affects `.pill` and
`.page` identically, which is why it belongs on the base rather than on `.btn`.
