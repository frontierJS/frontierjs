# ui — package map

**`@frontierjs/ui`** — a Mesa component kit over `@frontierjs/css`. 64
components, no build step, no utility classes (Invariant 13: style with a tone
and a treatment, never a color).

`bun run test` runs four node harnesses in order: compile-all → render →
attributes → form.

---

## Layout

```
components/
  forms/      Form · Field · Fieldset · Label · Input · Textarea · Select ·
              Checkbox · RadioGroup · Switch · Slider · NumberInput · Combobox ·
              MultiSelect · DatePicker · FileUpload · Button · Btn
  display/    Table · Badge · Pill · Tag · Stat · StatCard · Steps · Pagination ·
              Breadcrumbs · Callout · EmptyState · Avatar(+Group) · Sparkline · …
  layout/     Card · Tabs (Tabs/TabList/Tab/TabPanel) · Accordion(+Item)
  overlay/    Modal · Drawer · Popover · Tooltip · DropdownMenu(+Item/Label/
              Separator) · ConfirmationPopover · CommandPalette
  feedback/   Alert(+Provider) · Toast(+er) · Progress · Spinner · Skeleton
stores/       alertStore · toastStore · themeStore · commandPaletteStore
utils.js      shared helpers
tokens.css    the kit's own tokens, on top of @frontierjs/css
test/         compile-all.mjs · render.mjs · attributes.mjs · form.mjs
```

---

## What bites here

- **`$context.form` is the seam.** `forms/Form.mesa` provides
  `{ errors, submitting, disabled, fields, submitted }`; nine controls read it to
  resolve their own label, constraints, `aria-invalid` and message. An absent form
  reads `undefined` and every fallback is what the control did standing alone.
  **A stated prop always wins**, including `required={false}`.
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
- **Fifteen components still carry a `<style>`, and thirteen are fine.** They
  are `.fjs-*` prefixed, small, and mostly geometry the design system does not
  and should not ship — a slider handle's inset math, a dot's ping keyframe, an
  avatar status dot's corner offset. Nine of the thirteen read design tokens.
  **The two that are not fine are the two biggest**: `DatePicker` (468 lines,
  107 custom properties, 47 defined without reading a token, its own radius and
  font-size scales) and `CommandPalette` (276 lines, its own `--cp-*`
  namespace). Between them, 69% of all the CSS in the kit. `FJS-128`/`FJS-129`.
  Neither is a name collision; both are token divergence, so a theme switch
  reaches them partially and `.dense` not at all.
- **A compile test and a render test cannot reach what this kit adds.** A roving
  tablist, a focus trap, a combobox, ⌘K — all of it needs a browser. 29 of 64
  components have been opened in one; the rest, including DatePicker and the
  popover family, have not. Adding a component means adding it to a drive.
- Errors arrive through `toFieldErrors()` (sierra's `field-rules.js`), which is
  the one owner of "a thrown value → per-field messages". `<Form>` calls it and
  knows nothing else about error shapes.

## Proving a change

`bun run test`, then `example`: `bun run verify:ui` — the behavioural components
on real screens. `verify` covers the 13 that carry every route.
