# CSS — Conventions

> Moved from `PROJECT_STATE.md` (2026-10-09). Version tags (vX.Y) refer to the package version when written.

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

