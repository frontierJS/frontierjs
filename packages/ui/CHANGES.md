# Changes

Newest first.

## 2026-08-06 (later) — `<Form>` in a real browser, and three defects it found

`example/web/src/routes/orders/create.mesa` was rewritten onto `<Form>`. About
90 lines went: `errors` / `shown` / `typed` / `visible`, a `check()`, an
`onInput`, an `onLeave`, a `saving` flag, a `failed` string, and a `save()` that
coerced, validated, revealed everything and unwrapped a
`ResourceValidationError` by hand. All of it was correct and none of it was
about orders. `bun run verify` is **37/37 in dev and in the production build**.

**`<Form>` gained the live-validation rule**, because the page had it and it is
not app-specific. One rule: *on input an error may only be removed, never
revealed.* A field is revealed by leaving it having typed in it, or by
submitting; input then re-checks a field that is already speaking, so a bad
value goes red on blur and quiet again on the keystroke that fixes it. Client
and server messages are kept apart — a server message survives until its own
field is edited, a live one wins where both exist. `validateOn` is
`'blur'` (default) / `'input'` / `'submit'`.

Implementation note: the reveal listener is **`blur` in the capture phase**, not
`focusout`. Capture runs root-to-target regardless of whether the event bubbles,
so one listener on the `<form>` sees a `blur` that by definition does not.

### Three defects, all found by running it

**A component cannot expose a method** — `ISSUES.md` FJS-087. `export function
submit()` is dropped from Mesa's output entirely, so `<Form>`'s own
`on:submit={submit}` threw `ReferenceError` on the first click. The documented
workaround is worse: `export let submit = async () => {…}` emits
`$runtime.get(sig) = true` for each assignment in the body and does not parse.
**No render test could have caught the first half** — SSR never dispatches an
event. `<Form>` hands its API out through an `onready` callback until this is
fixed, and several components in this package document `bind:this` methods that
do not exist.

**An unpicked relation picker selected the first row** — FJS-075, open since
before 2026-08-05. `Select`'s placeholder `<option>` was `disabled`, and a
disabled option cannot hold the selection: a select whose options arrive late —
which is every relation picker — lost the placeholder the moment the list
repopulated and landed on the first real row. An unpicked "customer" became
customer #1 and the order was filed against them with nothing on screen saying
so. The placeholder is no longer disabled.

**A control shadowed the schema's `@label`** — FJS-077, second half. `Select`
and `Textarea` computed `nameToLabel(name)` and passed it to `<Field>` as an
explicit label, so a rule's `title` could never win and `@label("Customer")`
rendered as "Customer Id". Both now pass `label={label || undefined}` and let
`Field` resolve once. Every other control that wraps `Field` still has it.

## 2026-08-06 — `<Form>`, and the schema reaching the control that needs it

**New: `components/forms/Form.mesa`.** The form state machine, derived rather
than declared. `<Form {resource}>` owns in-flight state, dirty tracking,
double-submit refusal and the map from a failed write to a per-field message —
the four things every app wrote by hand, of which the fourth was usually
skipped.

```html
<Form {leads} ondone={r => goto(`/leads/${r.id}`)}>
  <Input name="name" />
  <Input name="email" />
  <Button type="submit">Save</Button>
</Form>
```

Nothing there says what a Lead is. `createResource('leads')` read that from
`db/schema.lite`, and the form puts the rules and the error map in
`$context.form` so each control resolves its own.

**Nine components now read that context**, and an explicitly-passed prop always
beats it, so every one still works standing alone:

