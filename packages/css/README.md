# @frontierjs/css

A semantics-first design system for SaaS apps and internal tooling.
Plain CSS — no build step, no UnoCSS, no config file.

```bash
bun add @frontierjs/css
```

```js
import '@frontierjs/css'
```

```html
<body class="theme-default">
  <button class="btn danger outlined">Delete</button>
</body>
```

---

## The idea

The system is **two halves, equally weighted**.

**Structure** — what the HTML actually *is*: which element, what ARIA, how the
pieces nest. A vocabulary of 35 terms fixes one answer per concept, so "card"
means the same thing on Monday and Thursday.

**Style** — utility-first, but **one level above Tailwind**. Tailwind utilities
are one CSS property each; these are one *UI concept* each. Same composition
model — chain single-purpose classes, no cascade fights — at a higher altitude:

```html
<!-- Tailwind / Uno -->
<button class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded
               border border-red-600 text-red-600 bg-white">Delete</button>

<!-- FrontierJS -->
<button class="btn outlined danger">Delete</button>
```

This is **not** a component framework. In Bulma or Bootstrap, `is-primary`
belongs to `.button` and means nothing elsewhere. Here `.danger` is
free-standing — it works on a card, a `<tr>`, a field, a link, a feed dot — and
means the same thing on each.

---

## Three kinds of class

Only two of the three compose freely. Knowing which is which is most of
learning the system.

| Kind | Composes | What it names |
|---|---|---|
| **Element** | onto valid markup | *What a thing is* — `btn` `card` `field` `table` `tabs` |
| **Treatment** | onto anything | Orthogonal — the 7 tones, `raised` `outlined` `ghost`, `stack` `cluster` |
| **Anatomy** | no — nests | *A position inside* an Element — `alert-icon`, `feed-dot`, `surface-header` |

Chaining is for Treatments. Anatomy nests:

```html
<article class="card raised danger">      <!-- Element + two Treatments -->
  <div class="surface-header">Overdue</div>   <!-- Anatomy, nested -->
  <div class="surface-body">…</div>
</article>
```

There is a fourth group worth knowing about: **scoped modifiers** that read like
Treatments and aren't. `icon` only works on `btn`, `striped` only on `table`,
`divided` only on `rows`.

---

## Tones

A tone is **one variable**. Seven of them, and they work on everything that
takes a tone — no component maintains its own list.

```html
<button class="btn success">Approve</button>
<article class="card danger">Payment failed</article>
<tr class="warning"><td>Expiring soon</td></tr>
<span class="feed-dot info"></span>
```

`primary` · `secondary` · `muted` · `info` · `success` · `warning` · `danger`

**Contrast is derived, not declared.** Fill and text colour are both computed
from the fill's relative luminance: bright hues keep their colour and take dark
text, everything else keeps white text and is dimmed just enough to earn it.
Verified at **0 WCAG AA failures across all 42 tone × theme combinations** on
each of `btn`, `pill` and `badge` — and, because it is a derivation rather than
a table, it holds for hues no theme has defined yet. `bun run test` checks that
with eight invented ones.

Tones are **element-scoped** (`@property … inherits: false`), so an untoned
button inside a danger alert stays its own colour instead of turning red.

---

## Themes

One class on any ancestor. They nest, because it is all custom-property
inheritance.

```html
<body class="theme-default">
  <header class="theme-midnight">…</header>
</body>
```

`theme-default` · `theme-sunset` · `theme-forest` · `theme-midnight` ·
`theme-dark` · `theme-elite`

A theme overrides tokens, not just colours — Elite changes radii, weights,
tracking and the font family.

---

## Overriding it

Everything ships inside a cascade layer, and **unlayered CSS beats every
layer**. So your own stylesheet wins by default:

```css
/* your app.css — plain and unlayered, so it wins */
.btn { border-radius: 2px; }
td    { background: var(--zebra); }
```

No `!important`, no specificity ladder. Layer order:

```
tokens → themes → tones → base → layout → components → patterns → utilities → a11y
```

---

## Using it with UnoCSS

