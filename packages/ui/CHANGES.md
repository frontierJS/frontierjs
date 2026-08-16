# Changes

Newest first.

## 2026-08-16 — the Dropdown family, opened in a browser (`FJS-312`)

Four components that had never been run. Three defects came out of the first
pass, one of them below this package.

**Choosing an item never closed the menu.** `DropdownItem` consumes `close()`
from `DropdownMenu`, which renders its items inside `{#if open}` — and Mesa's
`$context` did not reach content a block created after setup, so the read was
`undefined` and the optional call did nothing. Fixed in the runtime
(`FJS-311`); it broke every compound component with parts behind a conditional.

**The trigger announced nothing until the menu had been opened once.** Both
`aria-haspopup` and `aria-expanded` are written onto the caller's own control —
correctly, because the wrapper this component renders is not focusable — from a
watch on `open`, which fires only when the menu first opens. A screen reader met
an ordinary button, which is the one thing the component exists to prevent. The
watch is on `(open, triggerEl)` now.

**ArrowUp from a freshly opened menu focused the second-to-last item.** Opening
focuses the panel, so `indexOf(activeElement)` is -1; stepping from -1
arithmetically gives the first item going down — right by accident — and
`items[(-1-1+n)%n]` going up. Both ends are named rather than computed.

Two things came out of the drive itself. `t.press('Enter')` activated nothing,
because Chrome synthesises a button's click from the key's `text` and Enter was
being sent without one — an Enter that no component handles and an Enter the
harness never really pressed look identical. And `--verbose` prints passing
assertions, which is how you find where a spec that THREW got to.

## 2026-08-16 — `themeStore` is deleted (`FJS-308`)

It added a `.dark` class to `<html>`. **`@frontierjs/css` has no `.dark` rule**,
so `theme.setMode('dark')` changed a class and nothing else; it documented a
`<ThemeProvider />` that does not exist; and nothing in the repo imported it.

The switch belongs to `@frontierjs/sierra/theme`, which now applies the
`theme-*` class the design system actually reads and emits a `<head>` script
that beats first paint. That script is the argument: only the build can write
one, so this package could never have owned the switch — it would only ever
have been a second answer to it.

An app on the kit without Sierra applies the class itself; it is one class on
one element, and `@frontierjs/css` documents it.

## 2026-08-16 — a DateTime column has a control, and the form tail can hear

Two rows that were one problem: a `<Form>` puts the schema in context and a
control has to read it, and six of them never did.

### `DateTimeInput` (`FJS-079`)

`Input` refuses to map `format: date-time` onto `datetime-local`, and is right
to. Litestone stores an INSTANT; that element reads and writes a wall clock
with no zone. Hand one to the other and the offset is truncated going in, and
the zoneless string that comes back is parsed as UTC — **two shifts, opposite
directions, different sizes**, on a control that looks entirely correct. So a
`DateTime` column quietly fell through to a text box.

The conversion has to happen at both edges, which is a control and not a type
attribute:

    <Form {resource}>
      <DateTimeInput
        name="scheduledFor"
        value={record.scheduledFor}
        onvalue={(iso) => record.scheduledFor = iso}
      />
    </Form>

Inside a generated form nothing is written at all — Sierra's table answers
`datetime` and `FormField.mesa` binds it, the two halves `FJS-D17` ruled.

The round trip is exact as long as the zone shown is the reader's own, and the
`.field-addon` beside the value NAMES it: *14:30* without a zone is the
ambiguity the file exists to close. Three details are the substance —

- **An incomplete entry is `''`, not an invented instant.** `datetime-local`
  reports an empty value for every state short of a whole date and time.
- **A stored value carrying seconds gets `step="1"`.** Asked of the VALUE,
  because the schema says `DateTime` and not how precise this column's rows
  are; without it someone changing the day truncates `09:30:45` in passing.
- **There is no `oninput`.** A handler taking the native event would read
  `e.target.value` and get the wall clock — the one value this component
  exists to stop anyone sending. `onvalue(iso)` is the callback that carries a
  value; `onblur`/`onfocus` are forwarded because they carry none.

