# ui — package map

**`@frontierjs/ui`** — a Mesa component kit over `@frontierjs/css`. 66
components, no build step, no utility classes (Invariant 13: style with a tone
and a treatment, never a color).

`bun run test` runs four node harnesses in order — compile-all → render →
attributes → form — and then the **browser drive**, which needs Chrome on PATH
or `$FJS_CHROME`. `bun run test:browser` is the drive alone; `bun run serve`
starts its server and stays up, for looking at a component in a real browser.

---

## Layout

```
components/
  forms/      Form · Field · Fieldset · Label · Input · Textarea · Select ·
              Checkbox · RadioGroup · Switch · Slider · NumberInput · Combobox ·
              MultiSelect · DatePicker · DateTimeInput · FileUpload · Button · Btn
  display/    Table · Badge · Pill · Tag · Stat · StatCard · Steps · Pagination ·
              Breadcrumbs · Callout · EmptyState · Avatar(+Group) · Sparkline · …
  layout/     Card · Tabs (Tabs/TabList/Tab/TabPanel) · Accordion(+Item)
  overlay/    Modal · Drawer · Popover · Tooltip · DropdownMenu(+Item/Label/
              Separator) · ConfirmationPopover · CommandPalette
  feedback/   Alert(+Provider) · Toast(+er) · Progress · Spinner · Skeleton
stores/       alertStore · toastStore · commandPaletteStore
controls.js   control name → component; where an app contributes one
utils.js      shared helpers
tokens.css    the kit's own tokens, on top of @frontierjs/css
test/         compile-all.mjs · render.mjs · attributes.mjs · form.mjs
test/browser/ the kit drive — run.mjs (Chrome over CDP) · server.mjs (compiles
              .mesa on demand) · page.js (mounts a fixture, in-page probes) ·
              fixtures/*.mesa · specs/*.spec.mjs
```

---

## What bites here

- **`$context.form` is the seam.** `forms/Form.mesa` provides
  `{ errors, submitting, disabled, fields, submitted }`; **every control reads it**
  to resolve its own label, constraints, `aria-invalid` and message. An absent form
  reads `undefined` and every fallback is what the control did standing alone.
  **A stated prop always wins**, including `required={false}`.
  Two shapes are worth knowing because both were live defects (`FJS-077`):
  - **`label={label || name}` passed to `<Field>` shadows the schema.** It is
    always truthy when a name is given, so the raw column arrives as an
    EXPLICIT label and `@label("Customer")` becomes unreachable. It is
    `label={label || undefined}` — `''` is a real answer that suppresses the
    label, and only `undefined` means *not stated*.
  - **A control wraps itself in a `<Field>` on `label || name`, not on `label`.**
    Inside a `<Form>` nobody passes a label, because the label is a schema
    fact — so gating on it renders the control bare, with structurally nowhere
    to put a server error.
  Where the element is not the value — a `[role=radiogroup]`, a MultiSelect's
  search box — it is `aria-required`, never a native one: a group is not
  labelable, and a search box whose resting state is empty would refuse every
  submit.
- **A `DateTime` column is `DateTimeInput`, and the conversion is the point.**
  Litestone stores an instant; `datetime-local` reads and writes a wall clock
  with no zone, so the naive wiring truncates the offset going in and hands
  back a zoneless string that is parsed as UTC — two shifts, opposite
  directions, different sizes, on a control that looks correct. The component
  converts at both edges and NAMES the zone it is showing in a `.field-addon`.
  It has no `oninput` on purpose: a handler reading `e.target.value` would get
  the wall clock, so `onvalue(iso)` is the callback that carries a value. A
  `Date` column is still a plain `input type="date"` — no zone, nothing to
  lose.
- **`<Form>` with no children generates its field list, and the control table is
  not in this package.** It asks the resource — `resource.formFields({only,
  except})` and `resource.options(fk)` — because this kit peers only on mesa and
  css, so importing Sierra to learn what a `Float` is would invert the
  dependency, and because a hand-written form and a generated one have to agree.
  The table is `sierra/src/junction/field-rules.js`. Children win; `auto` forces
  either way and renders the generated fields first. **A column the table has no
  control for is warned about by name** — a field missing from a form in silence
  is the failure generating it is meant to end.
