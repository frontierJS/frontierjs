# ui — package map

**`@frontierjs/ui`** — a Mesa component kit over `@frontierjs/css`. No
build step, no utility classes (Invariant 13: style with a tone
and a treatment, never a color).

`bun run test` runs four node harnesses in order — compile-all → render →
attributes → form — and then the **browser drive**, which needs Chrome on PATH
or `$FJS_CHROME`. `bun run test:browser` is the drive alone; `bun run serve`
starts its server and stays up, for looking at a component in a real browser.

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `components/forms/Form.mesa` is the form — provides `$context.form`, owns the live-validation rule, autosave and `method="auto"` · `components/forms/FormField.mesa` is the control dispatcher · `controls.js` is where an app contributes a control (the table itself is `sierra/src/resource/field-rules.js`).
- `components/{display,layout,overlay,feedback}/` are the rest of the kit; `components/display/Cell.mesa` is the lazy-loading example · `stores/` holds `alertStore` · `toastStore` · `commandPaletteStore`.
- `utils.js` — `overlayHost()` for every portal, `download(blob | response, filename)` and `openFile(fetchFile, { name })` · `nav.js` is the `src/lib/nav.js` contract Shell draws from · `dnd.js`, `drag.js`, `rowlist.js` are `{@attach}`es · `selection.js` is `createSelection` (`FJS-D671`).
- `test/` — `compile-all.mjs` · `render.mjs` · `attributes.mjs` · `form.mjs` · `nav.mjs` · `datetime-zone.mjs`.
- `test/browser/` is the kit drive — `run.mjs`, `server.mjs`, `page.js`, `fixtures/*.mesa`, `specs/*.spec.mjs`; Chrome, CDP and the probes are mesa's `mesa/test/browser/{drive.mjs,probes.js}`, read by relative path.

## What bites here

The dozen that bite most; the full catalog is `docs/hazards.md`, read it before
touching a form, a control, an overlay or a `<style>`.

- **`<Form autosave>` is a timer over `dirty`** (`FJS-D257`): it never `submit()`s, never fires `ondone`, never retries a refusal, refuses a create, and is DISARMED by the button.
- **`$context.form` is the seam** and **a stated prop always wins**, `required={false}` included. `label={label || name}` shadows the schema — it is `label={label || undefined}`; a control wraps itself in `<Field>` on `label || name`, never on `label` (`FJS-077`).
- **`<Form>` is `novalidate` by default**; controls still carry a real `required` for assistive tech.
- **`<Table>` takes the `$orderBy` DIRECTIVE** — read it with toolbelt's `orderByPair`, never by hand (`FJS-1077`); with no `onsort` it sorts its own rows (`FJS-D672`); it holds no schema, so `@collate(nocase)` sorts BINARY unless the page passes `collations` (`FJS-3402`). A row-actions column declares `hideLabel: true`.
- **A `DateTime` column is `DateTimeInput`** — converts at both edges and names the zone; it has no `oninput`, `onvalue(iso)` carries the value.
- **A native range input holds its own DOM value** — `Thresholds`' `syncRows` is what writes it back; the tripwire is `thresholds.spec.mjs`.
- **`<Form>` with no children asks the resource for its field list** — the control table is sierra's, not this package's; a column with no control is warned about by name.
- **A contributed control is `controls.js` plus Sierra's `registerControl`**, and a registered name REPLACES a built-in (`FJS-D17`); put `name` on the element that emits input.
- **A control calls `$context.form.changed(name)` when it commits a value** (`FJS-D903`) — the one place that sets `dirty`; `form-changed.spec.mjs` fails a file in `components/forms/` with no row.
- **On input an error may only be REMOVED, never added**, once, in `Form.mesa`; a submit refuses only over a control the form is SHOWING (`FJS-316`). Every control's `disabled` prop defaults to `undefined`, not `false`, or `stated()` never lets the form answer.
- **`{...$attributes}` goes on the element the caller means** — a form control puts them on the CONTROL, not the `.field-group`.
- **A portal goes to `overlayHost()` (`utils.js`), never `document.body`**, and a panel positioned in a frame callback is not visible before it.
- **A local `<style>` may not name a class `@frontierjs/css` owns**, and every component `<style>` reads tokens.
- **An overlay finds its rows and its trigger by reference, never by query** (`FJS-2391`) — a terminal node has no `querySelector`; what a part registers with its parent, it registers as a getter, and a `const` consumer of `$context.x` is the live VALUE.
- **A compile test and a render test cannot reach what this kit adds** — only the drive opens the component; a class name a drive selects is published surface.

---

## Proving a change

`bun run test` — which now includes the browser drive — then `example`:
`bun run verify:ui`, the behavioral components on real screens. `verify` covers
the 13 that carry every route. The two drives answer different questions and
both are worth running: this one mounts a component alone and can reach modes no
screen uses, `example`'s puts it in an app with a real service behind it.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
Accordion.mesa Alert.mesa alertStore.js Avatar.mesa Badge.mesa Bar.mesa Breadcrumbs.mesa
BulkBar.mesa Button.mesa Callout.mesa Card.mesa Cell.mesa Checkbox.mesa CLAUDE.md
CodeInput.mesa Combobox.mesa CommandPalette.mesa commandPaletteStore.js Composer.mesa
ConfirmationPopover.mesa ConfirmPanel.mesa ConfirmProvider.mesa controls.js DatePicker.mesa
DateTimeInput.mesa DayRangeFilter.mesa dnd.js drag.js Drawer.mesa DropdownMenu.mesa EmptyState.mesa Field.mesa
Fieldset.mesa FileField.mesa FileUpload.mesa FilterBar.mesa FormField.mesa Form.mesa
GeoField.mesa HoverCard.mesa HtmlFrame.mesa Input.mesa JsonInput.mesa Json.mesa Label.mesa
Markdown.mesa Message.mesa Modal.mesa MoneyInput.mesa MultiSelect.mesa nav.js
NumberInput.mesa Pagination.mesa Pill.mesa Popover.mesa Progress.mesa RadioGroup.mesa RangeInput.mesa
rowlist.js selection.js Select.mesa Shell.mesa SignaturePad.mesa SignatureView.mesa
Skeleton.mesa Slider.mesa Sparkline.mesa Spinner.mesa StatCard.mesa Stat.mesa Steps.mesa
Switch.mesa Table.mesa TabList.mesa Tab.mesa TabPanel.mesa Tabs.mesa Tag.mesa
TemplatePreview.mesa Textarea.mesa Textbox.mesa ThemePicker.mesa ThemeSwatch.mesa Thresholds.mesa Toast.mesa toastStore.js
Tooltip.mesa Transcript.mesa utils.js
-->