`DatePicker` is not this control and was never going to be: it is a range
picker an app chooses, not what a column gets. It did gain the form wiring it
lacked (below), so choosing it no longer costs the schema.

### The controls that could not hear the form (`FJS-077`)

Filed as four deaf controls and a label bug. Driving it in a browser found
**eight defects, three of them structural**:

- **`Switch` carried no `name`.** The form's dirty tracking could not see the
  field at all.
- **`RadioGroup` wrapped itself in a `<Field>` only when a `label` PROP was
  passed** — and inside a `<Form>` nobody passes one, because the label is a
  schema fact. So it rendered bare, with structurally nowhere to put a server
  error.
- **`Combobox` put no `name` on its input**, which is the one rule
  `controls.js` states in bold.
- `Select` read the rule for its enum members and never for `required`, with a
  comment beside it calling the required a schema fact.
- `Textarea` had a `required` prop and ignored `maxLength`.
- **`NumberInput` resolved neither bound** — and those feed the ± buttons as
  well as the input, so a schema minimum the component could not see was a
  stepper that walked straight past it.
- Five controls passed `label={label || name}` to `<Field>`, always truthy when
  a name is given, so the raw column name arrived as an explicit label and
  `@label("Customer")` was unreachable through the kit.

`aria-required` rather than a native one where the element is not the value: a
radiogroup is not labelable, and a MultiSelect's inner box is a search field
whose resting state is empty, so a `required` there refuses every submit.
`RadioGroup`'s selected card also stopped hand-mixing a `color-mix()` and reads
`--bg-mix` → `--tint-surface`/`--tint-rule`, per the rule the two
token-divergence issues left behind.

### What proves it

One fixture, twelve controls in one `<Form>`, and **every field declaring a
`title` that is not its title-cased column name** — so a control that shadows
the schema is a different string on screen rather than a coincidence. Then one
rejected submit naming every field at once, because a control's own error line
takes a request, a throw and a form that mapped it, and no render test can
produce one.

The drive gained two things to make that possible: `/@sierra/` and
`/@toolbelt/` mounts, so a fixture reads the REAL control table rather than its
own idea of what a `Float` is, and `waitSettled(sel)` — `waitVisible` answers
*can this be seen*, which is not *has it stopped moving*, and a coordinate
click on a neighbour that is still animating lands wherever the layout has
since put it. That one was green alone and red under load.

Coverage: **42 of 66**, from 28.

## 2026-08-16 — a toast you can settle

`toasts.add()` returned an id and `remove(id)` was the only thing that ever
took one back (`FJS-119`). So a long action could announce that it had started
or announce how it went, never both on one toast — and every caller in this
repo picked one: say nothing until the end, which makes a transition that
crosses the network look like a click that did nothing, or leave a *Sending…*
on screen for good.

    const said = toasts.loading('Sending…')
    try   { await send(); said.update('success', 'Sent') }
    catch (e) { said.update('error', e.message) }

`loading()` returns `{ id, update(type, message, duration?), dismiss() }`, and
`toasts.update(id, patch)` sits underneath it for anything holding a bare id.
A loading toast carries a **spinner instead of a verdict icon** and no drain
bar: nothing knows how long the work will take, and a bar that empties while
the request is still open is a lie about the state of the system. Settling it
gives it the lifetime it did not have.

Three details are the substance rather than the shape:

- **Settling a toast the reader dismissed answers `false`** and does not put it
  back. A *Sent* appearing after someone closed the notification is worse than
  no notification.
- **`update()` reschedules the timer only when the caller states a duration**,
  so editing a message does not silently restart a lifetime that is already
  running.
- **The pending timers are held by id and cleared on remove.** Settling twice —
  a retry that fails and then succeeds — used to leave the first timer running,
  which would remove the second message early.

