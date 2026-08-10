# @frontierjs/css — for agents

Compressed reference for writing markup against this package. The README is
written for a person reading once; this file is written for a program that must
get one component right without reading the rest.

If you are adding CSS *to* this package rather than consuming it, read
`CLAUDE.md` instead — the rules are different and the test suite enforces them.

---

## The one rule

Describe **what a thing is**, then **what is true about it**. Never how it looks.

```html
<button class="btn outlined danger">Delete</button>
```

`btn` is what it is. `outlined` and `danger` are true about it. No colour, no
spacing, no size in the class list. If you are reaching for a class that names a
pixel value or a hex colour, you are in the wrong package — see *Escape hatch*.

---

## Four kinds of class

This is the whole learning curve. The kinds look identical in `class=""` and
compose by different rules.

| Kind | Composes | Scope | Example |
|---|---|---|---|
| **Element** | one per element | — | `btn` `card` `table` `field` |
| **Treatment** | chain freely | anything | `danger` `outlined` `raised` `dense` |
| **Anatomy** | does not chain — **nests inside** | its owner | `alert-icon` `tile-value` |
| **Modifier** | chains, but **only onto one Element** | see table below | `striped` (Table only) |

```html
<article class="card raised danger">     <!-- Element + 2 Treatments -->
  <div class="surface-header">Overdue</div>   <!-- Anatomy, nested, not chained -->
  <div class="surface-body">…</div>
</article>
```

**Modifiers are the trap.** They read like Treatments and are not. `striped` on
a Card does nothing — no error, no warning, the page just looks slightly wrong.
There is no build step here to catch it. The scoping table below is the only
place this is written down.

---

## Terms — 55, in 8 tiers

The class is the lowercased term unless stated. `(element)` means the term is
carried by an HTML element and has no class of its own.

**Base** — the two lineages everything else is built from
`chip` (inline: layout, no skin) · `surface` (block: background, border, radius, tone tint)

**Frame** — the shell, persistent across navigation
`app`<sup>body</sup> · `topbar`<sup>header</sup> · `sidebar`<sup>nav</sup> · `shell`<sup>div</sup>

**Page** — what changes when you navigate
`screen`<sup>main</sup> · `pane`<sup>section aria-labelledby</sup> · `view`<sup>article role=tabpanel</sup> · `tabs`

**Region** — grouping and wayfinding
Section (element) · Group (element) · `prose` · `bar` · `toolbar` · `divider`<sup>hr</sup> · `navlist`<sup>Nav</sup> · `breadcrumb` · `pagination`

**Block** — the main content citizens
`card` · `tile` · `item` · `list-row`<sup>Row</sup> · `feed` · `alert` · `steps` · `facts`<sup>dl</sup> · `code`<sup>pre</sup> · `table` · `disclosure`<sup>details</sup> · `empty`

**Inline** — chip lineage
`btn` · `link` · `pill` · `badge` · `field` · `switch` · Heading (`h1`–`h6`) · Text (`p`) · `icon` · `avatar` · `kbd` · `progress` · `spinner` · `skeleton`

**Overlay** — top layer, animated by `overlays.css`
`dialog` · `drawer` · `popover` · `tooltip`<sup>span</sup> · `toast`

**Layout** — the only classes that are purely spatial
`stack` (vertical) · `cluster` (horizontal, wraps) · `center` · `split` · `container`

Where the term name and class differ: **Button** → `btn`, **Nav** → `navlist`,
**Row** → `list-row`.

---

## Tones — 7, work everywhere

`primary` `secondary` `muted` `info` `success` `warning` `danger`

One variable. Works on any term that takes a tone — button, card, `<tr>`, field,
feed dot, tile delta. Contrast is **derived** from the fill's luminance, not
declared, so it is AA-safe on hues no theme has defined.

Tones are element-scoped (`inherits: false`) — an untoned button inside a
`danger` alert stays its own colour. You must tone each element you want toned.

---

## Treatments — chain onto anything

