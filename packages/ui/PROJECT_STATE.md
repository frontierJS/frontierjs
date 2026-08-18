# @frontierjs/ui — project state

State as of **2026-08-06**.

## What this is

65 Mesa components over `@frontierjs/css`. Promoted out of
`packages/mesa/ui-v2/` on 2026-08-03 and restyled; the older 4-component
`packages/mesa/ui/` was deleted in the same move.

## What works

- **65/65 components compile and emit parseable JavaScript** —
  `node test/compile-all.mjs`.
- **27/27 render cases carry the css vocabulary** — `node test/render.mjs`,
  which renders through `renderComponent` and asserts both that the expected
  `@frontierjs/css` classes reach the DOM and that no utility class has
  returned.
- **17/17 form cases** — `node test/form.mjs`, added 2026-08-06 with `Form`.
- **Zero Tailwind/Uno utility classes remain** in any component.
- Mesa's own suite is green with every fix this package has driven:
  **975 passed**. Sierra, the other big Mesa consumer, is unaffected:
  **742 passed**.

## What is verified in a browser

**Two drives now, and they answer different questions.** `test/browser/` mounts
a component alone against the real stylesheet and drives Chrome over CDP — it
runs as part of `bun run test`, reports its own coverage, and reaches modes no
screen uses. `example`'s drives put the same components in an app with a real
service behind them.

**All 65 by the kit's own drive, as of 2026-08-16** — 24 specs, 617
assertions. `FJS-028` is closed: every component in the kit has been mounted in
a real browser and asked something only a browser can answer. **Twenty-two
defects came out of it, in four packages, and the rate did not fall as the
cheap components arrived** — `FJS-297`–`FJS-302` on the first run, `FJS-305`,
the eight that closed `FJS-077`, `FJS-311`/`FJS-312` from the Dropdown family
(of which `FJS-311` was a Mesa runtime defect that broke every compound
component behind a conditional), `FJS-313` from the Tabs family, and `FJS-315`
from the last batch, the one that was supposed to be static markup. It is also
what proved the toast handle (`FJS-119`), which needed a check on node identity
that no screenshot and no class assertion can make.

**Coverage here is breadth; depth is separate and is being closed one
component at a time.** A covered component is one a spec has opened, not one
whose every mode has been driven. **All four that were named for it are done,
and three of the four cost a defect.** `Form`: two fixtures, 61 assertions,
four defects (`FJS-316`), two of them in what a save actually SENDS. `Table`:
28 assertions and no defects at all — it had already been hardened by
`FJS-147` and the sort-button fix. `DatePicker`: 35 assertions over the modes
nothing had turned on, one defect in the component (`FJS-318`) and one in
Mesa's compiler found by writing the fixture (`FJS-319`). `CommandPalette`: 52
assertions, four defects in the component (`FJS-322`) and a Mesa runtime defect
under them (`FJS-321`) — **the third depth pass in four to find a framework
defect rather than a component one**, which is the argument for doing the rest
of the kit this way rather than declaring breadth enough.

**29 of the 64 by `example`, as of 2026-08-06.** `Form` joined them the same
day.

- *Carrying every route* — Alert, Badge, Button, Card, Checkbox, Field, Form,
  Input, Label, Pill, SectionHeader, Select, Table. `example/`'s `bun run verify`
  asserts 37 facts about the resulting DOM.
- *Driven by the four screens built for them* — Breadcrumbs, CommandPalette,
  Combobox, DropdownItem, DropdownMenu, EmptyState, Modal, MultiSelect,
  NumberInput, Pagination, Progress, RadioGroup, Skeleton, Slider, StatCard,
  Steps, Switch, Tab, TabList, TabPanel, Tabs, Textarea, Toast, Toaster,
  Tooltip. `bun run verify:ui` asserts 26 more — a roving tablist, focus inside
  a `<dialog>`, Escape closing a menu, a toast appearing, ⌘K filtering and
  running a command.