- **`Field`** — the error message, and `required` / the label from the schema
  (`@label` arrives as the rule's `title`).
- **`Input`** — the error, plus `type` from the column (`format: email` →
  `type="email"`, a numeric column → `type="number"`), `maxlength`/`minlength`
  from `@length`, `min`/`max` from `@gte`/`@lte`. `date-time` is deliberately
  NOT mapped: Litestone stores a zone and `datetime-local` neither accepts nor
  emits one, so the round trip would shift the time silently.
- **`Textarea`, `Select`, `NumberInput`, `Combobox`, `MultiSelect`,
  `FileUpload`** — the error, which they already forwarded to `Field`; what was
  missing was their own `aria-invalid`, computed locally from a map they were
  never given.
- **`Button`** — `type="submit"` disables and spins while the form is in
  flight. Scoped to submit on purpose: the Cancel beside it has to stay live.

**`novalidate` is on by default.** Kit controls put a real `required` on the
input, so the browser refused to fire submit and showed its own bubble instead
— not the schema's sentence, not where the layout expected it, and silently,
which reads as a broken submit handler. Turning the native UI off is what lets
the schema own the messages; the constraint attributes stay for assistive tech.

**The error map is not built here.** A failed write arrives in one of three
shapes; unwrapping it is one translation with one owner, sierra's
`toFieldErrors`, reached as `resource.fieldErrors(err)`. Without a resource
`<Form>` degrades to a form-level message rather than carrying a second copy —
pass `mapErrors` to supply your own.

New: `utils.js` gains `resolveError` / `resolveRule` / `stated`. `stated()`
exists because `required={false}` has to beat a schema that says required, so
the resolution is `??` over "was anything said", not `||` over truthiness.

Tests: `test/form.mjs`, 7 cases — 64/64 compile, 25/25 render, and `example`'s
`verify:ui` still 26/26 in a browser.

## 2026-08-04 — the overlay and form families, in a browser at last

`example/` grew four screens built to drive the components a render test
cannot reach: an order detail (Breadcrumbs, Steps, Tabs, DropdownMenu, Modal,
Tooltip, StatCard, Skeleton), a products filter bar (Combobox, MultiSelect,
Slider, Pagination, EmptyState, Table's loading state), a settings screen
(Accordion, Switch, RadioGroup, NumberInput, Textarea, Progress) and a ⌘K
CommandPalette in the shell. `bun run verify:ui` asserts **26 facts** about
them in headless Chrome, dev and production build alike.

**28 of the 63 components are now browser-verified.** What that cost:

- **Every store in the package was inert.** `toastStore`, `commandPaletteStore`,
  `alertStore` and `themeStore` all wrote `this.items = …` on a plain object.
  A component watches a plain object through `watchProxy`, and only a write
  through that proxy notifies — so toasts queued correctly and the Toaster
  never rendered one, and ⌘K flipped a boolean nothing was listening to. All
  four now mutate through a proxy handle, the shape `session.js` in `example/`
  documents.
- **`DropdownMenu` rendered `{@render children?.()}`** while its own
  documented usage puts `DropdownItem`s as ordinary children — which in Mesa
  is the default SLOT. Every menu opened empty. It also announced nothing:
  `aria-haspopup` / `aria-expanded` are now written onto the caller's control
  (the wrapper is not focusable, so state announced there is state nobody
  hears).
- **`Table`'s loading state threw.** `{#each { length: skeletonRows } as _}` —
  an each takes an array, and an array-LIKE reaches the runtime as
  `array.map is not a function`. `Array.from(…)` now.
- **`RadioGroup` declared `id` and used it nowhere**, so the group could not be
  addressed and `Field` rendered `<label for="">`. `Label` now drops `for`
  when there is no id — a label pointing at nothing is worse than one that
  reads as text.
- **Nothing could take an `id`, `aria-label` or `title`.** The kit's own
  README documents `<Button square aria-label="Delete">`, which was dropped on
  the floor. Mesa's `$attributes` now excludes declared props, and Button,
  Pill, Badge, Alert, Card, SectionHeader, Progress and Slider forward it to
  their root element. The rest of the kit should follow the same one-line
  pattern.

Native where native is right, and confirmed so: `AccordionItem` is a real
`<details>/<summary>`, `Modal` a real `<dialog>` with `showModal()`, `Switch` a
checkbox with `role="switch"`, `TabList` a roving tabindex (verified: one tab
at `tabIndex 0`, ArrowRight moves focus AND selection).


## 2026-08-04 — first browser: the kit drives `example/`

Every route of `example/` — the shell, both tables, the schema-generated form,
the home page — is now built from this kit, and `bun run verify` passes
**37/37 in a real browser, dev and production build alike**. Until today
nothing here had been opened in one. Components exercised: Alert, Badge,
Button, Card, Checkbox, Field, Input, Label, Pill, SectionHeader, Select,
Table.

Five defects, all invisible to the compile and render suites:

- **`Field` toned the wrapper, which colours nothing.** The error line was
  `<p class="field-hint">` inside `<div class="field-group danger">`, but
  `tones.css` registers `--bg-mix` with `inherits: false`, so a tone on an
  ancestor reaches nothing below it: every validation error rendered in the
  ordinary muted hint grey. The tone now sits on the hint itself.
- **`Input` swallowed the input event.** No `oninput` prop, so a caller could
  only see typing through `bind:value` — live validation, a character counter
  or search-as-you-type could not be written against the component at all. It
  now fires `oninput` after writing the value back.
- **`Input` had no `maxlength`/`minlength`.** A length limit is as much a
  schema fact as `min`; `@length(3, 20)` reaches the browser and the only way
  to honour it was to stop using the component.
- **`Input` turned a cleared number field into 0.** `Number('')` is `0`, so
  emptying the box wrote a real value the schema accepts. Empty stays empty.
- **`Select`'s placeholder submitted its own label.** The option was
  `value={null}`; Mesa drops a null attribute, and an `<option>` with no value
  reports its TEXT as its value, so "nothing picked" was the string `Select…`
  and never `''`. Now `value=""`. `Select` also gained `oninput`.

Also: **the `exports` map could not resolve the import its own README
documents.** `"./components/*": "./components/*.mesa"` turns
`@frontierjs/ui/components/forms/Button.mesa` into `…/Button.mesa.mesa`. Both
spellings now resolve.

One thing for callers: these controls put a real `required` on the input, so a
form whose own messages should win needs `novalidate` — otherwise the browser
refuses to fire submit at all and shows its own wording.

## 2026-08-03 — promoted to `packages/ui`, restyled onto `@frontierjs/css`

**Moved.** `packages/mesa/ui-v2/` → `packages/ui/`. It was nested inside the
mesa package, so the `packages/*` workspace glob never saw it: no tests, no
typecheck, no `bun install`. Renamed `@frontierjs/mesa-ui` → `@frontierjs/ui`.

**Deleted `packages/mesa/ui/`** — the older 4-component kit (Badge, Button,
Card, Input), superseded and referenced only by a stale line in mesa's
`PROJECT_STATE.md`.

**Restyled all 63 components onto `@frontierjs/css`.** 55 of them were written
in Tailwind/UnoCSS utility classes — `bg-gray-100 text-gray-600 ring-gray-200`
— and **UnoCSS is not a dependency anywhere in this repo and the CLI does not
scaffold it**, so every one of them rendered unstyled in any FrontierJS app.
Deleted `tokens.css`, a third token vocabulary that only 2 of the 63
components referenced.

Per-component colour and size maps are gone. `utils.js` grew `tone()`, which
maps the old `color=` / `type=` spellings onto the seven css tones, and
`cx()`. Old prop values still work.

**Markup moved onto the platform** where the stylesheet expects it, each
change deleting a real defect — `<dialog>` for Modal/Drawer (the hand-rolled
focus trap could not make the background inert), `<details>` for Accordion,
`<progress>` for Progress/Bar, a real checkbox for Switch, `<fieldset
disabled>` for Fieldset, a real `<button>` for the Table sort control and the
FileUpload dropzone. Tooltip became anchored rather than portaled so it can
carry `aria-describedby` at all. Full table in `README.md`.

**Tests, where there were none.** `test/compile-all.mjs` (63/63 compile and
emit parseable JS) and `test/render.mjs` (25/25 render cases carry the css
vocabulary and no utility class has returned).

### Three Mesa compiler bugs fixed on the way

All reported success from `analysis.errors`.

- `const fn = () => { reactiveLet = x }` emitted `$runtime.get(sig) = …` —
  invalid JS, threw on load. Killed Accordion and Tabs. Same for a mutator
  provided through `$context`.
- **`{class}` replaced an element's own classes instead of merging them**, so
  `<button class="btn primary" {class}>` rendered with no classes at all. New
  `bindClassPassthrough` in the runtime. This silently unstyled the whole kit
  both before and after the restyle.

### Worked around, not fixed

`[a, b] = [b, a]` to reactive lets emits invalid JS (DatePicker); `{@const}`
inside `{#each}` calls the index as a getter (Breadcrumbs); `<mesa:element>`
is not a feature and compiles silently (SectionHeader). See `PROJECT_STATE.md`.