Proven where it matters. The kit drive asserts the whole lifecycle including
**node identity**: an update that removes the toast and adds another looks
identical on screen and loses the reader's place in the stack, so the spec
marks the node while it is still loading and looks for the same one after it
settles. `example`'s `verify:ui` drives a real order transition through it and
makes the same check on a real screen.

`basecamp`'s `channels/index.mesa` — the screen this was filed from, where a
failed delivery once reported nothing at all — drops its workaround. `busy`
stays: it is what disables the row's buttons, which is a different job from
saying what is happening.

## 2026-08-16 — CommandPalette is on the design system's tokens, and it was handling every key twice

`FJS-129`, the sibling of the DatePicker work below: 276 lines with 21 custom
properties in a `--cp-*` namespace, five of them defined without reading a
token — `--cp-radius: 12px`, `--cp-font: 'SF Mono', …`,
`--cp-shadow: 0 24px 80px rgba(0,0,0,0.72)` — plus five literal colours and
every padding and font-size in px, so a theme switch reached it partially and
`.dense` not at all.

Now **254 lines and two knobs**, `--cp-accent` and `--cp-font`, both reading
tokens. Radius from `--card-radius`, face from `--font-mono`, type from the
`--text-*` ladder, spacing from `--space-*`, elevation from `--shadow-lg`,
motion from `--motion-fast`.

**Three of the palette's own things turned out to be things the package
already ships**, which is the more interesting half:

- The keycaps were a local `.cp-kbd`. `code.css` styles `<kbd>` on the
  ELEMENT, so the fix was deleting the class — sixteen lines that had been
  fighting a shipped term.
- The badge is `.badge` with a tone, tinted rather than filled.
- The active row's three hand-mixed `color-mix()` calls are the package's TINT
  ramp: set `--bg-mix` and `--tint-surface` / `--tint-rule` / `--tint-ink`
  follow, already measured for contrast against every shipped theme. Three
  colours nobody would think to re-measure, replaced by one input.

**The scrim became a token in `@frontierjs/css`.** The palette dimmed at 0.72
while every `<dialog>` in the package dimmed at 0.45, and neither could be
retuned by a theme. `--scrim` is a literal rather than a blend of `--ink`,
because a scrim never inverts: mixed from ink it goes white on a dark theme,
which is the one thing a backdrop cannot be.

**And the drive found a defect worth more than the restyle** (`FJS-305`):
`on:keydown` was bound on the backdrop AND on the search input, and keydown
bubbles — so every press ran the handler twice. Arrow keys skipped a row, and
**Enter ran the chosen command twice**. `example`'s `verify:ui` has driven this
palette since it was written; it asserts that the palette opens, filters and
runs a command, and none of those can see a doubled press. The kit spec presses
ArrowDown twice and asks which row is active, then counts how many times the
action fired.

Classes are `fjs-cp-*` now, and `example`'s drive named four of the old ones,
so it moved with them.

## 2026-08-16 — DatePicker is styled from the design system, not from its own copy of one

468 lines of local `<style>` declaring **107 custom properties, 47 of them
defined without reading a single design token** — its own six-rung radius
scale, its own font-size scale, `font-family: sans-serif`, eight literal
colours, and four base64 PNG arrows. A theme switch reached it partially at
best and `.dense` not at all. That is `FJS-128`, and the blocker on it was
never the CSS: it was that this component had never been opened in a browser,
so there was nothing to catch a rewrite going wrong.

Now **320 lines and six declared properties**, four of which are the knobs a
caller overrides and each of which reads a token:

    --dp-cell    one day cell, square
    --dp-accent  the selected day's fill
    --dp-band    the in-range band
    --dp-layer   the panel's z-index

Everything else is the package's: `--pill-radius`/`--card-radius`/
`--field-radius`, `--font-primary` and the `--text-*` ladder, `--space-*` (so
`.dense` reaches the whole panel), `--shadow-lg`, `--rule`, `--surface-raised`.
The range band's bleed is `calc(var(--dp-cell) / 2)` rather than the literal
20px it was against a literal 40px cell.