**Surface look** `raised` · `outlined` · `ghost` · `bordered`
**Density** `dense` · `roomy` — these **inherit**, unlike tones. `dense` on a
Pane reaches every Card, Row and Field inside it. That asymmetry is deliberate:
a tone is a fact about one element, density is a fact about a region.

---

## Modifiers — scoped, and silent when misapplied

The register in `vocabulary.js` lists these as modifiers but does **not** record
which term each belongs to. This table is that missing half — each row below was
read out of the selector that implements it. If a modifier does not behave,
grep the component's own CSS file; that selector is the authority, not this table.

| Modifier | Selector it is written against |
|---|---|
| `square` `loading` | `.btn` |
| `striped` `compact` `hover` | `.table` |
| `divided` `hover` | `.rows` — `divided` also on `.facts` |
| `pills` `stretch` | `.tablist` *(not `.tabs`)* |
| `vertical` | `.tabs` — and separately `.steps` |
| `complete` | `.step` *(the item, not `.steps`)* |
| `removable` | `.pill` — makes room for `.pill-close` |
| `circle` | `.skeleton` *(not `.avatar`)* |
| `narrow` `wide` | `.container` — and separately `.bar` |
| `viewport` `sidebar-first` | `.shell` |
| `menu` | `.items` *(not `.popover`)* |
| `start` `center` `end` | `.bar` / `.toolbar` — justification |
| `start` `end` `bottom` `wrap` | `.tooltip` — placement |
| `from-left` `from-right` `from-top` `from-bottom` | `.drawer` — placement |
| `bordered` | `.bar` / `.toolbar` |
| `focusable` | `.visually-hidden` |

Note `center` and `end` mean **alignment on a Bar** and **placement on a
Tooltip** — same word, two scopes, no overlap in practice because the Elements
differ. `wide` and `narrow` likewise split between Container and Bar.

For disabled state use the `disabled` attribute or `aria-disabled`, not a class —
the CSS keys off both.

---

## Anatomy — 26 terms have named parts

Anatomy **nests**, never chains. The critical rule: **a part is owned once and
borrowed after.** Card, Dialog, Drawer and Popover are all Surface lineage, so
they share `surface-header` / `surface-body` / `surface-footer`.

**There is no `card-header`.** This is the single most common wrong guess.

| Term | Parts |
|---|---|
| **Surface** *(borrowed by Card, Dialog, Drawer, Popover)* | `surface-header` `surface-body` `surface-footer` |
| Alert | `alert-icon` `alert-content` |
| Empty | `empty-icon` `empty-title` `empty-text` `empty-actions` |
| Tile | `tile-label` `tile-value` `tile-delta` |
| Feed | `feed-item` `feed-dot` `feed-content` |
| Steps | `step` `step-marker` `step-label` `step-hint` |
| Disclosure | `disclosure-summary` `disclosure-body` |
| Table | `table-wrap` `table-actions` |
| Field | `field-group` `field-hint` `field-row` `field-addon` `field-check` |
| Dialog | `dialog-close` *(plus Surface parts)* |
| Tabs | `tablist` `tab` |
| Nav | `navlink` `navlist-label` |
| Pagination | `pagination-link` `pagination-gap` |
| Pill | `pill-close` *(needs `removable` on the Pill)* |
| Divider | `divider-label` |
| Item | `item-lead` `item-text` `item-title` `item-sub` |
| Row | `row-actions` |
| Section | `section-header` |
| Toast | `toast-stack` *(one per app, not one per Toast)* |
| Tooltip | `tooltip-anchor` |
| Shell | `sidebar-toggle` |
| Facts | `dt` `dd` — real elements, no class, on purpose |
| Code | `code` inside `<pre class="code">` |

**Containers** — a plural class wrapping repeated children, not anatomy:
`items` (wraps Item) · `rows` (wraps `list-row`) · `tiles` (wraps Tile) ·
`avatars` (wraps Avatar).

---

## State comes from the platform, not from classes

Write correct ARIA and the styling is free. Do **not** invent `.active`,
`.selected`, `.current`, `.invalid` — none of them exist.

