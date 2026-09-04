# Guide chrome audit — what the guide hand-rolls, and what ships

**Status: AUDIT. Dated 2026-08-09.** Every count and every verdict below was read
off `guide/guide.css`, `guide/guide.js` and `src/` on that date. Re-derive it
rather than trusting it — `guide.spec.js` is the part that cannot go stale.

The question this answers: **the guide teaches a design system; how much of the
guide is built with it?**

Measured: `guide.css` is 2,501 lines and declares **286 `.sg-*` classes** against
a 54-term vocabulary. So the guide's own UI is roughly five times the system it
documents. Some of that is legitimate and some is debt, and the two were
indistinguishable because they lived in one file.

---

## The test that separates them

> **Does this class render the design system, or is it a UI the design system
> should be able to build?**

The first is an *instrument* — a tonal ramp, a wireframe, a type scale. It draws
the system, so it cannot be built out of the system without the measurement
depending on the thing it measures. It belongs in `instruments.css` and is not
debt.

The second is *chrome* — a shell, a nav, a card grid. If `@frontierjs/css` ships
a term for it, hand-rolling it here means the guide does not use its own system,
and the gap is invisible to every existing spec. It belongs in `guide.css` and
each one is a line item to close.

---

## Summary

| Category | Classes | Where it goes | Debt? |
| --- | --- | --- | --- |
| **A** Replaceable — a shipped term does this | ~95 | delete | **yes** |
| **B** Instrument — draws the system | ~120 | `instruments.css` | no |
| **C** Guide-app chrome — search, wizard, modal | ~55 | `guide.css` | no |
| **D** Token re-declaration | 40 | delete 28, fix 2, keep 10 | **partly** |

---

## Finding 1 — the guide hand-rolls a shell the package ships

The largest single item, and the most visible.

```css
/* guide.css */
.sg-shell   { display: grid; grid-template-columns: 240px 1fr; }
.sg-sidebar { border-right: 1px solid var(--rule); position: sticky; top: 53px; }
.sg-topbar  { border-bottom: 1px solid var(--rule); position: sticky; top: 0; }
.sg-main    { padding: 48px 56px 96px; }
```

`src/components/frame.css` ships all four — `.shell` (grid + named areas),
`.topbar` (sticky, `--topbar-height`), `.sidebar` (`--sidebar-width`), `.screen`
(`--screen-pad`, plus the `min-inline-size: 0` that stops a wide table blowing
the layout out sideways). It also ships `.shell.viewport` and
`.shell.sidebar-first`, which the guide does not have at all.

The literals are the tell: `240px`, `53px`, `48px 56px` are hard copies of values
the shipped versions read from tokens. `top: 53px` on the sidebar is a
hand-measured topbar height — it does not follow `--topbar-height`, so the two
can drift apart and nothing says so.

**One real structural difference, and it is why this is not a pure find-and-replace.**
The shipped `.shell` places the Topbar *inside* the grid via
`grid-template-areas`. The guide renders it *outside*, as a sibling above
`.sg-shell`, because `setTheme()` re-renders the topbar by id
(`$("#sg-topbar").innerHTML = topbar()`). Adopting `.shell` means the topbar
moves inside it and that re-render target moves with it. Small, but it is a JS
change, not only a CSS one.

## Finding 2 — the nav re-implements `.navlist` / `.navlink`, and ignores an ARIA convention

```css
.sg-nav-item        { display: block; padding: 6px 8px; … }
.sg-nav-item.active { color: var(--accent); background: rgba(13,131,221,0.09); }
.sg-nav-group-title { font-size: 11px; text-transform: uppercase; … }
```

`src/patterns/nav.css` ships `.navlist`, `.navlink`, `.navlist-label` — same
three jobs. The difference that matters is the active state: the shipped one is
`.navlink[aria-current="page"]`, and `PROJECT_STATE.md` § *Style interactive
state from ARIA, not a class* is the convention. The guide styles `.active`, so
it is both duplicating the CSS and demonstrating the opposite of the documented
practice on the most-looked-at nav in the repo.

