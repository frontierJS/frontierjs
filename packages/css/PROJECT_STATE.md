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
that cost every focus ring its theme colour applies here identically.

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

### A tenth theme — `field` — and the token it needed (2026-08-14)

- ✅ `themes/field.css` — ink ground, sand ink, a serif display over a monospace
  body. Written for the pages a project generates about itself (`fli ws:atlas`
  is the first consumer), and the dark counterpart to `press`: same discipline,
  opposite ground, no selector of its own
- ✅ **`--heading-letter-spacing`**, which is why the theme exists in this
  package rather than in the page that wanted it. Buttons, badges and pills each
  had a tracking token and headings did not, so a theme wanting a tracked
  display face had to ship a selector — the one thing a theme may not do. The
  first attempt put it on the shared `h1–h6` block and was **dead**: three of
  the six levels declare their own `letter-spacing` below and override it. It is
  now the FALLBACK arm of each level's own value, so unset every level keeps the
  optical tracking it has always had, and set, one declaration moves all six
- ✅ Contrast fitted rather than eyeballed: all seven tones read as text
  somewhere, and `--color-danger` had to move (`#c0463a` measured 3.29:1 on
  `--surface-raised`, the tightest of the three grounds). `--ink-mute` sits at
  4.60:1 there, the same bar `dark.css` documents
- ✅ Added to `THEMES` in the `contrast`, `components` and `core-gaps` specs, so
  it is held to the same bar as the others from the first commit rather than
  exempted, and to `NOT_ANATOMY` — the anatomy spec fails an unclaimed
  hyphenated class, which is how it caught `theme-field` immediately.
  **346 passing** (was 342)

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
  recorded in the FJS-027 finding, open at six of seven at the time and
  closed in v0.16
- ⚠️ `T.sidebar` and `T.modal` had nowhere to land: frame.css paints the topbar
  and the sidebar with `--surface` and there is no `--sidebar-bg`/`--dialog-bg`
  token. Left as one surface; noted in the theme file as the argument for the
  token if the separation turns out to matter

---

### Syntax highlighting — `components/code.css` (2026-08-08)
- ✅ Code blocks are highlighted, by `glow()` in `@frontierjs/toolbelt` — the
  first export that package has ever had. `css` takes it as a **devDependency**
  for the guide and the suite; nothing shipped imports it
- ✅ **The theme ships no class.** glow marks a token with the element that
  already means it (`<em>` a value, `<sup>` a comment) and wraps the block in
  `<code language="css">`, so the whole theme is `code[language] em { … }` —
  nothing for `vocabulary.js` to name, nothing for a consumer to import
- ✅ `code`, `.code`, `pre code` and `kbd` moved out of `typography.css` into
  the new file, so a code block has one owner. Verified behaviour-neutral: nine
  computed-style subjects byte-identical to HEAD
- ✅ **The tones needed correcting before they could be text.** A tone is tuned
  as a fill behind white text; measured as text on `--surface-sunken` across
  the eight themes the raw values ran as low as 1.65:1, and only one theme had
  all six roles above AA. Each now passes through a lightness window in oklch
  (`--tone-l-min`/`--tone-l-max`, `--code-l-*` until v0.16), hue and chroma untouched — a no-op wherever
  the tone already reads, so a well-tuned theme is not flattened. A blend
  toward `--ink` also works, at 55%, and muddies everything equally
- ⚠️ The window cannot be derived: relative colour syntax exposes the channels
  of one origin colour, and the origin is the tone, not the surface. **A dark
  theme must invert it**; `dark.css` and `basecamp.css` do, and `code: every
  token clears AA in theme-*` catches one that forgets
- ✅ `code.spec.js` — 25 assertions against **real glow output**, injected by
  `test/run.js`. **251 passing** (was 226)
- ⚠️ `theme-notebook`'s `--ink-mute` is 2.67:1 and fails AA wherever it is
  text — nine files use it. Pre-existing, not caused here, and not compensated
  for: `FJS-125`

### The Learn wizard — `guide/decisions.js` (2026-08-08)
- ✅ A **decision wizard** as the first page of the guide, in a new `Learn`
  nav group above Start Here. The other 48 pages answer "how does Badge work";
  this one answers the question that comes first — of 54 terms, which one is
  the thing you are about to build
- ✅ 16 questions, **52 outcomes**. An outcome gives the term, its element, its
  class, its tier, a live preview, copy-ready markup (highlighted by glow), the
  tone and treatment chips that actually apply to it, what carries its state,
  and the **near misses** — Pill/Badge, Bar/Toolbar, Alert/Toast/Dialog,
  Item/Row, Popover/Tooltip, Switch/Field. That last part is the teaching; a
  reference page cannot state a distinction it only owns half of
- ✅ **Nothing about a term is written twice.** The wizard names a term; the
  element, class, tier and meaning come from `vocabulary.js` at render time
- ✅ `decisions.spec.js` — 10 assertions, both directions. The one that earns
  its place: **every shipped term must be reachable by some path**, or the page
  whose whole job is completeness is silently incomplete. Verified to fail by
  deleting a path
- ✅ **Found 8 real errors in the first draft of the data**, none visible by
  reading it: `.pill.outlined` and `.badge.outlined` do not exist (outlined is
  a Button treatment); `menu`, `hover` and `divided` go on the list CONTAINER,
  not the entry; `pills`/`stretch` and the tone go on `.tablist`, not `.tabs`;
  `.disclosure.bordered` does not exist. Each would have rendered a control
  that did nothing and taught that treatments are decorative
- ⚠️ **`allRules()` never descended into CSS nested rules.** `surface.css`
  declares `&.raised` and `&.outlined` by nesting, and the walk was built around
  `@layer`/`@media`, so those rules were invisible to every spec reading the
  CSSOM. Fixed; `allSelectors()` is the same walk with `&` resolved for
  `matches()`. **261 passing** (was 251)

### Menus and dropdowns — the answer is composition (2026-08-08)
- ✅ **No Menu term, ruled.** A dropdown menu is `.popover` (surface) +
  `.items.menu` (list) + `role="menu"` and arrow keys, and the third is not
  CSS. Naming it would promise a keyboard contract the package cannot keep —
  the Bar/Toolbar reasoning. `@frontierjs/ui`'s `DropdownMenu` is that exact
  composition, which is the evidence rather than the argument
- ✅ A route to it: the wizard's `anchored` question names menus, the Popover
  outcome states the three parts, and the Popovers page has a **Dropdown menu**
  section with a live anchored menu