- **A contributed control is `controls.js` plus Sierra's `registerControl`, and
  the kit's own five take the same path** (`FJS-D17`). `FormField.mesa` is the
  dispatcher: a table of the kit's controls in the registry's own shape, with
  `formControl(name)` consulted first — so a registered name REPLACES a built-in
  of that name, and swapping `select` for a combobox everywhere is one line
  rather than a fork. `<Form>` was an `{#if}` ladder over five names before, and
  that ladder was the reason a plugin could name a control and have nothing
  render it. With no `props` builder a control is handed
  `{ name, field, value, onvalue, options }`; **put `name` on the element that
  emits input** or the form's dirty tracking and blur-reveal cannot see the
  field. A name nobody bound renders nothing and says which half is missing.
- **The live-validation rule lives in `Form.mesa`, once**: on input an error may
  only be *removed*, never added. Do not re-implement it per control.
- **`{...$attributes}` goes on the element the caller means, and that is not
  always the root.** Display, layout, feedback and overlay put it where
  `{class}` already goes; a form control puts it on the CONTROL, because a
  `<label for>` and an `aria-describedby` have to reach that element and not
  the `.field-group` around it. `test/attributes.mjs` holds it for all 64 and
  names the six it cannot render. Where `id` is a declared prop it means
  something else (a toast identity, a tab pairing, the id of the control a
  `Label` points at) and never reaches the DOM as an id — those are in the
  suite's own exception list, with the reason.
- **A component exposes a method with `export function`, reached by `bind:this`**
  — `Input`/`Select`/`Textarea`/`NumberInput` (`focus()`, `select()`) and `Form`
  (`submit()`, `reset()`, `clearErrors()`). It was dropped from the compiled
  output until mesa closed `FJS-087`, so those four had documented a method they
  did not have. `Form` also still hands the same three out through `onready`.
- **A local `<style>` may not name a class `@frontierjs/css` owns.** That is the
  only way a kit component silently changes the package for an app that never
  imports the kit. Two did and both are gone: `DropdownItem` styled `.item`
  (`FJS-126`) and `Drawer` styled `.drawer[open]` (`FJS-127`). The first had
  already drifted — `gap: 0.625rem` against `.item`'s own `var(--space-sm)`, so
  a menu row's icon sat a rung wide **and could not move inside a `.dense`
  region**, which a literal makes impossible rather than merely wrong. If the
  package should own a rule, put it there; the drawer's flex column now lives
  in `drawers.css` with a css test on it.
- **Fifteen components carry a `<style>`, and all fifteen now read tokens.**
  They are `.fjs-*` prefixed, small, and mostly geometry the design system does
  not and should not ship — a slider handle's inset math, a dot's ping
  keyframe, an avatar status dot's corner offset. The two that were a second
  design system are done: `DatePicker` (`FJS-128`, 107 declared properties → 6)
  and `CommandPalette` (`FJS-129`, 21 → 2). **Four rules came out of doing
  them**, and they are what to follow in the next one:
  - **A component's own focus ring is drawn from `--ring-*`, here.**
    `focus.css` opts elements in BY CLASS and cannot name a class this kit
    invented, so the rule lives in the component — but it varies the ring
    through the tokens rather than writing a second recipe.
  - **A filled state puts `.chip` on the element** and reads
    `--fill`/`--on-fill`, so its text colour is derived against whatever tone a
    theme defines instead of assumed white.
  - **A tinted state sets `--bg-mix` and reads `--tint-surface` /
    `--tint-rule` / `--tint-ink`.** Those are measured for contrast across
    every shipped theme; a hand-mixed `color-mix()` is not, and nobody
    re-measures one.
  - **Check whether the package already ships it.** The palette's keycaps were
    a local class while `code.css` styles `<kbd>` on the element; its badge was
    a local class while `.badge` takes a tone. Both fixes were deletions.