`rgba(13, 131, 221, 0.09)` is also `--color-primary` hard-coded at 9%, so the
active item does not follow a theme switch. The shipped rule is
`color-mix(in srgb, var(--bg-mix, var(--color-primary)) 12%, var(--surface))`,
which does.

## Finding 3 — the `:root` block, and one instance of a trap the package documents by name

`guide.css` opens with ~40 custom properties at `:root`. Diffed against
`tokens.css`:

**28 are byte-identical restatements.** `--color-primary`, all three radii, the
nine button/pill/badge typography tokens, all three shadows, `--surface`,
`--surface-raised`, `--ink`, `--ink-soft`, `--ink-mute`, `--rule`,
`--rule-strong`, `--ring-width`, `--ring-offset`. Dead weight: delete them and
the guide inherits the same values from the package it links.

**Three diverge from the package — and none of them reached the page.** Measured
rather than assumed, which corrected an earlier draft of this file that called
two of them live defects:

| Token | `tokens.css` | `guide.css` | |
| --- | --- | --- | --- |
| `--color-secondary` | `#1f2937` (near-black) | `#E5E7EB` (near-white) | inverted |
| `--surface-sunken` | `#f5f5f5` (neutral) | `#f3f1e9` (warm) | brand drift |
| `--ring` | *deliberately absent* | `var(--color-primary)` | the alias trap |

`--ring` is the one the package documents by name. `tokens.css`:

> `--ring` is deliberately NOT declared here … `--ring: var(--color-primary)` at
> `:root` looks equivalent and silently isn't: the var() resolves once, against
> `:root`'s own `--color-primary`, and the computed value then inherits past any
> `.theme-*` override.

**Why none of the three rendered.** `applyTheme()` writes the live theme's
tokens as an inline style on `.sg-app` at boot, and an inline style beats a
`:root` declaration — so the guide painted the package's values whatever this
block said. Verified: 8 themes × 6 elements of computed style, identical before
and after removal, `--surface-sunken` resolving to `#f5f5f5` in both.

That makes them dead code rather than defects, and still worth deleting: this is
the reference implementation, so a wrong value here is the value the next reader
copies. It is also a caution about this kind of audit — the file said one thing,
the browser said another, and only one of them is evidence.

**Ten are legitimately the guide's own brand** and should stay, declared as
brand rather than as a copy: `--paper`, `--accent`, `--code-bg`, `--code-text`,
`--font-primary` (Geist), `--font-mono` (Geist Mono), and the `--font-display`
heading face. None of these exist in `tokens.css`; a guide is allowed to look like
itself.

---

## Category A — replaceable (~95)

Each of these has a shipped term that does the same job. Verified present in
`src/` at the path given.

| `.sg-*` | Replacement | Ships in |
| --- | --- | --- |
| `sg-shell` | `.shell` | `components/frame.css` |
| `sg-topbar`, `sg-topbar-inner` | `.topbar` | `components/frame.css` |
| `sg-sidebar` | `.sidebar` | `components/frame.css` |
| `sg-main`, `sg-main-inner` | `.screen` + `.container.narrow` | `frame.css`, `layout.css` |
| `sg-app` | `.app` | `components/frame.css` |
| `sg-nav-list` | `.navlist` | `patterns/nav.css` |
| `sg-nav-item`, `.active` | `.navlink[aria-current="page"]` | `patterns/nav.css` |
| `sg-nav-group-title` | `.navlist-label` | `patterns/nav.css` |
| `sg-nav-group` | `.stack` on the `<nav>` | `foundation/layout.css` |
| `sg-nav-sub`, `sg-nav-subitem` | `.navlist` nested + `.navlink` | `patterns/nav.css` |
| `sg-section` | `.pane` | `components/frame.css` |
| `sg-card-grid` | `.cluster` or a grid utility | `foundation/layout.css` |
| `sg-row-flex` (11 uses) | `.cluster` | `foundation/layout.css` |
| `sg-stack`, `sg-stack-divider` | `.stack`, `<hr>` | `foundation/layout.css` |
| `sg-preview-box` | `.card` or `.surface` | `foundation/surface.css` |
| `sg-token-table` + cells | `.table` (+ `.striped`, `.compact`) | `components/tables.css` |
| `sg-swatch` | `.badge` / `.pill` | `chip.css` |
| `sg-coming` | `.empty` | `components/feedback.css` |
| `sg-modal-*` (9) | `.dialog` + `.surface-*` | `dialogs.css`, `surface.css` |
| `sg-theme-dropdown`, `-option`, `-backdrop` | `.popover` + `.items.menu` | `popovers.css`, `lists.css` |
| `sg-theme-trigger`, `sg-config-trigger`, `sg-search-trigger` | `.btn.ghost` | `components/buttons.css` |
| `sg-search-kbd` | `.kbd` | `components/code.css` |
| `sg-next-link` | `.card` + `.split` | `surface.css`, `layout.css` |
| `sg-cheat-theme`, `sg-cheat-base` | `.item` / `.list-row` | `patterns/lists.css` |
| `sg-code-inline` | `.code-inline` | `components/code.css` |
| `sg-editor` | `.field` | `components/form-core.css` |
| `sg-principle-num` | `.step-marker` or `.avatar.circle` | `steps.css`, `avatar.css` |