- ✅ **`.item` on a `<button>`/`<a>` now gets a control reset.** The documented
  way to build a menu row is to put a real control in it, and then the control
  arrives with a UA background, border, font and width the row cannot
  override. Everyone who followed the advice wrote the same eight lines; the
  kit's copy also drifted the row gap to `0.625rem` — deleted 2026-08-08, `FJS-126` closed, verified by `example`: `verify:ui` 27/27. Scoped through
  `.items` for specificity — `.items.menu .item` is (0,3,0), so a bare rule
  loses the cursor on a disabled row. 3 tests
- ⚠️ **`popovers.css` was still telling people to position with Uno
  utilities** — `class="popover absolute top-12 left-0"` — which the package
  does not ship and, since the UnoCSS ruling, may not require. Replaced with
  anchor positioning. `[popover]` is in the top layer, so a `position:
  relative` parent means nothing and an un-positioned menu opens in the corner
  of the viewport
- ✅ The wizard's own Popover markup had been teaching the anti-pattern
  `lists.css` warns about — a clickable-looking `<li>` with no control in it.
  **264 passing** (was 261)

### The comparison audit — `Why this one` (2026-08-08)
- ✅ Second Learn page: an audit against **Tailwind v4, Bootstrap 5.3,
  Bulma 1.0, Pico 2, Open Props, Radix Themes and Web Awesome**, checked
  against each project's own documentation rather than from memory
- ✅ It carries a *What the others do better* section — a comparison page
  nobody can lose is a comparison page nobody believes. It also had a *Do not
  use this if…* section leading with zero production consumers; **removed on
  request 2026-08-08.** The README still states the alpha position, and
  `## Where this is` below is the register for it
- ✅ The real claim is stated as **multiplication**: Bootstrap needs 17 button
  variant classes because it names each combination (9 solid + 8 outline,
  from its own docs); this needs 7 tones + 5 treatments because the axes stay
  separate, and those 7 tones then work on cards, rows, fields, badges and
  alerts as well
- ⚠️ **`contrast-color()` shipped in browsers around March 2026**, which does
  the black-or-white pick natively in one line. The page says so. What is
  left of the claim is narrower and still true: where white cannot reach
  4.5:1 this dims the FILL rather than flipping the text, so the hue survives
- ✅ Every number about this package is **counted at render time** from
  `VOCAB` and the live CSSOM — 54 terms, 8 tiers, 164 classes shipped. A
  comparison page is the easiest place in a repo to leave a stale number
- ✅ Credit where the ideas came from, including the collision worth knowing:
  Every Layout's `Frame` is an aspect-ratio box and ours is the app shell
  tier; their `Sidebar` is a layout primitive and ours is the nav column
- ✅ `code(src, 'txt')` now skips glow — a plain diagram was being coloured as
  if "Bootstrap" and "Props" were identifiers

### The worked example — one button, three times (2026-08-08)
- ✅ *The classic example: a button* replaces the one-line five-way sample.
  Every framework looks alike on a button until it needs a second variant,
  and alike again until you need a colour it did not ship, so the section
  walks one button through all three
- ✅ Step 2 is a set — solid / outlined / small / disabled / busy — against
  **Bootstrap only**, the closest of the three and the one most readers know.
  Tailwind has no row: there is no set, which is the trade it makes on purpose
- ✅ Step 3 is the payoff. A client's purple, `#6d28d9`: **thirteen
  declarations and four shades you choose** in Bootstrap's own docs' shape,
  a ramp plus the chain at every call site in Tailwind, a Sass map and a
  recompile in Bulma — against `.brand { --bg-mix: #6d28d9 }` here. The four
  *your call* comments are the point: each is a shade somebody picks, and
  picking it wrong is how a system ends up with two purples
- ✅ Step 4 renders that rule **live on the page**, unscoped, so the sample
  and the thing it renders are the same declaration — button, badge, pill,
  field, alert. `comparePage.init` then measures the filled button in the
  reader's browser and writes the ratio into the prose: **7.10:1**,
  independently confirmed by a standalone probe. Nobody wrote that text
  colour down; `#6d28d9` was the only value in the rule
- ⚠️ The measurement goes through a canvas, not a regex. Chrome serialises
  the derived fill as `color(xyz-d65 …)` and parsing those floats as 8-bit
  channels gives a plausible wrong answer for every colour
- ✅ One concession stated in the open: **Pico needs no class for a spinner**
  — `aria-busy="true"` draws it — where this wants the attribute *and*
  `loading`, because the attribute announces and the class draws

### The third axis — density, space and exits (2026-08-08, v0.13)

- ✅ **A space ladder.** The type scale had been tokens for four versions
  and space had never been a scale at all: padding was a literal `rem` in
  whichever file needed it. `--space-3xs … --space-6xl`, twelve rungs on a
  2px grid to 16px and coarser above. **82 declarations across 26 files**
  converted, and 27 of 27 rendered components are **byte-identical** to
  HEAD at density 1 — measured, not assumed
- ✅ **`--density` is the third free-standing axis**, and the exact mirror
  of a tone: a tone is registered `inherits: false` because it is a fact
  about one element; density is `inherits: true` because it is a fact about
  a region. `.dense` (0.8) and `.roomy` (1.25) set it, and every Card, Row,
  Field and Table inside follows with no component told anything
- ⚠️ **The ladder is declared on `*`, not on `:root`.** At `:root` the
  `var(--density)` inside each rung substitutes ONCE, against `:root`, and
  the resulting fixed length inherits straight past every `.dense` — the
  alias trap ruled 2026-08-02, silent because the token still holds a
  perfectly good value. Same mechanism `tones.css` uses for the tint ramp.
  A test moves the ladder back to `:root` and three assertions go red
- ✅ **Density can be derived.** `container: fjs / inline-size` on the app's
  own box, and under 30rem/20rem the package steps density to 0.9/0.8. The
  container rules are on `*` — zero specificity — so **declared beats
  derived**: a stated `.roomy` inside a narrow box stays roomy
- ⚠️ **The package ships no `container-type` of its own, and a test
  enforces that.** Inline-size containment means a box can no longer be
  sized by its contents: measured, a Card inside a Cluster went from
  **83px to 42px**, the width of its own padding, and the same in an
  auto-sized grid track. It also makes the box the containing block for
  `position: fixed` descendants. Dialog and Popover are unaffected — the
  top layer escapes containment
- ✅ **Overlays can leave.** All four vanished on `display: none`; Dialog
  had no entry animation either. `components/overlays.css` owns the tier's
  motion — `@starting-style` + `transition-behavior: allow-discrete` +
  `overlay` — and each component states only its direction via
  `--overlay-from`. The four drawer `@keyframes` are gone. **A Toast leaves
  with `el.hidden = true`**: the exit is a transition on the `hidden`
  attribute, so there is no dismissing class to remember
