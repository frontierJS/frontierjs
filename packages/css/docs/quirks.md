# CSS — Known constraints and quirks

> Moved from `PROJECT_STATE.md` (2026-10-09). Version tags (vX.Y) refer to the package version when written.

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

To pin an exact fill, set `--tone-fill` — the knob the cap reads — and the text
follows. `--on-bg-mix` pins the text alone. Not `--_fill`: that is the capped
OUTPUT, and setting it leaves `--_on-fill` deriving from a color that is no
longer painted (`FJS-1192`, README § Which variables are yours).

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

### Class names are global
The system has no namespace: `.center`, `.hover`, `.start`, `.end`,
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
- **Scoped modifiers** — the actual problem. `.table.hover`,
  `.rows.divided`, `.items.menu` read as Treatments and aren't.

There are currently zero consumers, so renaming is free right now and won't be
later.

---