**Judgement calls inside category A.** `sg-modal-*` and the theme dropdown are
listed as replaceable, but each needs a look before it moves: the theme menu is a
`<button>`-driven popover with a backdrop, and the shipped `.popover` has the
top-layer positioning caveat CLAUDE.md documents (`[popover]` is in the top layer,
so a `position: relative` parent does nothing). If the shipped term needs more
JS than the hand-rolled one, that is a finding about the package, not a reason to
keep the copy quietly — record it either way.

## Category B — instruments (~120), keep

These draw the system. Building them from the system would make the instrument
depend on what it measures, and a broken component would then render a broken
diagram of itself rather than showing the fault.

| Family | Count | What it draws |
| --- | --- | --- |
| `sg-sk-*` | 19 | wizard wireframes. Deliberately not real components — CLAUDE.md: drawing a Button and a Link the same way would say the choice is visual |
| `sg-ax-*` | 16 | SVG text in the two-axes diagram. No CSS class applies to SVG text |
| `sg-tonal-*` | 9 | the tone ramp, per step |
| `sg-color-*` | 11 | colour ramps and swatch rows |
| `sg-scale-*` | 7 | the space ladder, drawn as bars |
| `sg-typescale-*`, `sg-weight-*` | 8 | the type ladder and weight samples |
| `sg-lineage-*` | 12 | the chip/surface lineage diagram |
| `sg-basis-*` | 8 | the cheat sheet's lineage view (`.sg-lineage` was already taken — see CLAUDE.md) |
| `sg-palette-*`, `sg-theme-ramp` | 6 | theme previews |
| `sg-resolve-*` | 4 | the cascade-resolution diagram |
| `sg-matrix-*` | 4 | the tone × treatment matrix |
| `sg-pad-demo`, `sg-gap-demo` | 2 | padding and gap, drawn |
| `sg-cheat-mini-*` | 4 | miniature component silhouettes |

## Category C — guide-app chrome (~55), keep in `guide.css`

Real UI, but for a *documentation app*, not for the design system. The package
has no term for a ⌘K palette or a decision wizard — and in the palette's case
that is close to a ruling: there is no Menu term because arrow-key behavior is
not CSS, and the same reasoning applies here.

- `sg-search-*` (19) — the ⌘K palette
- `sg-wiz-*` (16) — the Learn wizard
- `sg-brand-*` (4) — the guide's wordmark
- `sg-copy` (1) — copy-to-clipboard on code blocks. Its wrapper is `.relative`, the shipped utility
- `sg-class-box`, `sg-kind`, `sg-class-swatch` (4) — the class index
- `sg-next-*` (6) — pager footer, partly replaceable (see A)
- `sg-lead`, `sg-td-prose` — the two that are still the guide's own

**`sg-prose` was the interesting one, and it is now the closed one.** This file
recorded it at **287 uses** and ruled it *not* debt: the package styles no `<p>`
by design, so a documentation site full of prose had to bring its own, and that
made the guide the evidence for the content-layer gap in
`IDEAS/page-composition.md`.