Uno is not required — the component shapes have been plain CSS since v0.6 —
but the package is built to sit under it, and this is the configuration that
works. Everything below was measured against UnoCSS 66.7.5 with
`presetWind3`, not inferred.

**The good part is free.** Uno's output is unlayered and everything here is
layered, so **every Uno utility beats every component**, with no ordering
discipline and no `!important`. `class="card p-4"` gets Uno's padding. That
is the escape hatch working as designed.

**The part that will bite you is the reset.** `@unocss/reset/tailwind.css` is
also unlayered, so it beats the package's components — and because layer
priority ignores source order, importing it *first* does not help:

| | package alone | + Tailwind reset, unlayered |
| --- | --- | --- |
| `h1` font-size | 36px | **16px** |
| `.btn` background | the tone | **transparent** |
| `.btn` padding | `6px 14px` | **0** |

Import the reset **into a layer** and it behaves:

```css
/* app.css */
@layer reset, tokens, themes, tones, base, layout,
       components, patterns, utilities, uno, a11y;

@import '@unocss/reset/tailwind.css'  layer(reset);  /* first: it is a reset */
@import '@frontierjs/css';
@import 'uno.css'                     layer(uno);    /* after components … */
                                                     /* … but before a11y   */
```

`uno` goes **between `utilities` and `a11y`**, not last: utilities should beat
components, but nothing should beat `.visually-hidden` — otherwise
`class="visually-hidden w-full"` makes a screen-reader label visible.

`@unocss/reset/tailwind-compat.css` is the lighter alternative — it exists
precisely because the button-background reset breaks UI frameworks.

**Three names collide.** Uno owns them as utilities, and a generated utility
outranks the component of the same name:

| Class | Uno makes it | Fix |
| --- | --- | --- |
| `container` | `width:100%` + breakpoint max-widths, so `.container.narrow` stops narrowing | blocklist `container`, or use Uno's |
| `text-xs…xl` | Uno's scale (14/18px) replaces this package's (13/16px) | pick one — blocklist, or drop this package's steps |
| `table`, `tab` | `display:table`, `tab-size:4` | harmless — that is what those elements already are |

```ts
// uno.config.ts
export default defineConfig({
  presets: [presetWind3()],
  blocklist: ['container', /^text-(xs|sm|md|lg|xl)$/],
})
```

> `.shell.fixed` was a fourth collision — Uno's `fixed` is `position: fixed`,
> so installing Uno turned the shell into a fixed-positioned element. It is
> **`.shell.viewport` as of v0.10.1**. See breaking changes below.

---

## What's in the box

**Frame** `app` `shell` `topbar` `sidebar` `screen` `pane` `view`
&nbsp;&nbsp;— the application grid, with `sidebar-first` and `viewport` variants

**Inline** `btn` (+ `square`, `outlined`, `ghost`, `raised`, `link`,
`loading`) · `pill` `badge` `link` `chip` `page` `tooltip` `avatar` `kbd` ·
`icon`
&nbsp;&nbsp;— one lineage, shared layout and auto-contrast

**Surfaces** `card` `tile` `alert` `toast` `dialog` `popover` `drawer`
&nbsp;&nbsp;— one lineage, shared background/border/radius and the tone recipe

**Forms** `field` `field-group` `field-hint` `field-check` `switch`
`field-row` `field-addon`
&nbsp;&nbsp;— native validation drives the tone via `:user-invalid`, no JS

**Data** `table` (+ `table-wrap`, `striped`, `hover`, `compact`) ·
`tiles` `tile-label` `tile-value` `tile-delta` ·
`facts` (a `<dl>` of label/value pairs, + `divided`)

**Navigation** `tabs` `tablist` `tab` (+ `pills`, `stretch`, `vertical`) ·
`breadcrumb` · `pagination` `page` · `navlist` `navlink` ·
`steps` `step` (+ `step-marker`, `step-label`, `step-hint`, `complete`,
`vertical`)
&nbsp;&nbsp;— current state comes from `[aria-current]` / `[aria-selected]`,
never a class

**Patterns** `bar` `section-header` `divider-label` · `items` `rows`
`list-row` · `feed` · `disclosure` · `avatars` · `<hr>` / `divider`
· `<pre class="code">` and inline `<code>`

