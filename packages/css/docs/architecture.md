# CSS — Design: the two halves and architecture

> Moved from `PROJECT_STATE.md` (2026-10-09). Version tags (vX.Y) refer to the package version when written.

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
> `.end`, `.item`, `.icon` and the seven tone names are all global. See the
> naming constraint below — this taxonomy is the principle to resolve it against.

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

