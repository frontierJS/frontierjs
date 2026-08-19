# Changes — @frontierjs/css

## 2026-08-18 — a button and a form control are one height, off one token

Same font-size, same line-height, same border — different vertical padding. A
`.btn` read `--space-xs` and a `.field` read `--space-sm`, so they came out
34px and 38px, and `.cluster`, `.bar` and `.toolbar` all centre: the pattern
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
(`FJS-341`).

## 2026-08-18 — `--topbar-height` is a floor, because a `.cluster` in a `.topbar` wrapped out of it

`.cluster` is `flex-wrap: wrap`. `.topbar` was a fixed `block-size` with
`align-items: center`. The two are paired in this package's own frame
documentation and in the guide's shell demo, and paired they were broken: a bar
holding more than fits did not shrink, scroll or clip — it laid a second row
inside a fixed box and centred both, drawing half its contents ABOVE the bar and
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

