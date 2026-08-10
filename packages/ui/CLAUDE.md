# ui — package map

**`@frontierjs/ui`** — a Mesa component kit over `@frontierjs/css`. 64
components, no build step, no utility classes (Invariant 13: style with a tone
and a treatment, never a color).

`bun run test` runs three node harnesses in order: compile-all → render → form.

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
test/         compile-all.mjs · render.mjs · form.mjs
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
- **A component cannot expose a method** (mesa `FJS-087`) — `export function` in
  an instance script is dropped. Hand behaviour out through a callback prop.
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