Both drives pass against the dev server and against the production build. The
defects this found are in `CHANGES.md`; the ones that were Mesa's are in that
package's.

The kit is loaded there from the workspace source through a Vite alias, not
from `node_modules` — `bun install` copies a workspace dependency, so a fix to
a component is otherwise invisible to the app testing it.

## What is NOT verified

- **Every component has a spec; what is unreached is now MODES, not
  components.** The grouped and typed modes of `MultiSelect`, `Combobox`
  standing alone, and `Field` outside a `<Form>`.
- **Interactions still unreached**: dragging a `Slider` handle (its value is set
  through the track click path only), `Popover` placement FLIPPING against a
  viewport edge — the placement itself is asserted — and `Combobox`'s type-ahead
  outside `example`'s screens.
- **`{...$attributes}` is applied to 8 components** — Button, Pill, Badge,
  Alert, Card, SectionHeader, Progress, Slider. The other 55 still cannot take
  an `id` or an `aria-label`. One line each, and worth doing in a sweep with a
  render assertion behind it.
- **No visual check against the real stylesheet.** The render tests assert
  that `class="btn danger"` is present, not that it looks right — and the
  browser work found the limit of that: `Field` set its error tone on the
  wrapper, which passed every assertion and coloured nothing, because
  `--bg-mix` is registered `inherits: false`.
- **Both token-divergent components are done.** `DatePicker` (`FJS-128`) is six
  declared properties in place of 107, `CommandPalette` (`FJS-129`) two in
  place of 21, and both are behind browser assertions that measure the thing
  rather than the class — a theme switch repaints, `.dense` moves the padding,
  a knob moves the geometry. The palette's restyle also found `FJS-305`: it had
  been handling every keypress **twice** since it was written.
- **The toast store now hands back a handle** (`FJS-119`): `toasts.loading(msg)`
  answers `{ id, update(type, message, duration?), dismiss() }` and settles the
  same toast in place. `example`'s order transitions and `basecamp`'s channel
  test both run through it; the kit drive asserts node identity, which is the
  only way to tell an update from a remove-and-add.
- **`Combobox` and `MultiSelect` name the row their keyboard cursor is on**
  (`FJS-323`) — `aria-controls` + `aria-activedescendant` over rows with ids,
  the shape `CommandPalette` took in `FJS-322`, and both took the pointer on
  `mouseenter` as it did. Writing those assertions found `FJS-324`:
  **`MultiSelect` had never rendered an option it was given.** Its option map
  was built only by a `$:` watch, which fires on CHANGE, so a static `options`
  array left it empty for the life of the component. `example`'s products
  filter is a live caller and its drive was green throughout — the screen
  renders, the control opens, and the list is empty.
- **`Btn` is gone** (`FJS-056`). A browser measured it against `Button` and
  found the same `.btn`, the same tones, the same treatments and the same
  `type` — the two differed only in defaults, `primary` at body size against
  `ghost` one step down. A defaults-only alias is not a second component:
  `<Btn>x</Btn>` is `<Button variant="ghost" size="sm">x</Button>`.

## Bugs found and fixed in Mesa during this work

All three were invisible to `analysis.errors` — the compiler reported success.

1. **`const fn = () => { reactiveLet = x }` emitted `$runtime.get(sig) = …`** —
   invalid JS, module threw on load. The derived-const emitter called
   `rewriteExpr` without `rewriteAssignments` first. Killed `Accordion` and
   `Tabs` outright. Fixed in `compiler.js`; pinned in `emission.test.js`.
   `function fn() {}` was always fine, which is why nobody hit it.
2. **The same, for a mutator provided through `$context`** — the normal way a
   compound component shares state. Same fix, same test.