The gap was closed — `src/patterns/prose.css` ships `.prose`, and the guide
writes it. `sg-prose` and `sg-list` are gone; `guide.css` keeps a comment where
each one was, because the reason a class went is worth more than the class. What
survives is `sg-prose-preview`, which is not the same thing: it flattens `<p>`
margins *inside a preview box*, where the page-level rhythm would be wrong.

**The 287 was also the last live number in this file, and it had rotted.**
Re-derive rather than cite — and strip comments first, or the count reads the
prose recording a deletion as the class still being there. At the time of
writing, 214 declared `.sg-*`, and it moves with every batch. A number in
a document is a claim nothing re-checks — which is the whole argument for
`guide.spec.js` holding the shape instead.

---

## Proposed split

```
guide/guide.css          chrome + remaining debt   → shrinks as A is closed
guide/instruments.css    category B                → stable, ~1500 lines
```

Each file opens with the test above, so the next person can place a new class
without re-deriving the reasoning. A class that fails the test in `instruments.css`
is a bug in the file, not a judgement call.

**Why not one file.** The whole point of the exercise is to be able to look at
the guide's CSS and answer *is this debt?* — which a single file cannot answer at
a glance. Two files make the debt a number that goes down.

## `guide.spec.js` — what makes it hold

**Shipped 2026-08-09, 7 checks, all seven verified by mutation** — each was made
to fail on purpose before being trusted, because a green test that cannot go red
is worse than no test.

Modeled on `demo.spec.js`, which exists because of exactly this failure mode:
the demo wrote `class="page"` on every pagination control, a class the package
does not ship, and it rendered as raw UA links for as long as it existed because
nothing looked.

| Check | Holds |
| --- | --- |
| every class the guide's markup writes is shipped, `sg-`-prefixed, or in `NOT_SHIPPED_OK` | a typo'd vocabulary class — the `demo.spec.js` bug |
| every entry in `NOT_SHIPPED_OK` is still written | an exception outliving its reason |
| every replacement named in this file is really shipped | **this document rotting** |
| `guide.css` restates no token `tokens.css` declares | the 28 copies, and any new one |
| `--ring` is not declared at `:root` | the alias trap, specifically |
| no class is declared in both guide files | the split silently re-merging |
| the replaceable-class debt does not grow | a new hand-rolled shell |
| **no `.sg-*` renders identically to a shipped term** | **a copy under a name that shares no letters with it** |

The third is the one that matters most for this file: `REPLACEABLE` in the spec
is category A as data, and every right-hand side is asserted against the live
CSSOM. So the audit cannot claim a replacement the package does not ship — which
is the way a document like this normally goes wrong.

The ratchet is in the spirit of the repo's typecheck baselines: **0 today**, and
it may never go up.

**The last check is the only one that is not a name search**, and it is the one
that found the final five. Everything above compares strings, so it can see
`.sg-copy` next to `.btn` and be satisfied — and it is structurally unable to
see `.sg-stack-divider`, a `<div>` hand-drawing the 1px rule `<hr>` has shipped
all along, because the two names have no letters in common. Instead it renders
every `.sg-*` class and every candidate term into the live document and compares
**42 computed properties**. A class is redundant only when the shipped term
produces the same numbers.

Two ways it goes wrong, both measured on the way to writing it:

- **Comparing property NAMES rather than values** reports 220 matches and means
  nothing — every class sets `color` and `font-size`, so `.btn` "matches" the
  whole file.
- **Too short a property list.** At 21 properties it reported eight false
  positives, all list terms: `.items` and `.navlist` carry
  `list-style`/`margin`/`padding` resets that a `<div>` probe cannot show and
  that the short list did not read. At 38 they vanished — and a later mutation
  test proved 38 was still too few, since a byte-identical copy of `.empty`
  passed until `justify-items`, `align-content` and `text-align` were added.
  **A property left out is a difference this cannot see.** Err long.

### What writing it turned up