- ⚠️ **The overlay spec reads rules, not computed styles**, and says why:
  measured, headless Chrome under `--virtual-time-budget` runs almost none
  of the transition lifecycle for a top-layer element — `transitionrun` and
  `transitionend` never fire at all, not even for the entry that
  demonstrably runs. A Toast, which is not in the top layer, reports the
  whole lifecycle both ways
- ✅ **A Disclosure animates open.** `interpolate-size: allow-keywords` at
  the root plus `::details-content` make `height: 0` → `auto` animatable —
  the thing CSS could not do for twenty years and every accordion measures
  in JavaScript instead
- ✅ `text-wrap: balance` on headings, `pretty` on the two prose surfaces
  the package owns (`alert-content > p`, `.empty-text`). The package styles
  no bare `p` — it is not classless
- ✅ **Card bleed margins are the card's own rung**, not a literal that
  happens to match: `.card > .surface-header` used `-1.25rem`, which would
  have stayed put while the padding moved and misaligned every card inside
  a `.dense` region
- ✅ 281 tests (was 264): `space.spec.js` 11, `overlays.spec.js` 6. Both new
  files were proved to fail — the ladder moved to `:root`, a literal put
  back, `allow-discrete` removed, an `@starting-style` deleted
- ✅ Guide: **51 pages**. New `Foundation → Density & space`; *Kinds of
  class* is four kinds; the compare page's list is five things, and its
  platform-state item now covers exits

### How things behave — the page the vocabulary could not be (2026-08-08)

- ✅ **`Spacing` is retired and `How things behave` takes its slot.** The old
  page documented a 4px numeric scale the package never had and a set of
  `p-*` / `m-*` / `gap-*` margin utilities it does not ship — on a page whose
  real subject was who *owns* the space. `#spacing` rewrites to `#behaviour`
  through the existing `RENAMED` map
- ✅ Built out of a 2026-05 design note rather than invented. Three
  principles, all of which the package already obeyed silently:
  **the parent owns the space between children**; **pad the child first out
  of context, then decide the gap in context**; **does the child shape the
  parent (flex) or the parent constrain the child (grid)?**
- ✅ The third one **predicted the container-query trap** before it was
  measured. `container-type: inline-size` means precisely *this box no
  longer takes its shape from its children*, so it broke the flex case
  (83px → 42px) and an auto-sized grid track, and left a fixed track alone