**States** `spinner` `progress` `skeleton` `empty` · `btn.loading`

**Layout** `container` `stack` `cluster` `center` `split`

**Type** `h1`–`h6` · `text-xs` `text-sm` `text-md` `text-lg` `text-xl` ·
`text-body` `text-muted` `text-primary` … 
&nbsp;&nbsp;— size and colour are separate axes and chain: `class="text-sm text-muted"`

**Accessibility** `visually-hidden` (+ `focusable`) · `skip-link` · the focus
ring
&nbsp;&nbsp;— one recipe for every focusable surface, in the last layer

---

## Icons

The package ships **no icons** — it sizes what it finds. Bring Iconify, Uno's
`preset-icons`, inline `<svg>`, whatever you like.

An `<svg>` with no dimensions renders at 300×150, so an unsized icon does not
look slightly off — it destroys the layout it is in. Two ways to be sized:

```html
<!-- 1. sit inside a component the package owns — nothing to add -->
<a class="navlink" href="/inbox"><svg>…</svg> Inbox</a>

<!-- 2. carry .icon — works anywhere, including your own components -->
<p>Status: <svg class="icon">…</svg> ok</p>
```

`--icon-size` (default `1.15em`) is the knob, per component or per instance.
It is in `em`, so an icon tracks the text beside it.

> ### ⚠ Breaking change in v0.10
>
> `.btn.icon` — the icon-only button — is now **`.btn.square`**. `.icon` means
> "this element *is* an icon", and one class cannot also mean "a button shaped
> to hold one", or `<button class="btn icon">` would size the button itself to
> 1.15em.
>
> The old markup does not fail loudly: with `border-box`, a width under
> padding+border clamps, so the button floors at 30×30 and looks approximately
> right while losing its `aspect-ratio` and padding. Search for
> `class="btn ... icon"` and rename it.

## The focus ring

Every focusable thing in the package rings the same way, from one rule in
`focus.css`. Three tokens are the whole API:

```css
:root {
  --ring:        var(--color-primary);  /* whole-theme ring colour   */
  --ring-width:  2px;
  --ring-offset: 2px;                   /* negated for inset rings   */
}

.my-thing:focus-visible { --ring-color: rebeccapurple; }  /* one element */
```

It lives in the **last** cascade layer on purpose. A ring drawn in a component
file can be switched off by another rule in that same file without anyone
noticing — which is exactly what used to happen: `.btn.outlined` set
`box-shadow: none` for its flat look and silently erased its own focus
indicator. Layer order makes that unrepresentable, while your own unlayered CSS
can still change or remove a ring deliberately.

---

## State comes from the platform

Where a state is one the browser or a screen reader already knows about, the
CSS keys off *that*, not a class:

```css
.tab[aria-selected="true"] { … }
.navlink[aria-current="page"] { … }
.field:user-invalid { --bg-mix: var(--color-danger); }
```

A class lets the visual state and the announced state drift apart the moment
someone updates one and forgets the other. Keying off the attribute makes that
divergence unrepresentable — if it looks selected, it *is* selected as far as
assistive tech is concerned.

That last line is the entire form-validation implementation. Border, focus ring
and hint all derive from `--bg-mix` already.

**The one exception is a completed Step.** There is no ARIA token for "done",
so `.step.complete` is a styling hook with nothing behind it — a sighted user
sees three states and a screen reader user hears two. That is the single place
in the package where the markup has to say it twice:

```html
<li class="step complete">
  <span class="step-marker"></span>
  <span class="step-label">Cart<span class="visually-hidden"> — completed</span></span>
</li>
```

---

## Behaviour is not included

Visual treatment is a class; keyboard, focus and ARIA management are a
component. Tabs need roving tabindex and arrow keys. Dialogs need
`showModal()`. Tooltips need Escape-to-dismiss. The CSS draws them; your app
drives them. Each file's header documents the contract it expects.

Where the platform already has the behaviour, the system uses it —
`<dialog>` for modals and drawers, `<details>` for disclosure,
`<progress>` for progress bars, a real checkbox for switches.

---

## Browser support

Chrome 119+ · Safari 16.4+ · Firefox 128+