Three things worth keeping:

- **The focus ring is drawn here, from `--ring-*`.** `focus.css` opts elements
  in by class and cannot name a class this kit invented, so a kit component
  with its own focusable parts has to draw the ring — but it varies it through
  the tokens rather than writing another recipe. What was there was
  `outline: 5px auto -webkit-focus-ring-color`.
- **The selected day is `.chip`.** That is what derives `--fill`/`--on-fill`
  from `--bg-mix`, so the number on a selected day stays legible against any
  tone a theme defines instead of assuming white.
- **The arrows are inline SVG over `currentColor`.** As base64 PNGs they were
  black pixels: invisible on a dark theme, and unable to follow a tone.

Every internal class is `fjs-dp-*`, so `.disabled`, `.start` and `.end` only
ever appear as compounds of one — the file no longer writes a selector that
reads like package vocabulary.

The drive carries 30 assertions on it now, six of them the failures above asked
as measurements: a theme switch moves the painted colours, `.dense` moves the
padding, overriding `--dp-cell` moves the disc, the grid track and the band's
bleed together, and the arrows are SVG rather than a background image. One
defect came out of the rewrite itself and is pinned — the band rule and the
range-end rule are equally specific and the band's comes first, so setting only
`--bg-mix` on the end left it painted in the band with a fill's text colour.
The screenshot caught it; the class assertions could not.

## 2026-08-16 — the kit has a browser drive of its own, and it found six defects on day one

Everything this package adds over `@frontierjs/css` is behaviour, and until
today the only thing that could see behaviour was `example`'s `verify:ui` —
which covers a component by first putting it on a real application screen. That
friction is why 35 of 64 components had never been opened in a browser at all
(`FJS-028`), including the 1200-line `DatePicker`.

`test/browser/` is the drive. A node HTTP server compiles each `.mesa` on
request and serves the kit under an import map, so a compiled component resolves
`@frontierjs/mesa/runtime.js`, `../../utils.js` and its children exactly as it
does in an app; Chrome is driven over CDP, because half of what is asserted is a
response to input and a dispatched `KeyboardEvent` is not trusted — it moves no
focus, types no character and dismisses no `[popover]`. A fixture is a
component, not a props object, because a slot cannot be expressed as one.
Covering a component is now a fixture and a spec. `bun run test` runs it;
`bun run serve` starts the server alone, for looking at something.

Eleven specs, 146 assertions, 27 of 65 components — and six defects in four
packages, every one of them invisible to a compile test and a render test:

- **`<dialog on:close>` never fired.** Mesa delegated five events that do not
  bubble, so Escape closed a `Modal` or a `Drawer` natively, `bind:open` was
  never written back, and **the overlay could not be reopened for the life of
  the page** (`FJS-297`). `Modal` had been covered by `verify:ui` since it was
  written — it asserted focus going in, and never the way out.
- **`.avatars` overlapped nothing and ringed nothing.** `.avatar` must stay a
  plain box, so `Avatar` wraps it to pin a status dot, and css's
  `> .avatar + .avatar` matched none of them (`FJS-302`).
- **`DatePicker` threw on every month change** into a shorter month
  (`FJS-300`), and **`disabledDates` disabled the day before the one it named**
  west of Greenwich, because a bare `YYYY-MM-DD` parses as UTC midnight and
  everything else in the component is local (`FJS-301`).
- **`Tooltip` documented a handoff that is not Mesa syntax** — `let:tipId`, on a
  `<slot>` attribute that delivers nothing — so its accessibility contract had
  no working spelling (`FJS-299`). It now hands the id to a `children` snippet.
- **A `children` snippet crashed the render** of any component built around
  `<slot />`, by reaching `{...$attributes}` and assigning a function to a
  getter-only DOM property (`FJS-298`).

Two mesa questions the drive raised are open rather than fixed: an `{#if}`
guard tears down after the reads inside it recompute (`FJS-303`), and an
attribute on a `<slot>` is silently ignored (`FJS-304`).

