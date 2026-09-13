# FrontierJS CSS — Project State (v0.16)

> A minimal, composable, semantics-first CSS framework. Plain CSS, no build
> step; UnoCSS optional and supported alongside (ruled 2026-08-08). Drop this
> whole doc + the source files into a fresh chat to continue.

---

## What this is

**FrontierJS CSS** (npm: `@frontierjs/css`, under the **FrontierJS** umbrella) is
a design system FrontierJS is building primarily for **SaaS apps and internal
tooling** — Maid.Tech, Clean Affinity admin/ops, and other Svelte projects.
The ~68 client marketing sites (cleaning services, landscaping, pools) and the
`ksite` static-site generator are **downstream consumers of a subset** of the
system, not the primary target.


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
to honor. FrontierJS apps follow it strictly; outside projects are
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

### Four kinds of class

Only two of them compose freely, and the system reads better once they're
named apart:

| Kind | Composes | What it is |
|---|---|---|
| **Element** | onto valid markup | Names *what a thing is* — `.btn` `.pill` `.badge` `.card` `.alert` `.field` `.link` `.table` `.dialog` `.drawer` `.popover` `.toast` `.feed` `.rows` `.items` `.bar` `.disclosure` `.steps` `.facts` `.avatar` `.avatars` `.kbd` `.code` `.icon` |
| **Treatment** | onto anything | Orthogonal, element-agnostic — the 7 tones, `.raised` `.outlined` `.ghost`, `.text-*`, `.stack` `.cluster` `.center` `.split` |
| **Density** | onto a region | The third axis and the only kind that **inherits** — `.dense` `.roomy`, or any `--density` number. A fact about a box, obeyed by everything inside it |
| **Anatomy** | no — names a slot | Names *a position inside* an Element — `.alert-icon` `.alert-content`, `.feed-item` `.feed-dot` `.feed-content`, `.list-row` `.row-actions`, `.disclosure-summary` `.disclosure-body`, `.surface-header` `-body` `-footer`, `.field-group` `.field-hint` `.pill-close`, `.step-marker` `.step-label` `.step-hint` |

Element and Anatomy are two ends of one relationship: several Element classes
carry an **anatomy contract** — `.alert` expects an icon and a content slot,
`.feed` expects items with dots, `.disclosure` expects a summary and a body.
Chaining is for Treatments; Anatomy nests.

**Anatomy classes are where the two halves meet** — Half 1 expressed as CSS
rather than prose. If you're wondering whether something belongs in the
Vocabulary, the test is whether it carries an anatomy contract.

There is a fifth group worth being honest about: **scoped modifiers** that read
like Treatment but aren't. `.square` only works on `.btn`, `.removable` only on
`.pill`, `.striped`/`.compact` only on `.table`, `.divided`/`.hover` only on
`.rows`, `.menu` only on `.items`. They're legitimate, but they're component
modifiers living in a utility system, so they need a naming convention of their
own or they'll be read as free-standing utilities and applied where they do
nothing.

**Density exists because three of them should never have been modifiers.**
`.compact` on a Table, `.narrow` and `.wide` on a Bar are size decisions
wearing a component's name — the exact shape this package criticises
`btn-sm` for — and they took that shape because there was no space scale for
them to live in. There is one now; retiring the three is a change to markup
people have already written, so they still work.

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
pane                labeled subdivision, 2rem rhythm
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
pagination          page links, current = solid fill          (NEW v0.6)
  + pagination-link / pagination-gap        (renamed from .page v0.14.6)
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
   edits; 
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
and a vocabulary of 54 terms that fixes the answer for each concept. Where a
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

### Vocabulary — eight tiers, 54 terms

Grew from six/35 on **2026-08-08**. The additions were not new design: the CSS
already shipped every one of them and the vocabulary simply did not say so. The
guide had claimed "all 35 vocabulary terms ship CSS" for four versions, which
was true and was half the question — the reverse had never been asked, and it
was false eighteen times. `test/specs/vocabulary.spec.js` asks it now, from the
real CSSOM, in both directions.