Three false positives, each worth knowing because each is a way this kind of
scan lies:

- **The guide quotes other frameworks on purpose.** The compare page shows the
  same button in Tailwind, Bootstrap and Bulma, so `class="btn btn-outline-danger"`
  is in `guide.js` as a *quotation*. A naive scan reported 30 of those as
  unshipped classes — true, and beside the point. Code samples are stripped
  first.
- **A guide about class names quotes them in prose.** Five more survived the
  sample strip inside `<code>` tags, including `class="card-small-blue-bordered"`,
  which the taxonomy page cites as an example of a name *nobody* should write.
- **A file may reach into another's component.** `instruments.css` styles
  `.sg-wiz-opt .sg-sk` — the sketch inside a wizard option, which is the
  sketch's business. Reading every class in a selector as a declaration
  reported a conflict that was not one; the test reads the selector's SUBJECT.

And one real one: `--font-primary` / `--font-mono` are declared by `tokens.css`
*as defaults meant to be replaced* (`system-ui, sans-serif`). Setting them is the
token doing its job, not a copy. `THEMEABLE` in the spec is that distinction, and
it is deliberately a two-entry list — anything else is a copy until someone
argues otherwise there.

## What the swap itself broke, and what caught it

Three defects, none of which the suite could see — every one came out of
clicking through a real browser. That is the standing note in the package's
`CLAUDE.md`: no spec covers the page builders.

**The sidebar stopped following navigation.** `renderPage()` toggled `.active`,
which the ARIA swap had removed from the markup — so the page rendered correctly
while the sidebar kept highlighting the page you came from. `route()` had the
identical bug for sub-sections. Both now set `aria-current`.

**Section anchoring died on every page but one.** Scoping `tagSections()` to
`:scope > .pane` looked right and was wrong: most pages wrap their body in an
`<article>`, so a page's sections are *grandchildren* of the host. It found
sections on App frame — which has no wrapper — and silently emptied the outline
and the search index everywhere else. The fix is a descendant selector with
`> .sg-h2` as the discriminator, which also keeps a *demonstrated* `.pane` out of
the outline: App frame renders 7 panes and gets 6 sections, which is correct.

**The config modal would not close.** Converting it to a real `<dialog>` is
right — the div version had no Esc, no focus trap and a hand-built backdrop —
but removal hung off the `close` event, and **headless Chrome never fires it**.
Measured: `close()` flips the open attribute and no listener runs, not even a
capture listener on `document`. Same class of gap `CLAUDE.md` records for
top-layer transitions. `dispose()` in `openConfig` is the direct removal each
exit calls, with the `close` listener kept so Esc still works in a real browser.

The dialog conversion is the one change here that improves behavior rather than
just provenance: Esc, focus trapping, `::backdrop` and the entry/exit motion in
`overlays.css` all arrive with the element.

**And one the split itself introduced.** `instruments.css` ended mid-comment —
an unclosed `/*` left behind when the section it headed stayed in `guide.css` —
so the file's last rule was swallowed and anything appended to it silently did
nothing. It surfaced only because a mutation test appended a rule that should
have failed the sweep and did not: the check was right, the file was eating the
mutation. Nothing rendered wrong, because the swallowed rule was a comment and
a class already declared elsewhere. **A mutation that fails to fail is evidence
about the file, not only about the test.**

---

## Ranked

| | Item | Status | Why |
| --- | --- | --- | --- |
| 1 | The `:root` token block | **done** | 28 restatements deleted, 3 divergences gone. 0 computed-style diffs across 8 themes |
| 2 | The file split | **done** | `instruments.css` extracted, 287 selectors in and 287 out |
| 3 | `guide.spec.js` | **done** | 7 checks, each verified by mutation. The suite now loads the guide's source — it never had |
| 4 | Shell + nav → shipped terms | **done** | `.shell` / `.topbar` / `.sidebar` / `.screen`, `.navlist` / `.navlink[aria-current]` |
| 5 | The rest of category A | **done** | Card, Table, Cluster, Pane, Dialog, Empty, Field, Code, Kbd |