## 2026-08-16 — the control ladder is a registry, and the kit's own five are in it (FJS-D17)

`<Form>` held an `{#if}` ladder over the five control names Sierra's table can
answer, which made those five the only controls there could ever be: a plugin
could name a control and nothing would render it. The ladder is now a TABLE in
`FormField.mesa`, and `@frontierjs/ui/controls` is a registry consulted before
it — so a contributed control takes the path a built-in takes, and a registered
name **replaces** a built-in of that name rather than losing to it.
`registerFormControl('select', MyCombobox)` swaps every generated select in an
app.

The other half is Sierra's `registerControl`, which names the control. Two
registrations because the halves sit on opposite sides of a dependency rule —
that table must run in plain Node, this kit may not import Sierra — and a name
is the only thing that crosses.

With no `props` builder a control is handed
`{ name, field, value, onvalue, options }`. A name nobody bound renders nothing
and says which half is missing, naming the call that would fix it.

Two things moved with it. A picker's rows are now fetched for a FOREIGN KEY
rather than for the control literally named `picker`, so a contributed combobox
over `customerId` gets its rows without having to claim the built-in name to do
it. And `writeField` marks the form dirty as well as the bubbled `input`
listener, because a contributed control is not obliged to be a DOM input and one
that hands back a value without emitting an event used to leave an edited form
saying it was pristine.

65/65 compile, 27/27 render, 60/60 attributes (5 skipped, named), 17/17 form —
the three new form cases render a contributed control in a real `<Form>`, and
were negative-controlled by disabling the registry lookup.

## 2026-08-15 — a `readOnly` column is not a gap, so `<Form>` stops complaining about one

The generated list warns by name about every column it cannot place, which is
the point — a field missing from a form in silence is the bug generating it was
meant to end. But `readOnly` is not that: `@system`, `@computed`, `@generated`
and `@from` are the schema saying the value is not the caller's to write, and a
form leaving one out is the annotation working. Now only a column the KIT has no
control for is said out loud — an array, a `Json` document, a name the model
does not have.

`example`'s order form is the case: `trackingCode` became `@system` and every
page load logged a warning about a field the schema had just correctly hidden.

## 2026-08-15 — `<Form>` generates its own field list

`<Form {leads} />` with no children now renders every writable column of the
model, in schema order, each with the control its type implies. `only` narrows
and orders, `except` removes, and children still win — passing any means the
caller is writing the form, unless `auto` says otherwise, in which case the
generated fields come first and the children after.

The field SET was the last thing a form restated about a model. The state
machine went in 2026-08-06 and the per-field rules with it; what stayed was a
`{#each Object.entries(fields)}` ladder deciding control-per-type, written
slightly differently in every app. `example`'s order form was ~150 lines and is
now nine, of which the only field name is `except={['trackingCode']}` — a column
a Caravan job writes, which the schema cannot yet declare (`FJS-095`).

**The control table is not here.** It lives in Sierra's `field-rules.js` and
this component asks the resource for it (`resource.formFields()`,
`resource.options()`), for two reasons: this package peers only on mesa and css,
so a form that had to import Sierra to know what a `Float` is would invert the
dependency — and a hand-written form and a generated one have to agree, which
one table is the only way to hold.

**A column with no control is reported, not dropped.** An array, a `Json`
document, a name that is not a field: each comes back in the list with a reason
and `<Form>` warns naming it. A field silently missing from a form is exactly
the failure generating the list is meant to end, and it would be invisible in
the one place a person would look for it.

Two controls grew what they needed to be generated:

- **`<Select>` derives its options from the schema** (`FJS-078`). `fields.status.enum`
  is right there and every enum select in the repo mapped it by hand. Stated
  options still win; this is a fallback, and a select over anything that is not
  an enum is unaffected.
- **`<Checkbox>` reads `$context.form`** — its label from `@label`, its
  `required`, and its server error. A boolean column is a checkbox, so it was
  the one control a generated form emitted that could not say its own name or
  show its own rejection. Four controls still resolve nothing (`FJS-077`).

