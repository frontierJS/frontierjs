# FrontierJS CSS — Project State (v0.5)

> A minimal, composable, semantics-first CSS framework for Svelte/Vite/UnoCSS
> apps. Drop this whole doc + the source files into a fresh chat to continue.

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

The goal is **maximum leverage from minimum CSS** by compounding basics on
basics — each layer is the contract the next layer reads from — now with an
explicit **semantic contract layer** (vocabulary + principles) on top.

---

## Architecture — four layers

```
1. Primitives          CSS vars in tokens.css
   ↓ overridable by
2. Themes              token overrides in themes/*.css
   ↓ consumed by
3. Tones + Utilities   the actual rendered surfaces (classes)
   ↓ governed by
4. Patterns            canonical HTML anatomy — doc-only contracts
                       (Vocabulary + Principles)
```

Layer 4 is new in v0.5. It doesn't ship CSS of its own — it's the **semantic
contract**: which HTML element each concept uses, what ARIA it carries, and how
pieces nest. FrontierJS apps follow these contracts strictly; outside projects
are "recommended to."

### Leverage axes (layer 3)

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
  └── sets --bg-mix and --on-bg-mix on any element
       └── every component reads those two vars
```

**Standalone (don't fit the surface mold):**
```
field (form input) — own var contract, reads tones for state borders
table (tabular)    — own structure, tones on <tr> for row tinting
```

### Composition tricks (unchanged from v0.4)

1. **Uno shortcuts compose** — `['pill', 'chip rounded-full ...']` expands chip
   into pill at the utility layer.
2. **`:where()` selector groups** — surface.css writes ONE rule body targeting
   every surface composite. Add a composite = add its name to the `:where()` list.
3. **Tones as single source** — tones.css is the only place mapping tone names to
   colors. Every component consumes `--bg-mix` / `--on-bg-mix`.
4. **`color-mix()` for derivation** — surface tints, lighten/darken, row tinting
   all derive from `--bg-mix`. No manual color math.

---

## The contract layer (v0.5)

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

```
@frontierjs/css/
├── README.md
├── uno.config.ts                  ← shortcuts + 4 tonal rules
└── styles/
    ├── index.css                  ← single entry point (one import covers all)
    ├── tokens.css                 ← :root defaults + reduced-motion guard
    ├── themes/
    │   ├── default.css            ← blue brand + neutral surfaces
    │   ├── sunset.css             ← warm orange
    │   ├── forest.css             ← deep green
    │   ├── midnight.css           ← purple accent
    │   ├── dark.css               ← neutral dark
    │   └── elite.css              ← navy + lime + Montserrat (real client theme)
    └── utilities/
        ├── tones.css              ← tone vocabulary (.primary, .danger, …)
        ├── surface.css            ← block visual base (:where group)
        ├── typography.css         ← h1-h6, .text-* utilities
        ├── buttons.css            ← .btn (+ .icon added v0.4.x)
        ├── pills.css              ← .pill (+ .removable / .pill-close added v0.4.x)
        ├── badges.css             ← .badge
        ├── cards.css              ← .card
        ├── alerts.css             ← .alert
        ├── toasts.css             ← .toast
        ├── popovers.css           ← .popover
        ├── drawers.css            ← .drawer
        ├── form-core.css          ← .field, .field-group, .field-hint, .field-check
        ├── tables.css             ← .table + variants + row tones
        ├── dialogs.css            ← .dialog
        ├── bars.css               ← .bar, .section-header, .divider-label   (NEW v0.5)
        ├── lists.css              ← .items/.item, .rows/.list-row/.row-actions (NEW v0.5)
        ├── feed.css               ← .feed/.feed-item/.feed-dot/.feed-content (NEW v0.5)
        └── disclosure.css         ← .disclosure + summary/body              (NEW v0.5)
```

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
Each sets `--bg-mix` (hue) + `--on-bg-mix` (contrast). All use `white` except
`warning` (`#1f2937`, since yellow needs dark text).

### Class composition (Bulma-style chain)
`class="btn outlined danger text-lg"` — base first, variants/tones any order,
sizes via Uno utilities.

### Element choice (the v0.5 contract)
- A discrete self-contained unit inside a Section → `<article>` (Principle 2)
- A labeled major subdivision of a Screen → `<section aria-labelledby>` (Pane)
- A visual cluster with no identity → `<div>` (Group)
- A list member → `<li>` (Item/Row)
- See the Vocabulary page / table above for every term's element + ARIA.

### Icons
heroicons via UnoCSS preset: `<span class="i-heroicons:NAME" aria-hidden="true">`.
Icon-only buttons: `.btn.icon` + `aria-label` on the button. (Note: Panel.svelte
still uses `<i>`; docs prefer `<span>`. Unresolved, accepted either way.)

### Theming (one class on body)
`class="theme-default"` (or sunset/forest/midnight/dark/elite). Themes nest.

### Sub-regions
`surface-header` / `surface-body` / `surface-footer` (shared across surface
composites; NOT `card-header`).

---

## What's been done (chronological)

### Foundation (v0.1–v0.2)
- ✅ Three-tier architecture; chip→pill/badge/btn lineage; `--bg-mix`/`--on-bg-mix`
- ✅ tones.css single source; lighten/darken rules; six themes; reduced-motion guard
- ✅ Layout shortcuts (stack/cluster/center/split)

### Surface lineage (v0.3–v0.4)
- ✅ surface.css `:where()` base; tonal recipe (10/30/45); cards 80→14 lines
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
The 10/30/45 tinting recipe muddies very pale hues — why `secondary` is
dark/saturated across all themes.

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
2. **The full CSS source** — `frontierjs-css-src.zip` (all of `styles/` + uno.config.ts)
3. **`frontier-demo.html`** — single-file test/preview build
4. **`TicketDetail.svelte`** — dogfooded reference screen
5. **This doc** — `PROJECT_STATE.md`

Reasonable opening prompt:

> I'm continuing work on FrontierJS CSS (was "ksite-styles"). Architecture,
> contract layer, and file layout are in PROJECT_STATE.md. Current version is
> v0.5. Full CSS source is in the zip; interactive docs are style-guide.jsx;
> single-file test build is frontier-demo.html. I want to [...goal...].

The new Claude should read PROJECT_STATE.md first to absorb context (especially
the four-layer model and the six principles) without re-deriving it.

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