- ✅ The ownership claim **counts itself at render time**: 43 gap
  declarations, 5 negative margins (the documented exception — a child
  pulling out of its parent's padding) and **10 ordinary margins left over**,
  stated on the page as the honest count of places the rule is not followed
  yet. An earlier grep said "4" and was too narrow
- ✅ Two more sections the guide had nowhere for: **what is making the
  width** (the diagnostic — delete all the whitespace, what is the longest
  row and why) and **when a wrapper div is justified** (is there a
  background, a border or a shadow? otherwise it is a Layout term, or the
  plural of what it holds)
- ⚠️ **Three pages were quoting source that had moved.** Layouts showed
  `gap: 1rem` for rules that now read `var(--space-2xl)`; Headings showed
  literal rems for `font-size`; Spacing's whole scale. All three now render
  through `ruleText(selector)`, which reads the live CSSOM — a page that
  documents source has to read the source, not remember it
- ⚠️ `ruleText()` reads **authored `cssText`**, never `rule.style`. Iterating
  `rule.style` expands `gap: var(--space-sm)` into `row-gap` and
  `column-gap` and then answers `""` for both, so the first version printed
  `row-gap: ;` and looked like a broken stylesheet. Same trap
  `space.spec.js` hit, in a different place

### The demo, brought up to date (2026-08-08)

- ⚠️ **The demo was defeating the new toast exit.** `demo.js` did
  `setTimeout(() => el.remove(), 4000)` — taking the node out of the DOM
  skips the transition entirely, so the toast blinked out of existence. It
  now sets `el.hidden = true` and reclaims the node afterwards
- ⚠️ **That reclaim is a timeout, not a `transitionend` listener**, and
  deliberately: a transition that never starts never ends, and a listener
  that never fires leaks the node forever. Measured in this harness, neither
  `transitionend` nor `animation.finished` resolves for a hidden Toast. The
  delay is read from the package's own `--overlay-time` so the two cannot
  drift
- ✅ **A density control in the invoices toolbar** — the fastest way to see
  the third axis is real, and a genuine SaaS affordance rather than a
  demonstration. Driven in a browser: table cell padding 6px → 4.8px →
  7.5px → 6px, and **the badges in the bar above the table follow too**
  (8px → 6.4px → 10px). One number on the Pane; nothing is told which
  components exist. ~4 lines of JS
- ✅ Disclosure needed nothing — the demo already has one, and it animates
  open for free
- ✅ `demo.css` is unchanged and still one rule. It is the package's gap
  measurement, and nothing shipped this week added to it

### Wireframes on the wizard's first question (2026-08-08)

- ✅ Each of the eight options on *What are you reaching for?* now carries a
  small wireframe: an inline chip inside a line of text, a block owning a
  row, a scrim with a panel over it, a persistent top strip, a label and a
  field, three dashed boxes with no fill, a heading over its paragraph, and
  a shell with a rail
- ✅ **Eleven of the sixteen questions**, not just the first — the earlier
  claim that everything below the root asks what a thing *does* was too
  broad. Drawn wherever the answer is a SHAPE: the shell part by part, the
  five arrangements, the eleven kinds of block, the six kinds of wayfinding,
  Card/Tile, Item/Row, Section/Group, Dialog/Drawer, Heading/prose.
  **50 of 69 options carry one**
- ✅ **Five questions are deliberately undrawn, and each omission is the
  point.** `inline` — a Button and a Link are the same shape, and drawing
  them would say the choice is visual in the one place this wizard most
  needs to say it is not. `waiting` — its own note says picking wrong is an
  accessibility bug rather than a style choice, and a picture invites
  picking by look. `strip` — Toolbar and Bar are the same shape BY DESIGN,
  so two identical drawings would teach that the question is meaningless.
  `anchored` and `form` — two of three options each resolve to the same
  term, so a set would show one drawing twice
- ✅ Built from divs and theme tokens — no SVG, no asset — so the drawings
  follow the theme switcher. Widths arrive on `--w`, a token assignment
  rather than a style override, the same convention the demo uses for
  `--avatar-size`
- ✅ Kept in `guide.js` as `WIZ_SKETCH`, keyed by the option's `to` id, not
  in `decisions.js`: that file is routing data with a spec guarding it
  against the vocabulary in both directions, and a drawing is chrome
- ⚠️ A coverage probe walks every question by clicking through the wizard
  and flags any sketch part with zero area. It found five — `flex: 0`
  written inline on a row that already declares `flex: 0 0 auto`, which
  re-expands to `flex: 0 1 0%`: a zero basis with no grow, so the row
  measured 0 tall. The probe's own first version called `location.reload()`
  to reset between paths, which tore down the document it was measuring and
  reported every part as collapsed
- ⚠️ Two things had to be measured rather than eyeballed. `align-items:
  center` on a sketch row collapsed every `flex: 1` box to a hairline, so
  the arrangement sketch rendered as one dashed rule. And the fills were
  mixed into `--rule`, which is tuned as a hairline divider and vanishes
  against `--surface-sunken` — the shell's content area read as empty and
  its rail as a stray nub. Both now mix into `--ink`; checked across all
  eight themes, the weakest is 3.02:1 against the sketch surface

### Search — the corpus is harvested, not written down (2026-08-08)

- ✅ **`⌘K` / `Ctrl+K` anywhere, `/` when the caret is not in a field.** One
  box over the whole guide: the 54 vocabulary terms, 51 page titles, every
  section heading, and every word of body text — which is what makes a class
  name work as a query. `surface-header` typed out of an app's markup lands on
  the four sections that document it; `.list-row` lands on the term Row
- ✅ **`buildSearchIndex()` renders all 51 pages into a detached node** at idle
  after boot (~150ms measured) and reads the sections back out of the markup.
  A written index of a 51-page guide goes stale on the first heading anyone
  edits, and goes stale *silently* — a missing entry looks like a page with
  less in it. The one thing that had to be shared rather than reimplemented is
  the section id: harvesting calls the same `tagSections()` the live render
  calls, so a result's href and the id it lands on are one function, including
  how both number a duplicated heading
- ✅ **The ranker is `guide/search.js`, a classic script, so a spec can hold
  it.** Same split as `decisions.js` and for the same reason: `guide.js` is an
  ES module that imports glow, so the suite cannot inline it, and a search box
  whose ranking nothing checks goes subtly wrong in silence. `search.spec.js`
  is 8 tests over a corpus of the real 54 terms plus one deliberate decoy — a
  body-text entry naming every term three times, which is what a long guide
  page actually is
- ✅ **Both directions, again.** Every term must be the first hit for its own
  name *and* for its class name — and the second is the one that matters,
  because the class is nowhere in the term for eleven of the 54 (`btn`,
  `list-row`, `navlist`). Proven by mutation: removing the class lookup, or
  splitting tokens on `-`, or letting a title score what body text scores, each
  turns the suite red
- ✅ **A title outranks any weight of body text**, because a guide repeats its
  own vocabulary constantly — rank mentions near titles and the answer to
  "card" is whichever page talks about cards the most. Frequency only breaks
  ties, capped at +5. Adding it was measured, not assumed: without it "dense"
  answered with a table's Variants section, which says the word once, above the
  three sections of the Density page that are about nothing else
- ✅ **`vocabClass(row)` now lives in `vocabulary.js`.** Which class a row names
  is a two-branch rule with a trap in it — an absent fourth element means the
  lowercased term, an explicit `null` means the term has no class — and it was
  being applied in two places about to become three. A truthiness reading turns
  Heading into `.heading`, a class the stylesheet does not ship
- ⚠️ **Five deliberate non-features.** No fuzzy matching (a CSS guide is
  searched with exact class names, and fuzz on 400 entries returns noise); no
  stemming; no search-as-you-type debounce (the corpus is in memory, a keystroke
  costs under a millisecond); no result count (a number nobody acts on); no
  history (the palette is a jump, not a session)
- ⚠️ Driven in a real browser, not eyeballed: 15 checks over the palette —
  opens, focuses, ranks, arrows wrap, Enter navigates *and* closes, Escape
  restores focus to the trigger, `/` is inert inside a field, and every section
  href a query produces resolves to a real id on its own page

### Anatomy — the half of Structure that was prose (2026-08-08, v0.14)

- ✅ **`ANATOMY` in `vocabulary.js`: which children each term expects.** VOCAB
  has answered "which element, which class" for all 54 terms since v0.12, in
  both directions against the real CSSOM. It never answered "which children" —
  that lived in **seven guide pages as hand-written markup**, one sentence on
  the taxonomy page, and a convention. **25 terms have an anatomy, 42 named
  parts, one canonical markup block each**; the other 29 are a single element,
  which is itself the answer
- ✅ **A part is OWNED once and BORROWED after.** Card, Dialog, Drawer and
  Popover all take the Surface sub-regions; listing them on four terms would
  say there are four headers with four meanings, which is the claim the whole
  lineage denies. `parts` vs `uses` makes the sharing a statement rather than
  a repetition, and `anatomy: every class it borrows is owned by some other
  term` is what keeps it true
- ✅ **A part need not be a class.** Facts ships none on purpose — the `<dl>`
  styles its own `<dt>`/`<dd>` — and declaring that is what stops someone
  adding `.fact-label` to make the pattern look like the others
- ⚠️ **The convention it replaces was wrong five times.**
  `vocabulary.spec.js` treats any hyphenated class as Anatomy and skips it.
  That accepts `.alert-anything`, and it mislabels `.code-inline` (an alias
  for the `<code>` element), `.sidebar-first` (a modifier on Shell),
  `.skip-link` and `.visually-hidden` (a11y utilities) and `.list-row` (the
  Row term's own class). `NOT_ANATOMY` names all five, plus the three
  families — eight themes, eleven `text-*`, four `from-*` — **by name rather
  than by prefix**, because a prefix rule is exactly how `.alert-anything`
  gets in
- ⚠️ **It caught the vocabulary lying about an element on its first run.**
  VOCAB said Tooltip is a `<div role="tooltip">`. Four places ship a
  `<span>`: `tooltips.css`'s own anatomy comment, the guide twice, and
  `@frontierjs/ui`'s `Tooltip.mesa` — and they have to, because `.tooltip` is
  chip lineage and `.tooltip-anchor` is an inline-flex `<span>`, so a `<div>`
  inside it is not phrasing content. The one element the vocabulary named was
  the one element its own anatomy could not legally contain. `tooltips.css`
  had said both things in the same file header for four versions
- ✅ **`anatomy.spec.js`, 10 tests, and the last three are the ones nothing
  else could do.** Every markup block must render every part it claims;
  the element carrying the term class must be the tag VOCAB names — asked of
  the term, not the root, because Table's canonical markup opens `.table-wrap`
  and Field's opens `.field-group`; and **every part must match a rule where
  the markup puts it**, which is the `.items.menu .item` failure asked as a
  question. Computed styles cannot answer the last one: several parts only
  differ on `:hover` or `[aria-current]`
- ✅ **`declaredClasses()` moved into the harness.** Two specs now ask it the
  same question from opposite ends — vocabulary for *is every term's class
  real*, anatomy for *is every real class claimed* — and two copies of the
  CSSOM walk would drift the day one started counting nested rules
- ✅ **A new guide page reads all of it**: Structure → Anatomy, 27 sections,
  25 live previews, nothing written by hand. **The seven pages that carried
  the markup keep it** — they are not duplication, they are demonstrations
  with the edge cases in them (a label long enough to wrap, an avatar inside
  a value, a page control that is present and unavailable), and swapping them
  for the canonical block would have cost coverage

### A copy button on every code block (2026-08-08)

- ✅ **178 blocks, 178 buttons, on all 52 pages** — every sample, every
  `Source` section showing the real CSS, every canonical markup block on the
  Anatomy page. `code()` wraps its own output, so a block gets one by
  existing rather than by being remembered
- ✅ **The control is a SIBLING of the `<pre>`, not a child.** `.code`
  declares `overflow-x: auto`, so a button inside it rides off the edge with
  the first line long enough to scroll
- ✅ **Dimmed at rest (0.55), not hidden.** A button that appears on hover is
  unreachable on a touch screen and invisible without a pointer, and at 178
  blocks the affordance has to be discoverable once rather than per block
- ⚠️ **It copies the authored source, held by index, not `pre.textContent`.**
  `mark: true` turns `•x•` into a `<mark>` and REMOVES the bullets; glow's
  diff markers go the same way. Measured, **all 178 blocks round-trip
  identically today**, so textContent would work and this is correct by
  construction rather than a fix for a live corruption — kept because the
  Code page documents `•text•` as the way to mark a line, so the guide
  teaches the one syntax that breaks the cheaper implementation, and the
  failure is silent on both sides of the clipboard
- ⚠️ **`navigator.clipboard` is secure-context only and `file://` is not
  one** — and opening `guide/index.html` off disk is a documented way to read
  the guide. The off-screen `<textarea>` + `execCommand` path is a fallback
  the guide needs, not a legacy branch. A refused clipboard says
  *Press ⌘C* rather than reporting failure
- ⚠️ `CODE_SRC` is reset per render. `buildSearchIndex()` renders all 52
  pages into a detached node and pushes a few hundred throwaway entries, so
  it truncates back to the mark it found — verified by copying after the
  index builds and getting the live block's own source

### The two axes — the guide's one diagram (2026-08-08)

- ✅ **A Foundation page whose centrepiece is a hand-built inline SVG.** The
  argument it makes is that a tone and a density are the same idea pointed at
  different problems — one variable in, a whole system out — and that what
  separates them is one line of `@property`. Left half: `--bg-mix` → three
  tints → a text colour branched on luminance, inside a boundary that stops.
  Right half: `--density` → twelve rungs → the same rung at three densities,
  inside boundaries that are crossed
- ✅ **Every number is read or measured at render time.** The mix percentages
  and the two luminance constants come out of the authored CSS; the twelve
  rungs and the three densities are measured off probe elements appended to
  this document, because a rung is `calc(rem × var(--density))` and the only
  honest way to know what one IS here is to give an element that width and
  ask. A diagram is the easiest thing in a repo to leave stale — nothing
  renders wrong when it rots, the picture still looks like a picture — so
  this one goes wrong visibly instead
- ✅ **Inline SVG, no chart library.** `var(--…)` inside it resolves against
  the live theme, so the drawing follows the switcher: measured, the source
  chip moves from `rgb(244,64,58)` to `rgb(185,28,28)` between default and
  forest, and under `theme-dark` the tint swatches re-mix into the dark
  `--surface` rather than staying pale
- ✅ **Both halves report a VALUE at each level**, which is what makes the
  mirror land: the left says `--bg-mix stated` on the Card and
  `--bg-mix unset` on its Button, the right says `--density: 0.8 stated` on
  the Pane and `0.8 inherited` on the Card and the Row inside it
- ⚠️ **`tokenValue()` looks a property up by PROPERTY, not by selector.** The
  first version asked for the selector as authored — `*, *::before, *::after`
  — and got nothing, because the CSSOM serialises that as
  `*, ::before, ::after`, dropping the redundant `*`. The tint ramp read as
  absent and the three swatches it feeds rendered as nothing at all, on a page
  whose whole claim is that its numbers are live
- ⚠️ **Three collisions the assertions could not see.** The `roomy` bar landed
  on top of the `inherits: true` box, an arrow ran through the word it was
  meant to point at, and the two halves' boundary blocks did not line up.
  Numbers passing is not a diagram that looks right — it took screenshots at
  three sizes and two themes, and the fix for the third was to drop the arrow
  entirely for the per-level values above
- ⚠️ **The 11px SVG labels are unreadable at a phone width**, which is why the
  page carries the same facts as tables underneath rather than as a caption.
  The `<desc>` is a real description, not a filename

### Every class, searchable — the cheat sheet's class index (2026-08-08)

- ✅ **All 166 classes the stylesheet ships, read out of the live CSSOM**, each
  with its kind, one line saying what it is, and which files declare it —
  `.surface-header` names four. Typing `header` returns `.surface-header`,
  `.section-header`, `.dialog-close`, `.surface-body` and `.topbar`; typing
  `tables.css` returns the six classes that file declares. Every token is
  required to land, same rule as the ⌘K palette, so a second word narrows
- ✅ **The kinds are read, not assigned**: 50 terms from VOCAB, 42 parts from
  ANATOMY with their owner named, 28 excused by NOT_ANATOMY, and 7 tones /
  4 treatments / 2 densities / 23 scoped modifiers / 4 containers / 6 heading
  classes from NOT_A_TERM. **The table is therefore a test result** — a row
  reading `unclassified` means a class nothing names, which
  `vocabulary.spec.js` and `anatomy.spec.js` refuse to allow. Currently zero
- ✅ **`NOT_A_TERM` moved from `vocabulary.spec.js` into `vocabulary.js`**,
  where the guide can read it. A register of decisions that only the tests
  can see is one the documentation has to guess at — the same reason ANATOMY
  and `vocabClass` live there. The spec's copy had to go in the same edit:
  both files are inlined into one page as classic scripts, so two
  declarations of the name is a SyntaxError that takes the suite with it
- ✅ **Twelve kinds, not eight.** `not a part` had become a bin: it held the
  eleven `text-*` utilities, the eight themes, the a11y layer and four
  Drawer directions, and calling all of them *not a part* said nothing.
  Split into **utility** (12), **theme** (8), **a11y** (2) and a residue of
  **6** — `.code-inline`, `.sidebar-first` and the four `.from-*`, which is
  a short enough list to actually read
- ⚠️ **The a11y group is identified by where a class SHIPS, not by name**, so
  a third class added to `a11y/` joins it without anyone remembering. But the
  test runs after the `NOT_A_TERM` loop, deliberately: `.focusable` ships in
  `a11y/a11y.css` and the register calls it a scoped modifier, and a display
  rule that quietly overruled the register would make the guide and the suite
  disagree about what a class is with nothing to say which was right. It
  stays a modifier and reads *only on `.visually-hidden`*
- ✅ **Every note is specific to its class, and derived.** The first version
  wrote one sentence per KIND, so twenty-three modifiers all read *reads like
  a treatment, only works on one Element* and both densities read *the density
  axis*. True, and useless — the badge beside it had already said the kind.
  Now: `.dense` reports `--density: 0.8 — tightens every space rung by 20%`
  (measured off a probe), `.striped` reports `only on .table — sets
  --row-base: var(--surface-sunken)` (its own scope and declaration, out of
  its own selectors), `.narrow` and `.wide` are told apart by their values,
  `.from-left` says which edge it slides from, `.text-lg` reports 16px here,
  and each theme reports its measured `--color-primary` and how many tokens
  it overrides
- ✅ **Zero rows share a note with another row of the same kind**, down from
  five groups covering 26 classes — a property worth stating because it is
  checkable, and it is what "the column is useful" actually means. The last
  group to fall was four themes that genuinely override the same NUMBER of
  tokens; they differ in which, so the row shows the colour instead
- ⚠️ **A one- or two-declaration summary shows the VALUE, three or more shows
  only names, and there is no `+N` remainder.** A rule is attributed to every
  class its selector mentions — `.items` collects what `.items.menu .item`
  sets — so a count would read as complete when the attribution is
  deliberately loose
- ✅ **Kind toggles above the table**, one per kind with its count, plus
  `All`. Several selected is a union; `All` clears the kinds and deliberately
  leaves the text box alone, because the two are separate filters and
  resetting one should not silently reset the other. Text AND kind, never
  either alone — kind-only would make typing do nothing while a filter is on,
  which is the version people report as broken
- ✅ **Pressed is `[aria-pressed]`, never a class** — the convention the
  package keys every other state off, because a control that LOOKS pressed
  while announcing itself unpressed is a divergence a class makes possible and
  an attribute makes unrepresentable. **The package ships no `aria-pressed`
  styling at all**, so this is guide chrome; being unlayered is what lets it
  beat `.btn.outlined` with no specificity fight
- ✅ **The pressed fill is not chosen, it is derived.** The rule sets
  `--bg-mix` and lets `chip.css` do the rest: measured, a pressed toggle's
  background lands at `color(xyz-d65 … 0.1783 …)` — exactly the luminance
  constant the contrast system targets — with white text the package computed
  rather than the guide picking one
- ⚠️ **A measurement said the pressed styling was backwards, and it was
  lying.** Reading `getComputedStyle` after clicking a toggle reported the
  unpressed colours, because computed styles go stale after an attribute
  change in this harness — the trap this package's own notes record. Measuring
  a freshly-rendered pressed button showed the rule was right all along. The
  fix was to the probe, not the CSS
- ⚠️ **The prose promised a search the markup could not do.** It said typing
  `tables.css` finds that file's classes, and the row's haystack held only
  the name, kind and note — not the file. Caught by asserting the promise
  rather than the mechanism: the probe searched `tables.css` and got nothing

### Item grows an anatomy, and `.clamp-*` ships (v0.14.6, 2026-08-10)

Prompted by reading one line of the guide's own ⌘K markup and asking why a
search hit needed seven bespoke classes when it looks like a list of cards.

- ✅ **`.item` had no named parts at all**, which is why the same four classes
  existed twice in the repo: the guide's ⌘K wrote `.sg-search-text/-title/-sub`
  and `@frontierjs/ui`'s CommandPalette wrote `.cp-row-text/-label/-sub` in a
  local `<style>`. Two private solutions to one shape, neither reusable, and
  the kit's copy in literals no token or `.dense` could reach (`FJS-129`).
  Now `.item-text` / `.item-title` / `.item-sub` / `.item-lead` in `lists.css`
- ✅ **All four parts are optional**, so a one-line Item is untouched. The
  anatomy is additive — nothing that already writes `.item` has to change
- ⚠️ **`.item` is `align-items: center` and a stacked Item must not be.** A
  gutter centred against a three-line block sits opposite the SUBTITLE, not
  the title it labels. Keyed `.item:has(.item-lead)`, so the switch is paid
  for only by rows that have a gutter. A bare `.item { align-items: baseline }`
  would fix the palette and quietly misalign every badge-and-text row in the
  package — both directions are held by a test
- ✅ **`.clamp-1/2/3` is a utility, not anatomy on Item.** The need is
  orthogonal to what the text sits in: a card description and a table cell
  want it too. The reason it ships at all is that a snippet which grows makes
  a list JUMP as a query narrows — the failure belongs to the list, not to the
  paragraph
- ⚠️ **The prefixed clamp is the floor and the modern one wins, and the order
  is load-bearing.** `display: -webkit-box` is a whole box model, so the
  `@supports (line-clamp: 2)` block puts `display` back to `flow-root` where
  it is understood. Measured in Chrome 150: 40px against an unclamped 120px,
  computing `flow-root`, so the modern path is the one running. Reversing the
  two blocks still clamps here, which is what would make the lost fallback
  silent
- ⚠️ **The first shrink test passed against a build with the declaration
  deleted.** It measured the ROW, and an `<li>` is block-level so it takes its
  container's width either way — the broken build reported 200px exactly like
  the working one. Two things were wrong: the title has to be `nowrap` for the
  question to exist (wrapping text never exceeds its container), and the
  overflowing CHILD is where the failure is visible (409px inside a 200px
  row). Verified by breaking the CSS three ways and confirming each break goes
  red
- ✅ **Guide chrome down from seven classes to two.** `.sg-search-hit` keeps
  only the active/focus states, and the kind gutter keeps only what is about
  search — mono, uppercase, and the one tone. `.sg-principles` went the same
  way in the same pass: `display: grid; gap: 12px` is `.stack.gap-lg`, and
  `--space-lg` is 12px exactly, so nothing moved

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
   Vocabulary table lists all 35 terms and every one has a page. *(54 since
   2026-08-08; see the Vocabulary section above.)*

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
- **v0.6 nav** — `.breadcrumb`, `.pagination` / `.page` (the link renamed to
  `.pagination-link` in v0.14.6), and `.navlist` / `.navlink` for the
  sidebar. All three take their current item from
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

## Added — `--scrim`, the dim behind an overlay (2026-08-16)

`.dialog::backdrop` and `.drawer::backdrop` each carried `rgba(0, 0, 0, 0.45)`
as a literal, and `@frontierjs/ui`'s command palette — which portals its own
backdrop rather than using a `<dialog>` — carried `rgba(0,0,0,0.72)`. So the
package dimmed by one amount, a kit component by another, and no theme could
retune either.

`--scrim` is that value, in tokens.css, read by both backdrops and by the kit.
**It is a literal rather than a blend of `--ink`**, and that is the whole note
worth keeping: `--ink` inverts with the theme and a scrim never does, so mixed
from ink it would go WHITE on a dark theme.

## Fixed — `.avatars` overlapped nothing and ringed nothing (2026-08-16)

The overlap and the ring were `.avatars > .avatar + .avatar` and
`.avatars > .avatar`. `.avatar` has to stay a plain box — chip.css owns its
layout — so anything pinning a status dot to its corner needs a positioning
element around it, which is exactly what `@frontierjs/ui`'s `Avatar` does. The
direct-child selectors then matched **nothing at all**: a six-person group
rendered as an ordinary evenly-spaced row with no rings, and every class
assertion in both packages passed the whole time.

Both rules now match an avatar OR a wrapper holding one
(`:is(.avatar, :has(> .avatar))`). Found by `@frontierjs/ui`'s new browser
drive, by the only form of the question a test can ask: measure the first two
avatars' rects and check that the second starts before the first ends
(`FJS-302`).

## Fixed — the last five token gaps, and both ink failures (v0.16, 2026-08-16)

*`FJS-162`, `-163`, `-164`, `-288`, `-125`, closed. With the four before them
the theme surface is now closed on everything press.css found.*

**Motion** (`FJS-162`) — every transition in the package was a literal, so nine
themes moved identically. Four rungs named for the job — `--motion-fast` (a
colour changing), `--motion-base` (a control changing shape), `--motion-enter`
(overlays), `--motion-slow` (a measurement moving) — plus two loops,
`--motion-spin` and `--motion-shimmer`, and three easings. **The sweep found one
the grep did not**: `.skeleton`'s 1.4s shimmer. Two exclusions in the test are
the substance rather than housekeeping — a literal inside
`prefers-reduced-motion` is correct (the reader's setting, and tokens.css hands
the spinner back a slower 1.6s there), and the harness's own `transition: none
!important` is the one stylesheet on the page with no `href`.

**The overlay tier caught the alias trap in the act.** The first version was
`:root { --overlay-time: var(--motion-enter) }`, which resolves once against
`:root` and inherits past every `.theme-*` — so a theme retuning the ladder
would have moved everything except the overlays. It reads
`var(--overlay-time, var(--motion-enter))` at each use site instead, which puts
a comma INSIDE a transition segment and turned `overlays.spec.js` red: the spec
split the list on `,` and reported every property as missing its
`allow-discrete`, against CSS that was exactly right.

**Typography treatment** (`FJS-163`) — a table head, a tile's label and a nav
group's heading are one role and had three undocumented answers to it
(600/0.04em, 500/0.04em, 700/0.06em), none reachable from a theme. One triple,
three readers, **weights unified rather than each kept behind its own escape**:
three values for one role was the defect. Plus `--heading-font-weight`, written
as the fallback arm exactly like `--heading-letter-spacing`, so unset keeps
700/600.

**The focus ring's style** (`FJS-164`) — the row's counter-argument was real: a
token a theme can write is a token a theme can weaken. `@property` is what makes
*a keyword from a fixed list* enforceable rather than advisory.
`--ring-style` is registered `syntax: "solid | dashed | double"`, so a value
outside it is invalid at computed-value time and falls back to the initial
value: **a theme writing `none` gets a solid ring, not no ring.** There is no
spelling of "off", and `dotted` is excluded for the reason `none` is.

**The toned block** (`FJS-310`) — `--tint-ink` is the 55% blend toward `--ink`
and one pair of it was under AA: sunset's warning at 3.86:1. It now goes through
the same legibility window `--tone-ink` does, which is the 2026-08-08 ruling
(*clamped, not blended*) reaching the last place in the package that had not
applied it. Measured across 10 themes × 7 tones: a no-op on 53 of the 70 pairs,
17 move and all 17 move UP, none regresses, sunset/warning lands at 6.77:1.

**notebook's ink ramp** (`FJS-125`) — `--ink-mute` was 3.06:1 on `--surface` and
2.67:1 on `--surface-sunken`, and nine files use it as body text. The finding
offered two ways out and the whole ramp moves, which is the first: fitting the
failing rung alone puts it within 0.06 of the old `--ink-soft` and the three
tiers collapse into two. Both rungs are the same colour scaled uniformly in
linear RGB — chromaticity exact — so this is the identical sage, dark enough to
read: `--ink-soft` 4.94 → 6.62 and `--ink-mute` 2.67 → 4.61 on the tightest
ground, a 1.44× step between them. **notebook is now an ordinary member of
`contrast.spec.js`'s theme list**, which is what makes the exclusion impossible
to forget to remove.

`contrast.spec.js` now asks all three questions a tone faces and they fail
apart: as a FILL under text, as TEXT on a surface, and as a toned BLOCK — the
third had never been checked. press.css takes the new knobs: linear easing at
80–120ms, a 700/0.1em stamp on the small labels, and a `double` ring.
**464 passing** (was 412).

---

## Fixed — a Popover is usable without writing two rules first (v0.16, 2026-08-16)

*`FJS-132`, closed.*

`.popover` was `position: absolute` with no inset, so a term the vocabulary
NAMES needed two rules from every consumer before it worked: a positioned
ancestor, or it resolved against the page, and an offset, or it resolved to its
STATIC position — centred on its own trigger, measured in the demo at 265px tall
and `y = -39`, hanging off the top of the viewport. `.tooltip-anchor` had solved
the identical problem for Tooltip since v0.4.

- **`.popover-anchor`** mirrors it: `position: relative; display: inline-flex`.
  A `<div>` where the tooltip's is a `<span>`, because a Popover is an
  `<article>` and a `<span>` cannot contain flow content — the same anatomy
  constraint that made Tooltip a span, pointing the other way.
- **The default placement ships with it**, scoped to `.popover-anchor >` rather
  than written on `.popover`, so a popover placed by anchor positioning or a
  style attribute is untouched. Opting into the anchor is what opts into the
  placement.
- **The row's open question — whether a default offset belongs on a term with
  four plausible edges — is answered "below, and one modifier".** A popover in
  practice is a dropdown; the other three edges are what anchor positioning is
  for, and this file is not growing a placement ladder. `.align-end` exists
  because it is the case the package's own demo needed: a trigger at the end of
  a bar opens a menu that would otherwise run off the viewport. Named for what
  it does rather than reusing `.end`, which on Tooltip means the SIDE the
  attachment sits on.
- **The top-layer trap is now enforced rather than documented.** The placement
  rules say `:not([popover])`: a native popover is in the top layer, where an
  inset resolves against the viewport, so the anchor would move it somewhere
  arbitrary.

`demo/demo.css` is back to one rule — the file exists to measure what the
package makes a consumer write, and the Popover pair was two of its three. The
guide's own Popover page had hand-written `style="position: relative"` and an
inline offset for as long as it existed; both are gone.

Five assertions in `components.spec.js`, all geometry: below the trigger,
start-aligned, `.align-end` flips it, a native popover is left alone, and a
popover outside an anchor is still unplaced. **412 passing** (was 407).

*One trap came out of writing them:* `getComputedStyle` resolves `top: auto` to
a USED pixel value on a positioned, laid-out element, so an unplaced popover
answers `0px` rather than `auto` and the obvious assertion passes on layout
noise. Ask the geometry, or ask whether the selector matches.

---

## Fixed — the theme surface reaches four more decisions (v0.16, 2026-08-16)

*`FJS-158`, `-159`, `-160`, `-161`, closed together. They are one piece: all
four were found writing `press.css`, whose whole job is to answer how far the
token surface reaches on its own.*

**Only one of the four was a missing token.** The other three were tokens that
stopped at the element they were written on, which is invisible in any demo one
element deep — and it is why every assertion in the new `theming.spec.js`
measures a **descendant** of the element carrying the token.

- **`--border-width`** (1px), the structural hairline: 15 sites across surface,
  buttons, pills, fields, tables, frame, code, popovers, disclosure, bars,
  lists, facts, tabs and a11y. `--field-border-width` and `--table-border-width`
  fall back to it, because the row was right that a Field's box, a Card's edge
  and a Table's divider are three decisions.
- **`--surface-shadow`** (`none`), resting elevation on the Block tier. `.raised`
  keeps `--shadow-md`, so a theme setting both gets the stamp at rest and the
  ladder on lift.
- **`--app-bg` / `--topbar-bg` / `--sidebar-bg` / `--dialog-bg`**, the frame's
  own grounds. basecamp has its prototype's three dark surfaces back.
- **`--space-*-base`**, the ladder's shape. A rung is `base × density` and only
  the base inherits, so a theme sets the base and never the rung.

**Three general rules came out of it**, each one a way to get this wrong:

1. **A default that is another token is a use-site fallback, never a `:root`
   declaration.** `--topbar-bg: var(--surface)` at `:root` resolves once and
   inherits that colour past every `.theme-*`.
2. **A token a theme must reach cannot be declared on the component.** The first
   `--table-border-width` was `.table { --table-border-width: var(--border-width) }`,
   which reads correctly and is unreachable from an ancestor — caught by the
   test, not by inspection. `--table-bg` stays declared: the difference is
   whether the token is for a caller styling one table or a theme styling every
   table.
3. **What is drawn with `border` and is not a border does not scale.** A spinner
   ring, a tooltip arrow, a step marker's disc — pinned by a test, because the
   tempting version of `--border-width` is a blanket sweep of every `border:` in
   the package. The one pair that must stay related is the tab indicator:
   `calc(var(--border-width) + 1px)`, bleeding by the strip's own weight, or a
   3px theme draws a rule with a 2px underline over it and the selected tab
   reads as a gap in the line.

**A ground carries no ink, which is the half `FJS-161` had slightly wrong.**
`--sidebar-bg` does not give a light app a dark sidebar — the labels inside still
read the light ramp. That needs no new mechanism: a theme is a class of
inheriting tokens, so `<nav class="sidebar theme-dark">` inverts the ramp for the
region. Grounds separate surfaces within one ramp; a theme class inverts one.
Both are in `frame.css`'s header and both are pinned.

`theming.spec.js` is 29 assertions. **407 passing** (was 378).

---

## Fixed — a tone rendered as text goes through a window (v0.16, 2026-08-16)

*`FJS-027`, closed. The finding below is the argued detail; what follows it is
what the fix turned out to be, which is not what the finding proposed.*

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

**The suggested fix was the same move `.ghost` makes** — neutral ink untoned,
the raw tone where a tone class is present:

```css
.btn.outlined {
  color:        var(--bg-mix, var(--ink));
  border-color: var(--bg-mix, var(--rule-strong));
}
```

**It was not taken, because measuring the whole grid showed it fixes the column
the finding looked at and leaves the rest.** Untoned was one of eight cases per
theme; across 9 themes × (untoned + 7 tones), `.btn.outlined` was under AA on
**34 of 72 pairs**, worst 1.19:1 (`dark`/`secondary`) — and `.btn.link` on 30,
`.btn.ghost` on 24, all of the ghost failures toned. The suggested fix touches
none of those: `var(--bg-mix, …)` still paints the raw tone whenever a tone
class is present, which is the majority of the failures.

**What shipped is one derivation, in `tones.css`.** `--tone-ink` is the tone
with its lightness clamped into `--tone-l-min/max` — hue and chroma untouched
— which is the ruling `code.css` had already been running under a code-only
name since 2026-08-08. Renaming the window (`--code-l-*` → `--tone-l-*`) is
what makes it one owner rather than two. The three variants read
`var(--tone-ink, X)` and differ only in `X`: `.outlined` and `.link` take the
brand accent through the same window, `.ghost` keeps `--ink-soft`.

`.outlined`'s **border takes the same colour**, which the finding did not ask
for: a boundary at 1.99:1 is the variant not being drawn at all (WCAG 1.4.11,
3:1). So does the loading spinner, via `--btn-ink`.

Measured after: every one of the 72 pairs is at **6.02:1 or better** on all
three variants, and the borders clear 3:1. The alternative — blending 55%
toward `--ink`, which is what `--tint-ink` does — was measured on the same grid
and does **not** hold: `sunset`/`warning` lands at 4.05:1. `contrast.spec.js`
pins all of it, 27 new assertions, including a hue no theme defines through
both the light and the inverted window.

The website's local `site.css` override is removed; it now reads the package.

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
:where(.chip, .btn, .pill, .badge, .pagination-link, .tooltip, .avatar, .step-marker) {
  text-decoration: none;
}
```

`.btn.link` (buttons.css) and `.link:hover` (typography.css) still turn the
underline back on — those are deliberate, this is a default. Affects `.pill` and
`.pagination-link` identically, which is why it belongs on the base rather than on `.btn`.