**Debt: 0.** The ratchet in `guide.spec.js` is at `CEILING = 0` and a
reintroduced hand-rolled shell fails it — verified by mutation.

That is 0 *of the register*, not 0 hand-written classes: 286 `.sg-*` remain and
most of them should. What the number means is that every class with a shipped
equivalent now appears **beside** that equivalent — `class="btn outlined sg-copy"`,
`class="dialog sg-modal"` — so the package does the work and the guide adds only
its own skin on top. That is what a themed consumer is supposed to look like,
and it is the shape the ratchet measures.

### The category the first audit missed: buttons

Asked after the sweep looked finished — *should copy buttons be included?* — and
the answer was yes, along with three more. Four `<button>` elements were
hand-rolling the Button term:

| | |
| --- | --- |
| `.sg-copy` | on every code block — 13 declarations |
| `.sg-search-trigger` | the ⌘K trigger |
| `.sg-theme-trigger` | the theme menu |
| `.sg-config-trigger` | the `{ }` index.css viewer |

The last three were the *same thirteen declarations* three times over —
inline-flex, the font, a 1px border, a 6px radius, cursor, a hover — each free
to drift from the other two. All four are now `.btn.outlined` plus what Button
does not decide: where the copy button sits, that the config trigger is
monospace, and the size.

**They set `--bg-mix`, not `color`.** `.btn.outlined` reads that one variable
for both its text and its border, so a hover that names `color` alone leaves the
border behind — which is what the old rules did, each pinning
`border-color: var(--accent)` regardless of theme. One variable moves the pair.

The lesson for the rest of the register: the first pass looked for *layout*
duplicates (a shell, a nav, a card) and did not look for a hand-styled
`<button>`, which is the single most re-implementable thing in any stylesheet.
`REPLACEABLE` now carries all four, so the ratchet holds them.

### The next-page footer, and the one thing the package genuinely lacks

Asked by reading the rendered markup rather than the stylesheet — *can't this be
done with our CSS at all?* Mostly yes. `.sg-next-link` was a hand-built
`display: grid` with its own surface, border, radius and padding; it is a
**`.card.split`** that happens to be an `<a>`. The rule above it was a
hand-drawn `border-top`; it is an `<hr>`. The label column was a hand-built
flex column; it is a `.stack`.

The grid version needed `grid-row: 1 / -1` on the arrow so it would center
against the whole card rather than against the label — because on pages that
cross a nav group the card grows a third line. **Split centers it for free**,
and the browser confirms it in both variants. That is the shape of most of these
finds: the hand-rolled version is not only longer, it carries a fix for a
problem the term does not have.

**What could not be replaced is the interesting part.** `.hover` is a shipped
modifier, but only for Table and Rows — `.table.hover tbody tr` and
`.rows.hover .list-row`. There is **no interactive-Card state in the package**,
so the lift-and-tint on hover stays hand-written, with a comment saying so and
what would replace it. A Card that is a link is not an exotic thing to want; if
Card ever grows a `.hover`, that block deletes.

### Three the audit was wrong about

Each came out of `REPLACEABLE` with the reason recorded there, because a
register whose rows might not be debt is not a register:

- **`sg-swatch` is not a Badge.** A Badge carries text, pads around it and
  derives its ink from its fill. This is an empty 18px square whose whole
  content is a colour. The package has no term for *a colour, shown* — that is
  what a guide does, not what an app does.
- **`sg-search-kbd` was never missing the Kbd term.** The element is already a
  `<kbd>` and `code.css` styles the ELEMENT, so the package was underneath it
  the whole time; eight declarations were restating it. The class survives as
  the hook the narrow-viewport rule hides it by.
- **`sg-stack` is not Stack.** Stack is `--space-2xl` between block sections;
  this is a 12px column of preview rows that also stretches its children. Same
  shape, different job — adopting the term and then overriding both of its
  declarations would say it fits when it does not.

Nothing here changes what a consumer of `@frontierjs/css` receives — `guide/` is
tooling, outside `package.json`'s `files`. The risk is entirely to the guide's
own appearance, and the only thing that proves it is a browser walk: no spec
covers the page builders.