Proven in a browser: `example`'s `verify` (37) and `verify:build` (37), whose
form assertions are unchanged — same labels, same control types, same order,
same messages — against a page that no longer names a field. Selectors there
moved from `#f-<column>` to `[name="<column>"]`, because a generated control
makes its own id and the name is the better handle anyway: it is what the form
routes a message back to.

## 2026-08-14 — the stores could not be imported with the extension they have

`exports` declared `"./stores/*": "./stores/*.js"`, so
`@frontierjs/ui/stores/toastStore.js` — the spelling every consumer in this repo
uses — resolved to `stores/toastStore.js.js` and failed:

```
[RESOLVE_ERROR] Could not resolve '@frontierjs/ui/stores/toastStore.js'
```

The components entry already handled both spellings (`"./components/*.mesa"` and
`"./components/*"`); the stores entry handled only the one nobody writes. Added
the pair.

Nothing here could see it. Basecamp aliases `@frontierjs/ui` to `packages/ui/`
so a component fix does not need a reinstall, which turns every subpath into a
plain filesystem path and the export map is never consulted. It surfaced the
first time the kit was installed for real — inside a container image.

## 2026-08-10 — the methods five components documented now exist

Mesa closed `FJS-087` and `FJS-023`, and both had a workaround here.

`Input`, `Select`, `Textarea` and `NumberInput` each declare `export function
focus()`; the compiler had been deleting it, so every one of them documented a
method that was absent from the output. Nothing here changed — they work now.