3. **`{class}` REPLACED the element's own classes instead of merging.**
   `<button class="btn primary" {class}>` rendered with *no* classes when no
   class prop was passed, and with only the consumer's when one was. New
   `bindClassPassthrough` in `runtime.js`; the compiler routes the `$classAuto`
   attribute to it rather than through the replacing `bindAttribute` path.

   This is the one that mattered most: **it silently unstyled the entire kit,
   before and after the restyle**, and it is invisible without looking at the
   DOM — the component still renders, it just has no classes.

## Known Mesa gaps (not fixed — worked around here)

None outstanding.

Four are gone (2026-08-10). **`<mesa:element this={…}>` exists**, so
`SectionHeader` no longer carries an `h1`–`h6` `{#if}` ladder. **`export
function` reaches the compiled output** and `bind:this` on a component hands
over the exported interface, so `Input`/`Select`/`Textarea`/`NumberInput`
actually have the `focus()` the docs claimed and `Form` exposes `submit()`,
`reset()` and `clearErrors()` (its `onready` prop stays for callers already
using it). A **destructuring assignment to reactive lets** is
rewritten through the setters, so `DatePicker` writes its range swap as
`[_startDate, _endDate] = [_endDate, _startDate]` again. A **`{@const}` reading
the loop index** works — the index is a signal, so calling it is correct — and
`Breadcrumbs` keeps its precomputed flag only because truncation is what
decides which item is last.

## Landmines

- **`bun install` resolves the workspace Mesa to a COPY under
  `node_modules/.bun/`, not a symlink.** An edit to `packages/mesa/compiler.js`
  is invisible to anything importing `@frontierjs/mesa` until you reinstall —
  a test suite will report green against a stale snapshot. `test/compile-all.mjs`
  imports `../../mesa/compiler.js` by relative path for exactly this reason,
  and `node_modules/@frontierjs/mesa` here has been replaced with a symlink to
  the workspace so the bare specifier resolves live too. **If you re-run
  `bun install`, check that symlink survived.**
- **`test/render.mjs` sets `tmpDir` two levels under the package root.** A
  bare relative import in a component (`../../utils.js`) resolves from the
  *temp* module's directory, not the source's, so the temp file has to sit at
  the same depth every component does. Move the components and that breaks.
- **Every `<style>` block in a component uses an `fjs-` prefix.** These are
  local shapes the css package has no term for (a slider track, a dropzone, a
  status dot's ping). Anything that maps onto an existing vocabulary term
  should use the term instead — the whole point of the restyle was to stop
  the package carrying a second design system.

## Open — see `ISSUES.md`

**`FJS-055`** a kit control's real `required` needs `novalidate` ·
**`FJS-056`** `CommandPalette` draws its own panel and input rather than
composing `.dialog` + `.field` + `.items`. Its `Btn`/`Button` clause is closed —
`Btn` was deleted — and its `themeStore` clause with `FJS-308`.

Three Mesa defects were found by rendering all 64
components for the first time and are **fixed the same day** — `FJS-146` an
`{@attach}` ran under SSR where `el.animate` does not exist, `FJS-147`
`{#each { length: n }}` was not iterable so **`DatePicker` had never rendered
at all**, `FJS-148` a null `style:` directive emitted the string `null`.

Six more came out of the first run of the kit's own browser drive and are
**fixed the same day** — `FJS-297` mesa delegated five events that do not
bubble, so **no Modal or Drawer could be reopened after Escape**; `FJS-298` a
`children` snippet crashed the render of any component using `<slot />`;
`FJS-299` `Tooltip` documented a handoff that is not Mesa syntax; `FJS-300`
`DatePicker` threw on a month change into a shorter month; `FJS-301` its
`disabledDates` disabled the wrong day west of Greenwich; `FJS-302` `.avatars`
overlapped and ringed nothing, because this kit wraps its avatars. Two mesa
questions the drive raised are open — `FJS-303`, `FJS-304`.
`Toast` and `DatePicker` are in the attribute sweep as a result, and `Toast` is
a render case.

Add a new item to `../../ISSUES.md`, not here.