| Tier | Terms |
|---|---|
| **Base** | Chip `<span>`, Surface `<div>`/`<article>` — the two lineages, at `:where()` specificity |
| **Frame** | App `<body>`, Topbar `<header>`, Sidebar `<nav>`, Shell |
| **Page** | Screen `<main>`, Pane `<section aria-labelledby>`, View `<article role=tabpanel>`, Tabs `<div role=tablist>` |
| **Region** | Section (`<section>` or `<article>` when nested), Group `<div>`, Bar `<div>`, Toolbar `<div role=toolbar>`, Divider `<hr>`, Nav `<ul>`+`<a>`, Breadcrumb `<nav>`+`<ol>`, Pagination `<nav>` |
| **Block** | Card `<article>`, Tile, Item `<li>`, Row `<li>`/`<tr>`, Feed `<ol>`+`<li><article>`, Alert `<article>`, Steps `<ol>`+`<li>`, Facts `<dl>`+`<dt>`/`<dd>`, Code `<pre>`+`<code>`, Table `<table>`, Disclosure `<details>`+`<summary>`, Empty `<div>` |
| **Inline** | Button, Link, Pill, Badge, Field, Switch `<input role=switch>`, Heading, Text, Icon, Avatar `<img>`/`<span>`, Kbd `<kbd>`, Progress `<progress>`, Spinner, Skeleton |
| **Overlay** | Dialog `<dialog>`, Drawer `<dialog>`, Popover `<article>`, Tooltip `<div>`, Toast `<article>` |
| **Layout** | Stack, Cluster, Center, Split, Container — Every Layout's names, deliberately |

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
├── utilities.css                  ← .text-* size + color; late layer, beats
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

   guide/                          ← the interactive reference (52 pages)
   ├── index.html                  ← shell; <link>s the real ../index.css
   ├── guide.js                    ← data, page builders, hash router, ⌘K palette
   ├── decisions.js                ← the Learn wizard's routing tree      (v0.13)
   ├── search.js                   ← the search ranker + slugify          (NEW)
   └── guide.css                   ← chrome only (.sg-*)

   demo/                           ← a realistic SaaS admin, the first consumer
   test/                           ← the assertion suite                    (NEW v0.7)
   ├── run.js                      ← driver: builds a page, runs Chrome, reports
   ├── harness.js                  ← in-page assertions + computed-style rulers
   └── specs/*.spec.js             ← meta · focus · tables · tones · contrast ·
                                     layers · components · core-gaps · code ·
                                     decisions · overlays · search · space ·
                                     type · vocabulary · anatomy
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
    Drawers, Tables, Dialogs, Inputs, Badges & Pills, Icons
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

### Type scale (tokens, one ladder — 2026-08-08)
```
--text-2xs 11 · xs 12 · sm 13 · md 14 (body) · lg 16 · xl 18 · 2xl 22 · 3xl 28 · 4xl 36
--leading-display 1.1 · heading 1.2 · snug 1.45 · normal 1.5 · body 1.55 · relaxed 1.6
```
The `.text-*` utilities and `h1`–`h6` read the **same** rungs, which is why
`.text-xl` and an `<h4>` are the same size — one number, not two that agree by
hand. Only `xs…xl` have a class; the other four are heading material, and
reaching for one directly means you wanted a heading.

Before this, 53 sizes were literal across 20 files and four of them existed in
**two spellings at once** — `13px` and `0.8125rem`, `14px` and `0.875rem`,
`11px` and `0.6875rem`, `22px` and `1.375rem`. The px half does not scale when
a reader raises their browser's base font, so the same nominal size was
accessible in a table cell and not in a popover, in one package, by accident.
Every substitution was pixel-identical except `.empty-title` (17→18px), which
was off the ladder entirely. `test/specs/type.spec.js` now fails on any literal
`font-size` outside `tokens.css` — `em`, `calc()` and `inherit` stay legal
because each is deliberately relative to something.

Rungs are **literal values**, never `--text-sm: var(--text-md)`: the alias trap
that cost every focus ring its theme color applies here identically.

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
`.center` (layout.css) is "center on both axes, via grid". `.bar.center` (bars.css)
is "center this bar's contents, still flex". Both are single-class selectors on
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
1. **Use it in a production project.** Every app in this workspace styles with
   it — `example`, `basecamp`, `website`, and `@frontierjs/ui` builds on it — and
   none of them is deployed to real users yet. The suite proves the CSS does what
   it says; it cannot prove it is the right thing to say. `demo/` found eight
   shipped bugs and four core gaps in one afternoon against a green suite, which
   is the argument for doing this properly.

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
Combobox, date picker, command palette, data grid. All behavior-heavy;
Principle 6 says behavior belongs in a component, and shipping CSS for them
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
`guide/` is the interactive reference (48 pages, all 54 vocabulary terms) and `<link>`s the real
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
  honor. Both have happened — see the v0.6 tone work.
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