`Form` dropped the comment explaining why `submit()`/`reset()`/`clearErrors()
could not be methods and made them `export function`. **`onready` stays**: an
app that captured the api at mount has nothing to gain from changing, and both
routes reach the same three functions.

`SectionHeader` replaced its explicit `h1`–`h6` `{#if}` ladder with
`<mesa:element this={'h' + hLevel}>` — one line for six branches. `test/render.mjs`
now asserts the heading TAG for `level: 3`, because a level that stopped
reaching the DOM would render something that looks identical and carries a
different document outline.

## 2026-08-10 — every component forwards its caller's attributes

`{...$attributes}` was on 9 of 64 components; the other 55 dropped `id`,
`data-*`, `aria-*` and everything else the caller wrote, silently
(`FJS-029`/`FJS-137`). `<Mono id="x">` rendered a bare `<code>`, so the caller
could not address the element they had just written and `aria-describedby` had
nothing to point at — basecamp worked around it with a wrapper `<span>`.

`FJS-137` said `id` had to be declared as a prop on each of the 22 display
components. It does not: the spread compiles to
`restProps($option.props, declared)`, so an id the component does NOT declare
passes through it. One fix, not two, and 22 props not written.

**Where the spread lands is not uniform.** Display, layout, feedback and
overlay put it where `{class}` already goes. A form control puts it on the
CONTROL — the `<input>`, `<select>`, `<textarea>` — not the `.field-group`
wrapper, because that is the element a `<label for>` and an `aria-describedby`
have to reach. `FileUpload` uses its visible dropzone rather than the
visually-hidden file input, and `DatePicker` uses the wrapper because its
trigger is whatever the caller puts in the slot; both say so in the file.

Where `id` is already a declared prop it means something else — `Toast`'s
identity, the pairing `Tab`/`TabPanel`/`AccordionItem` render as
`id="tab-{id}"`, the control a `Label` or `Field` points at, `Tooltip`'s
generated id — and a caller addresses those with `data-*`.

New `test/attributes.mjs` renders all 64 and holds three claims: an undeclared
attribute reaches the DOM, `id` reaches it wherever it is not a declared prop,
and the caller's value REPLACES the component's own rather than duplicating it.
The six it cannot render are named with the reason instead of filtered out.

**It found three Mesa defects on its first run** — it is the first thing in
this repo that renders every component — and all three were fixed the same day.
`FJS-146`: an `{@attach}` ran during SSR, where happy-dom has no `el.animate`,
so `Toast` threw and took the whole render with it. `FJS-147`:
`{#each { length: n }}` was not iterable, so **`DatePicker` had never rendered
at all, anywhere**, in the whole life of the file. `FJS-148`: a `style:`
directive resolving to `null` emitted the literal string `null` for some
properties. With those closed, both components render, so neither is skipped
here any more and `Toast` is a render case for the first time.

64/64 compile, 26/26 render, 60/60 attributes (4 skipped, named), 7/7 form.
`example`: `verify:ui` 27/27, `verify` 37/37, `verify:public` 21/21.

## 2026-08-10 — two Mesa workarounds come out

Mesa rewrites a destructuring assignment to reactive lets (`FJS-021`), so
`DatePicker` writes its backwards-range swap as
`[_startDate, _endDate] = [_endDate, _startDate]` rather than through a temp.

`Breadcrumbs` still marks the last item in its script, but not for the reason
its comment gave: a `{@const}` reading the loop index works (`FJS-022` closed
as no longer real) — truncation is simply what decides which item IS last, and
the template would be re-deriving it against a length that may already have
been cut down. `Combobox` and `MultiSelect` were already reading the index in a
`{@const}`, which is the evidence the gap had gone.

64/64 compile, 25/25 render, 7/7 form.

## 2026-08-09 — `Pagination` follows the class rename

`@frontierjs/css` v0.14.6 renamed `.page` → `.pagination-link` and
`.page-gap` → `.pagination-gap`. `Pagination.mesa` is the only consumer in
the repo, so this is markup-only — the props, the sliding window and the
ellipsis compression are untouched.

Why the package renamed it: `Page` is already a tier in the vocabulary
(Screen, Pane, View, Tabs), and `Previous`/`Next` carried a class calling
them pages. Ruled in `DECISIONS.md`.

An app that wrote the old class by hand keeps the markup and loses the
style — there is no alias, and none is planned.

## 2026-08-08 — the kit stops styling the package's own terms

Two local `<style>` blocks deleted. Both styled a class `@frontierjs/css` owns,
which is the only way a kit component can silently change how the package
behaves for an app that never imports the kit.

**`DropdownItem` (`FJS-126`).** Eight declarations, four of which restated
`.item`'s own layout. One of those four — `gap: 0.625rem` — disagreed with the
`var(--space-sm)` every other Item reads, so a menu row's icon sat a rung
further from its label than an identical row outside a menu, **and could not
move inside a `.dense` region**, because a literal has no density. `lists.css`
has owned the control reset since the day this copy was reported
(`.items :is(button, a).item`), and `DropdownMenu` renders
`<div class="items menu">`, so the descendant selector matches and the disabled
pair keeps the `.items` scoping that lets it outrank the `(0,3,0)` hover.

**`Drawer` (`FJS-127`).** Four lines making the drawer a flex column so a
`.surface-body` between a header and a footer takes the remaining height.
Moved into `drawers.css`, which owns `.drawer`. The `[open]` scoping is the
whole subtlety and travelled with a comment: an author `display: flex` beats
the UA's `display: none`, so declared on `.drawer` the drawer would render on
screen while shut — the trap `overlay: a closed <dialog> stays closed` already
records. A new css test asserts both halves and was proven to fail; dropping
`[open]` turns two tests red.

Verified in a real browser, not by compiling: `example`: `verify:ui` **27/27**
including `menu.items` and `menu.escapeCloses`, and `verify` **37/37**. The
kit's own suite is unchanged at 64/64 compile, 25/25 render, 7/7 form.

**Two components still ship their own design system** — `DatePicker`
(468 lines, 107 custom properties, 47 of them defined without reading a design
token) and `CommandPalette` (276 lines, its own `--cp-*` namespace). Between
them that is 69% of all the CSS in the kit. `FJS-128` and `FJS-129`; neither is
a name collision, both are token divergence, and a theme switch reaches them
partially at best.

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