The system leans on `@property`, `color-mix()`, relative colour syntax and
cascade layers. Older browsers degrade to flat colours and white text rather
than breaking, but they are not a target.

---

## Status

Alpha, and honest about it: **zero production consumers so far.** All 29
vocabulary terms ship CSS and the invariants are covered by a checked-in test
suite — but nothing has been through the friction of a real build yet.

## Breaking changes

**v0.11**

- **Stylesheets moved to `src/`**, grouped into directories that mirror the
  cascade layers: `foundation/` `themes/` `components/` `patterns/` `a11y/`,
  with `index.css` and `utilities.css` at the top of `src/`.
- **Single-file imports carry the folder now.** `@frontierjs/css/buttons.css`
  → `@frontierjs/css/components/buttons.css`. `src/` does **not** appear in the
  public path — the exports map hides it. The one-line
  `import '@frontierjs/css'` is unchanged, and that is what most apps use.

```css
@import '@frontierjs/css/foundation/tokens.css';
@import '@frontierjs/css/themes/elite.css';
@import '@frontierjs/css/components/buttons.css';
```

### One file, if you want one

The package still needs no build step. But for a CDN drop-in, a CodePen, or a
bundler you do not control, `bun run build` emits a single file:

```css
@import '@frontierjs/css/bundle.css';       /* 72 kB */
@import '@frontierjs/css/bundle.min.css';   /* 57 kB */
```

> **If you roll your own bundle, prepend the layer statement.** `bun build`
> inlines each `@import` as an `@layer name { … }` block but drops the
> `@layer a, b, c;` line that declares the *order*, so the bundle falls back to
> first-appearance order. Move one import and `.btn.text-lg` silently goes 16px
> → 14px in the bundle while the source stays 16px. `build.js` re-reads that
> statement from `index.css`, prepends it, and refuses to write a bundle
> without it.

**v0.10.1**

- **`.shell.fixed` → `.shell.viewport`.** `fixed` is a core UnoCSS/Tailwind
  utility name (`position: fixed`), generated unlayered, so merely having Uno
  installed re-positioned the shell. See *Using it with UnoCSS*.
- **The `.text-*` utilities moved to a new `utilities` layer** (their own file,
  `utilities.css`). No markup change — but they now actually apply. Sharing the
  `components` layer with `.btn`, which sets its own `font-size`, made all five
  size steps inert on a button. If you compensated with an inline `font-size`,
  you can drop it.

**v0.10** — `.btn.icon` → `.btn.square`.

## Tests

```bash
bun run test              # everything
bun run test focus tone   # only matching spec files
bun run test --keep       # leave the generated page on disk to eyeball
```

202 assertions, run in real headless Chrome against real computed styles —
because every invariant here *is* a computed-style invariant. Cascade layers,
`color-mix()`, `@property … inherits: false`, `:focus-visible`,
`:user-invalid`, relative luminance: none of that exists in a DOM shim, so a
jsdom test would assert on the text of the CSS instead of its effect.

No dependencies. The page computes its own results and Chrome's `--dump-dom`
carries them back; there is no puppeteer and no lockfile entry.

`test/specs/meta.spec.js` tests the harness rather than the CSS. That is not
ceremony — roughly a third of the failures in the v0.6 cycle turned out to be
bugs in the assertions, so when a result contradicts the spec, suspect the
ruler first.

## Demo

```bash
bun run demo          # → http://localhost:5173
```

A five-route SaaS admin — dashboard, table, detail, list, settings — built
strictly to the vocabulary, with the behaviour contracts implemented in plain
JS. It is the reference for what real markup looks like, and its `demo.css` is
a deliberate measurement: every rule in that file is a gap in this package.
`demo/README.md` writes up what building it found.

## Docs

- **`demo/`** — a realistic app, and the findings from building it
- **`PROJECT_STATE.md`** — architecture, the two halves, the class taxonomy,
  design decisions, known constraints, and what's worth doing next
- **`guide/`** — the interactive reference: 49 pages, every component
  live, theme switching. Plain HTML + one plain `.js` file, no build step —
  open `guide/index.html`, or `bun run demo` and go to `/guide/`