- **A compile test and a render test cannot reach what this kit adds**, and the
  drive that can now lives HERE. `test/browser/` serves the kit over HTTP with
  an import map, compiling each `.mesa` on request, and drives Chrome over CDP —
  so a component is covered by writing a fixture and a spec, rather than by
  first putting it on a screen in `example/`. That friction is why the long tail
  stayed dark for so long; the first day it existed it found six defects in four
  packages (`FJS-297`–`FJS-302`).
  - **A fixture is a component**, because a slot cannot be expressed as a props
    object. Props reach it as JSON, so a `Date` travels as a string.
  - **Input goes through the pipeline** (`t.press`, `t.type`, `t.clickAt`). A
    dispatched `KeyboardEvent` is not trusted: it moves no focus, types no
    character and dismisses no `[popover]`.
  - **`t.eventually(expr, expected, label)` for anything a state change
    produces.** Mesa flushes on a microtask, so a plain read straight after a
    click sees the previous value.
  - **`t.press('Enter')` activates a focused control, and only because Enter
    carries `text: '\r'`.** Chrome synthesises a button's click from the
    character, so an Enter sent without one travels through every listener and
    activates nothing — indistinguishable from a component that ignores Enter.
  - **`--verbose` prints the passing assertions.** A spec that THROWS half way
    reports one failure and no clue how far it got; the rows are the only
    record.
  - **`waitSettled(sel)` before a coordinate click near anything animating.**
    `waitVisible` answers *can this be seen*, which is not *has it stopped
    moving*: `t.clickAt` reads a rect and then presses that point, so a
    neighbour still growing into place puts the target somewhere else by the
    time the press lands. Green alone, red under load.
  - **A fixture may import the REAL control table**, through
    `@frontierjs/sierra/field-rules` (the server mounts `/@sierra/` and
    `/@toolbelt/` for it). A fixture deciding for itself what a `Float` gets
    would pass while the two disagreed, which is the failure the shared table
    exists to prevent. It is a leaf, so nothing comes in behind it — this is a
    harness reading a file, not the kit importing Sierra.
  - **`waitVisible(sel)` for an overlay**, never `querySelector`. Kit overlays
    animate in, so the instant after `open` they are at keyframe zero — opacity
    0, translated off their own edge — and a disclosure body is opened by a
    transition on its ANCESTOR, so it is fully opaque inside a zero-height box.
  - Coverage is reported every run and derived from the tree, so a new component
    is uncovered the moment it is added. `--coverage` names the gap.
- **A component's class names are published surface the moment a drive selects
  them.** Renaming `CommandPalette`'s `.cp-*` to `.fjs-cp-*` broke `example`'s
  `verify:ui` and `basecamp`'s `verify`, and the second went unnoticed for a
  while because grepping an app's `src/` finds nothing — the selectors are in
  its `web/test/`. Before renaming, grep the whole repo for the class, test
  files included.
- **A compound component's parts read `$context`, and that only works because
  Mesa reinstates the context stack for content a block builds later**
  (`FJS-311`). `DropdownMenu` provides `close()` and renders its items inside
  `{#if open}`; the read used to answer `undefined`, so choosing an item never
  closed the menu. If a part of a compound component silently does nothing,
  check whether it is behind a conditional before blaming the part.
- **A long action holds a toast HANDLE, it does not fire two of them.**
  `toasts.loading(msg)` answers `{ id, update(type, message, duration?),
  dismiss() }` and settles the same toast in place — `toasts.update(id, patch)`
  is underneath it. A loading toast has `duration: 0` and a spinner rather than
  a verdict icon, so it does not dismiss itself and does not draw a drain bar
  it cannot honour. Settling one the reader already dismissed answers `false`
  and does not put it back; `update()` reschedules the timer only when a
  duration is stated. **The test that matters is node identity** — a
  remove-and-add looks identical on screen and loses the reader's place in the
  stack.
- Errors arrive through `toFieldErrors()` (sierra's `field-rules.js`), which is
  the one owner of "a thrown value → per-field messages". `<Form>` calls it and
  knows nothing else about error shapes.

## Proving a change

`bun run test` — which now includes the browser drive — then `example`:
`bun run verify:ui`, the behavioural components on real screens. `verify` covers
the 13 that carry every route. The two drives answer different questions and
both are worth running: this one mounts a component alone and can reach modes no
screen uses, `example`'s puts it in an app with a real service behind it.