```html
<button class="tab" role="tab" aria-selected="true">…</button>
<a class="navlink" href="/inbox" aria-current="page">…</a>
<li class="step" aria-current="step">…</li>
<a class="pagination-link" aria-disabled="true">…</a>
<input class="field" required>            <!-- :user-invalid tones it red -->
<svg class="alert-icon" aria-hidden="true">…</svg>
```

Open/closed state is the browser's: `<dialog open>`, `<details open>`.

---

## Icons

The package ships none — it **sizes** what it finds. An `<svg>` with no
dimensions renders at 300×150 and destroys the layout. Two ways to be sized:
sit inside a component the package owns (`navlink`, `btn`, `alert-icon` — nothing
to add), or carry `class="icon"` anywhere else. Knob is `--icon-size`, default
`1.15em`, so it tracks adjacent text.

---

## Escape hatch

Everything ships inside a cascade layer and **unlayered CSS beats every layer**.
Your own stylesheet wins with no `!important` and no specificity ladder:

```css
/* app.css — plain and unlayered */
.btn { border-radius: 2px; }
```

Layer order: `tokens → themes → tones → base → layout → components → patterns → utilities → a11y`

For one-off spacing, either write the unlayered rule above or run UnoCSS
alongside (supported — see README §Using it with UnoCSS for the layer position,
the reset trap, and three colliding names).

Do **not** invent a class hoping it exists. There is no build step and no
validation in a consuming app: an unknown class is silently inert, and the page
will look almost right.

---

## Themes

One class on any ancestor; they nest, because it is all custom-property
inheritance. `theme-default` `theme-sunset` `theme-forest` `theme-midnight`
`theme-dark` `theme-elite` `theme-basecamp`

A theme overrides tokens, not just colours — Elite changes radii, weights,
tracking and font family.

---

## Checklist before emitting markup

1. Every element carries **at most one** Element class.
2. Every Anatomy class is **nested inside** its owner, never chained onto it.
3. Card/Dialog/Drawer/Popover use `surface-*` parts, not `card-*`.
4. No colour, pixel, or size word in any class name.
5. State is an ARIA attribute, not a class.
6. Every `<svg>` is inside an owned component or carries `icon`.
7. Every modifier used appears in the scoping table against that Element.

---

## Source of truth

`vocabulary.js` — `VOCAB` (55 terms, 8 tiers), `ANATOMY` (26 terms, named parts,
canonical markup), `NOT_ANATOMY` and `NOT_A_TERM` (every shipped class that is
deliberately not vocabulary, grouped by what it is instead).

Both directions are held by `test/specs/vocabulary.spec.js` and `anatomy.spec.js`
against the real CSSOM: a term with no CSS fails, and a class with no term fails.
So the vocabulary cannot drift from the stylesheet.

**To read it from code, import the JSON.** `vocabulary.js` is a classic script —
it declares `const VOCAB` at top level and exports nothing, because the guide
needs it to run before `guide.js` — so `vocabulary.json` is generated from it for
every other reader and ships alongside:

```js
import vocab from '@frontierjs/css/vocabulary.json' with { type: 'json' }

vocab.terms.find(t => t.term === 'Card')
// { term: 'Card', tier: 'Block', element: '<article>', class: 'card', meaning: … }

vocab.anatomy.Surface.parts    // [['.surface-header', 'A title strip…'], …]
vocab.anatomy.Surface.markup   // the canonical markup block
vocab.notATerm.tone            // ['primary', 'secondary', … ]
vocab.notATerm.modifier        // the 23 scoped modifiers
```

`class` is `null` where the term has no class of its own (Heading is `<h1>`–`<h6>`;
Section and Group are structural) — that is different from the class being the
lowercased term, and the JSON keeps the two apart.

The JSON is generated (`bun run build:vocabulary`) and the suite fails if it
drifts from the source, so the two cannot disagree.

The guide (`bun run demo`, :5173) is the human reference: 53 pages, ⌘K search,
and a *Pick a term* wizard that routes a description to one of the 55 terms.
