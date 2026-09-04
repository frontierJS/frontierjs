# Changes — @frontierjs/css

## Breaking changes, by version

Moved out of `README.md`, which is a map: a version history is a register's
job (`FJS-D187`).

### v0.11

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

### v0.10.1

- **`.shell.fixed` → `.shell.viewport`.** `fixed` is a core UnoCSS/Tailwind
  utility name (`position: fixed`), generated unlayered, so merely having Uno
  installed re-positioned the shell. See *Using it with UnoCSS*.
- **The `.text-*` utilities moved to a new `utilities` layer** (their own file,
  `utilities.css`). No markup change — but they now actually apply. Sharing the
  `components` layer with `.btn`, which sets its own `font-size`, made all five
  size steps inert on a button. If you compensated with an inline `font-size`,
  you can drop it.

## 2026-08-27 — the default theme carries a ramp, a ground and an elevation

`theme-default` was seven colors, every one of them the value `tokens.css`
already declares at `:root`. So the theme that every app boots into was a no-op,
and what an unstyled FrontierJS app looked like was decided entirely by the
package defaults — which are tuned to be neutral, not to be a design.

Measured on `example/`: white cards on a `#f5f5f5` page separated by a `#e7e3d8`
hairline. The rules are WARM and the surfaces are NEUTRAL GRAY, which is the
mismatch that reads as unfinished; `--app-bg` fell back to `--surface-sunken`,
so the page, the table head and every inset well were one color and a Card had
nothing but that hairline holding it off the page; and `--surface-shadow: none`
meant the Block tier was flat against it.

The theme carries the whole neutral ramp now, three grounds rather than two, the
elevation, the radii and the heading weight — **and it is still tokens and no
selector**, which is the contract. `--ink-mute` is the one value fitted by hand:
it is the lightest rung of the ramp and still body text at 11–13px, so it is
`--color-muted` scaled uniformly in linear RGB — chromaticity exact — to 5.19:1
on `--surface` and 4.61:1 on `--app-bg`, the deepest of the three grounds.

`--text-4xl` comes down one rung, to 2rem. It is h1 and nothing else in the
package reads it; at 36px in near-black it was the heaviest thing on a screen
whose job is to show data. The reading rungs below it are untouched — moving
those is a house voice, which is what `press.css` is for.

**The suite found the thing this change was always going to find.** Six specs
asserted a package default — a flat resting Card, an unset
`--heading-font-weight`, `--app-bg` falling back — while rendering inside
`<body class="theme-default">`, and two more read a token off
`document.documentElement` and compared it to an element that inherits the
theme from `<body>`. Every one of them was true only because the theme set
nothing `:root` did not. The suite's page carries no theme class now, so a
claim about the defaults is a claim about the defaults; the themes are still
graded explicitly, and `contrast.spec.js` sweeps all ten. The same read in
`@frontierjs/ui`'s palette and datepicker drives is fixed the other way — those
fixtures are an app and keep their theme, so the token is read off `body`.

All 470 assertions pass, contrast included: 96 across ten themes × seven tones ×
three jobs.

## 2026-08-18 — a button and a form control are one height, off one token

Same font-size, same line-height, same border — different vertical padding. A
`.btn` read `--space-xs` and a `.field` read `--space-sm`, so they came out
34px and 38px, and `.cluster`, `.bar` and `.toolbar` all center: the pattern
built for a strip of controls put the button 2px below the row it belongs to.
Measured in basecamp's filter bar, three controls at 38px and the submit at 34.

**An app had no way out.** A button's size is expressed as a FONT SIZE
(`Button.mesa`'s `sizeMap`), so the only control that makes a button taller
makes its text bigger too; the package shipped no shared control-height token
and no end-aligned row modifier.

`--control-padding-block` is the token both read. It resolves to the taller of
the two — 38px is no prize against the 44px touch-target guidance, but it is the
better of the pair, and the element people tap and type into should not be the
one that shrinks. Horizontal padding stays per-component: a button is wider than
its text on purpose and an input is not.

The cost is real and worth naming: **every button in this repo is 4px taller**.
The kit's 65 components, both apps and the guide were re-run after it.

Three more cases in `test/specs/frame.spec.js`, and they measure heights and
edges rather than declarations — neither rule was wrong on its own, which is why
nothing caught this. Reverted, the spec reports `tops disagree by 2.0px`
(`FJS-347`).

## 2026-08-18 — `--topbar-height` is a floor, because a `.cluster` in a `.topbar` wrapped out of it

`.cluster` is `flex-wrap: wrap`. `.topbar` was a fixed `block-size` with
`align-items: center`. The two are paired in this package's own frame
documentation and in the guide's shell demo, and paired they were broken: a bar
holding more than fits did not shrink, scroll or clip — it laid a second row
inside a fixed box and centered both, drawing half its contents ABOVE the bar and
half BELOW, over the page.

Measured in basecamp at 767px, in a 56px bar: `☰` at y=-4, the workspace
`<select>` at y=-12, `Sign out` at y=34. **There is no horizontal overflow at
any width**, so the usual smell test — does the page scroll sideways — missed it
entirely.

`min-block-size` is the whole fix. The shell's grid row is already `auto`, so
the bar grows to fit; nothing else in the package reads `--topbar-height`, so no
offset math moves. `padding-block: var(--space-xs)` gives a wrapped row
breathing room and costs an ordinary bar nothing, because `box-sizing` is
`border-box` package-wide and the padding sits inside the floor.

`.topbar > .cluster { flex-wrap: nowrap }` was the other candidate and is worse:
it trades an overlap for a horizontal overflow, and this package explicitly
refused the general responsive-visibility set that would let an app say *drop
this below md* instead.

**`test/specs/frame.spec.js` is new and it measures coordinates**, because a
rule check passes against the broken version — every property in it was doing
exactly what it said. Reverted against the old rule it reports
`item 0 (Menu) is outside the bar — bar 0–56, item -11–23` (`FJS-338`).

