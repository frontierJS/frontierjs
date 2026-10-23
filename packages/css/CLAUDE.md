# css — package map

**`@frontierjs/css`** — the styling language of the framework (Invariant 13).
Semantics first: a **tone** (`danger`) and a **treatment** (`outlined`), never a
color and never a utility class. Plain CSS, no build step required.

`bun run test` drives **headless Chrome** — needs Chrome on PATH or `$FJS_CHROME`.
`bun run demo` serves the guide on :8040 (`$PORT` overrides).

---

## Where things are

`docs/file-map.md` is the file-by-file map, with the annotated tree at its
foot; read it when a change touches a file this list does not name. The owners
that matter on most turns:

- `src/index.css` is the entry — the `@layer` order is declared HERE; `src/foundation/` (`reset.css`, `tokens.css`, `tones.css`, `surface.css`, `layout.css`, `chip.css`) is the first layer, `src/components/`, `src/patterns/`, `src/a11y/`, `src/themes/` follow, `src/utilities.css` and `src/print.css` last.
- `vocabulary.js` is THE OTHER HALF — `VOCAB` (terms in 8 tiers), `ANATOMY` / `NOT_ANATOMY` (parts and their canonical markup), `NOT_A_TERM` (every shipped class that is deliberately not vocabulary) and `vocabClass(row)`. Four readers: the guide, `guide/search.js`, and two specs. `vocabulary.json` is GENERATED from it (`bun run build:vocabulary`), committed and shipped; the suite fails if it drifts.
- `guide/` is the reference — 50 pages, the thing to read before adding CSS. `guide/guide.js` is an ES module; `guide/decisions.js` (the Learn wizard's routing tree) and `guide/search.js` (the ⌘K search, owner of `slugify`) stay classic scripts because `test/run.js` inlines them.
- `src/components/overlays.css` owns how the whole Overlay tier enters and leaves; `src/foundation/tokens.css` owns the stacking ladder, the two ladders `--text-*` / `--space-*`, `--density`, `--align` and the shadow-tree resets.
- `test/run.js` is the harness, `test/specs/*.spec.js` the suite; `build.js` is the optional `dist/` bundle; `demo/` is skipped for CSS and checked for MARKUP.

## What bites here

The dozen that bite most; the full catalog is `docs/quirks.md`, read it before
touching a token, a theme, the vocabulary, the guide or a spec.

- **Three variable tiers and the name is the only thing carrying which** — a knob a caller sets, a published one `README.md` names, a private `--_` derivation. Before renaming one, ask whether `README.md` tells an app to touch it (`FJS-1192`).
- **New vocabulary is a design decision, not a class.** `vocabulary.spec.js` checks BOTH directions against the real CSSOM; shipping a class the vocabulary does not name fails the suite — name it, or classify it in `NOT_A_TERM` with a reason.
- **`NOT_A_TERM` is in `vocabulary.js`, not in the spec.** Both are inlined into one page as classic scripts, so a second declaration is a SyntaxError that takes the whole suite with it; **spec helpers share that one global scope** too — prefix a helper with its spec's subject.
- **`bun build` drops the `@layer` order declaration**, so `build.js` re-prepends it; check the first lines of `dist/` after any build change.
- **`getComputedStyle` goes stale after a class change** in headless Chrome, **answers a USED pixel for `top: auto`**, and **an unregistered custom property computes to its TOKEN STREAM** — read the rules that match the element, or measure through a use site.
- **A tone used as TEXT goes through a window, never painted raw** — `--tone-ink` / `--tint-ink` clamp the lightness; **a dark theme must invert the window**, and `contrast.spec.js` is what catches one that forgets.
- **A default that is another token is a use-site fallback, never a `:root` declaration** — `--topbar-bg: var(--surface)` or `--overlay-time` at `:root` resolves once and inherits past every `.theme-*`. The space ladder is declared on `*` for the same reason.
- **A token a THEME must reach cannot be declared on the component**; read it as `var(--table-border-width, var(--border-width))` at the use site instead.
- **A sibling combinator behind an `:is()` ancestor is paid for page-wide** — 300 ms a keystroke (`FJS-1621`). Write the child as `:where(:not(:first-child))`.
- **A registration does not reach a widget's shadow root** — every `@property` token needs its line in `tokens.css` § *Inside a shadow tree*, and `shadow.spec.js` catches a missing one (`FJS-1989`, `FJS-2080`).
- **A tone does not inherit; density does** (`@property` `inherits:`), and **the package ships no `container-type`** — derived density is opt-in via `container: fjs / inline-size`.
- **A box with one overflow axis set is not a box with one axis scrolling**; state both axes in both directions, or a horizontal strip grows a vertical scrollbar.
- **`[popover]` is in the top layer, so a `position: relative` parent does nothing**; `.popover-anchor` is the plain-element half, and **a top-layer transition cannot be measured in this harness** — `overlays.spec.js` asserts the mechanism is DECLARED.
- **The CSSOM walk must descend through `@import` AND nested rules** — `index.css` is 44 imports and `surface.css` nests `&.raised`; a walk that forgets either reports classes the package does not ship. Read `rule.cssText`, not `rule.style`, because a shorthand expands to longhands that answer `""`.
- **A guide page that documents source must READ the source** (`ruleText()` in `guide.js`), and **the search corpus is HARVESTED** through the same `tagSections()` the live render calls.

## Proving a change

`bun run test`, then `example`: `bun run verify:ui` — the kit and the app render
on top of this.

The guide's data files ARE tested — `VOCAB` and `ANATOMY` against the CSSOM,
`decisions.js` against the vocabulary, `search.js` against both. The page
builders are not. What proves a change to those is a browser walk
— render every page, click every wizard path — driven by hand against
`bun run demo`. Two failures it has caught that nothing else could: three
sections silently dropped from `guide.js`, and a wizard path that led nowhere.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/file-map.md.
a11y.css basecamp.css build-vocabulary.js build.js code.css dark.css decisions.js demo.css 
demo.js field.css focus.css guide.css guide.js index.css layout.css lists.css nav.css 
overlays.css press.css print.css reset.css search.js surface.css tokens.css tones.css 
typography.css utilities.css vocabulary.js vocabulary.json 
-->
