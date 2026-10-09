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
## Reference (moved to `docs/`)

- Two halves, four kinds of class, layer architecture, leverage axes, Half 1 principles and vocabulary → `docs/architecture.md`
- File map and deliverables → `docs/file-map.md`
- Conventions (tones, composition, type scale, breakpoints, a11y, ARIA state, theming) → `docs/conventions.md`
- Known constraints and quirks → `docs/quirks.md`
- Picking this up cold (read order, bundler layer gotcha, test harness limits) → `docs/picking-up-cold.md`

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

   It is a real fix — probably a `--on-surface-accent` derived the way `--_fill`
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

