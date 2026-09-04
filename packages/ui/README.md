# @frontierjs/ui

Mesa components over [`@frontierjs/css`](../css). 70 components across forms,
display, layout, overlay and feedback.

```bash
bun add @frontierjs/ui @frontierjs/css @frontierjs/mesa
```

```js
import '@frontierjs/css'
```

```html
<body class="theme-default">
```

```svelte
<script>
  import Button from '@frontierjs/ui/components/forms/Button.mesa'
  import Alert  from '@frontierjs/ui/components/feedback/Alert.mesa'
</script>

<Alert tone="warning" title="Heads up">Your trial ends Friday.</Alert>
<Button tone="danger" onclick={remove}>Delete</Button>
```

**`onclick`, never `on:click`.** A handler reaches a component as a plain
callback prop; the directive form is for elements. Mesa refuses it on a
component (VISION rule 23) and the message names the prop to use — including
for a component's own events, where `on:paid` means `onpaid={fn}`. A modifier
has nowhere to go: the child decides what it passes, so `preventDefault` is the
callback's business.

---

## The split

`@frontierjs/css` ships **zero JavaScript**. That is deliberate, and it is
exactly the line between the two packages:

| | `@frontierjs/css` | `@frontierjs/ui` |
| --- | --- | --- |
| Owns | how it looks, what the markup *is* | keyboard, focus, ARIA, state |
| Ships | plain CSS, no build step | `.mesa` components |
| Answers | "what is a Card" | "how does this Modal trap focus" |

A stylesheet cannot give you a focus-trapped dialog, a roving-tabindex
tablist, a combobox, or a toast queue. This package is that half. Every
component here draws itself with the css vocabulary and adds only behavior.

**There is no second design system here.** No color maps, no size scales, no
`tokens.css`. A component that wants to be red does not carry a red — it takes
a tone.

## Tones

Seven, from the css package, and they work on everything:

`primary` · `secondary` · `muted` · `info` · `success` · `warning` · `danger`

```svelte +mesa
<Button tone="danger">Delete</Button>
<Badge tone="success">Paid</Badge>
<Card tone="warning">Card expiring</Card>
<Alert tone="info">Scheduled maintenance Sunday.</Alert>
```

Fill and text color are both derived from the tone's luminance, verified at
zero WCAG AA failures across all 42 tone × theme combinations — so there is
never a text color to pick.

`utils.js` exports `tone(name)`, which maps the older prop spellings onto the
seven: `error` → `danger`, `red` → `danger`, `green` → `success`, `gray` →
`muted`, and so on. An unrecognised name resolves to `''` (untoned) rather
than guessing, so a typo renders in the component's own default instead of
silently wrong. Every component still accepts its previous `color=` / `type=`
prop through that map.

## Treatments

Tones and treatments are different kinds of class in the css package, and they
compose freely — which is why `variant` on Button takes either:

```svelte
<Button variant="outlined" tone="danger">Delete</Button>   <!-- red outline -->
<Button variant="ghost">Cancel</Button>
<Button variant="link">Learn more</Button>
<Button tone="primary" loading>Saving</Button>
<Button square aria-label="Delete"><IconTrash /></Button>
```

The old six-value `variant` conflated the two, which is why `outline` and
`danger` used to be mutually exclusive. Both spellings still work.

## What's in the box

**forms** — `Form` `Button` `Field` `Fieldset` `Label` `Input` `Textarea`
`Select` `Checkbox` `Switch` `RadioGroup` `NumberInput` `Slider` `Combobox`
`MultiSelect` `DatePicker` `DateTimeInput` `JsonInput` `FileUpload`

**display** — `Badge` `Pill` `Tag` `Dot` `Kbd` `Mono` `Divider` `Breadcrumbs`
`Pagination` `Steps` `SectionHeader` `Callout` `EmptyState` `CopyButton`
`Avatar` `AvatarGroup` `Stat` `StatCard` `Table` `Bar` `Sparkline`
`AccountStatus` `Json` (read, or `editable`)

**layout** — `Card` `Accordion` `AccordionItem` `Tabs` `TabList` `Tab` `TabPanel`

**overlay** — `Modal` `Drawer` `Popover` `Tooltip` `DropdownMenu`
`DropdownItem` `DropdownLabel` `DropdownSeparator` `CommandPalette`
`ConfirmationPopover` `ConfirmPanel` `ConfirmProvider`

**feedback** — `Alert` `AlertProvider` `Toast` `Toaster` `Progress` `Spinner`
`Skeleton`

**stores** — `toastStore` `alertStore` `commandPaletteStore`

## A destructive action confirms itself

Mount `<ConfirmProvider />` once near the root, beside `<Toaster />`. After that
any element asks for a confirmation by writing an attribute — no wiring, no
component, and it works on an element this kit does not own:

```html
<button class="btn danger" data-confirm="Delete this order?"
        on:click={() => remove(order)}>Delete</button>

<a href="/leave/" data-confirm data-confirm-title="Leave the workspace?"
   data-confirm-label="Leave">Leave</a>
```

One listener, at the document, in capture phase — so the guarded handler does not
run while the question is open. Confirming re-fires the click, which covers a
delegated handler, a form submit and an anchor with one mechanism. Wording comes
off the element (`data-confirm-title`, `data-confirm-label`, `data-confirm-tone`);
a valueless `data-confirm` takes the provider's defaults, which is where an app
sets its own house wording once.

`ConfirmationPopover` is the same panel with a trigger of its own, for a
confirmation a component wants to own. Both render `ConfirmPanel`, so there is one
confirmation in this kit and not two (`FJS-D115`).

There is no `themeStore` here. A theme in `@frontierjs/css` is a class of
inheriting tokens, and applying it before first paint needs a script in
`<head>` that only the build can write — so the switch belongs to
`@frontierjs/sierra/theme`, and this package would only ever have been a second
answer to it.

## Forms know what they are editing

`<Form>` takes a resource and derives the rest. It owns the four things every
form needs beyond its inputs — whether it is in flight, whether anything
changed, what the server said about each field, and not submitting twice:

```svelte
<Form {leads} ondone={r => goto(`/leads/${r.id}`)}>
  <Input name="name" />
  <Input name="email" />
  <Button type="submit">Save</Button>
</Form>
```

Nothing there states what a Lead is. `createResource('leads')` read that from
`db/schema.lite`, so `email` arrives labeled, `required`, `type="email"`, with
its `@length` as `maxlength` — and if the write is rejected, the message lands
under that control without anyone routing it there. The form puts the rules and
the error map in context; each control resolves its own.

**A `DateTime` column gets `DateTimeInput`**, and it is the one control where
the value on screen is not the value on the wire. Litestone stores an instant;
`<input type="datetime-local">` has no zone at all, so the component converts
at each edge and names the zone it is showing you. Its callback is
`onvalue(iso)` rather than `oninput` — a handler reading `e.target.value` would
get the wall clock, which is the one thing that must never reach the column. A
`Date` column has no zone to lose and stays a plain `type="date"`.

```svelte
<DateTimeInput
  name="scheduledFor"
  value={record.scheduledFor}
  onvalue={(iso) => record.scheduledFor = iso}
/>
```

`bind:` is not used there on purpose: a component binding takes a writable
top-level `let` in the caller, so a field of a record is written back through
the callback.

**A `type="password"` field draws its own show/hide toggle.** A password box
with no way to read back what was typed is the commonest cause of a sign-in
that fails looking like a wrong credential, and the details are not obvious
enough to leave to each app: only the element's type flips, so the field is
still a password to `Field`, to `Label` and to `autocomplete`, and a mousedown
on the button refuses the default so a click mid-typing does not take the caret
with it. `reveal={false}` turns it off; nothing else has one.

```svelte
<Input name="password" label="Password" type="password"
       autocomplete="current-password" bind:value={password} />
```

**A stated prop always wins**, including a falsy one — `required={false}` beats
a schema that says required, because the resolution asks "was anything said",
not "is it truthy".

### Or write no controls at all

```svelte
<Form {leads} />                        <!-- every writable column, in schema order -->
<Form {leads} only={['name', 'email']} />
<Form {leads} except={['internalRef']} />
```

Each column gets the control its type implies: an enum is a select over its
members, a boolean is a checkbox, `@markdown` is a textarea, and a foreign key
is a **picker** whose rows come from the relation — no service name written
anywhere. Children win: passing any control means you are writing the form, and
`auto` turns generation back on with the generated fields first.

The field list is the last thing a form restates about a model, and a list typed
into a page drifts — a column added to `.lite` stops appearing, and nothing says
so. Which is also why a column the kit has no control for (an array, a `Json`
document) is **warned about by name** rather than quietly skipped.

The table that decides all of this lives in `@frontierjs/sierra`
(`field-rules.js`) and is reached through the resource, so a generated form and
a hand-written one cannot disagree about what a `Float` is.

### Contributing a control

The kit ships five, so the columns it cannot place — a `Json` document, a
`String[]`, money, a rating, a rich editor — are controls your app owns. Two
registrations, in one place, at startup:

```js
import { registerControl }     from '@frontierjs/sierra/junction'
import { registerFormControl } from '@frontierjs/ui/controls'
import Money from './Money.mesa'

// which columns get it — a name, a whole descriptor, or null to decline
registerControl('money', (rule, { field }) => (field.endsWith('Cents') ? 'money' : null))
// what that name renders as
registerFormControl('money', Money)
```

Two because the two halves live on opposite sides of a dependency rule: Sierra's
table has to run in plain Node — a test, a prerender and a snapshot all ask it
which control a column gets — and this kit peers only on mesa and css, so it
cannot import Sierra. A name is the only thing that crosses.

With no `props` builder your component is handed
`{ name, field, value, onvalue, options }`. Put `name` on the element that emits
input: that is what the form's dirty tracking and its blur-reveal watch.

A registered name **replaces** a built-in of the same name, so
`registerFormControl('select', MyCombobox)` swaps every generated select in the
app. The last registration is the first asked, which is why an app beats a kit
it imported. A `readOnly` column is never offered — `@system`, `@computed`,
`@generated` and `@from` are the schema saying the value is not the caller's to
write, so a control over one is a form that cannot submit.

**Standing alone, nothing changes.** Every control works outside a form exactly
as it did; an absent form resolves to `undefined` and each fallback is what the
component did before.

What `<Form>` deliberately does not do is validate. The resource does that
(coercing, blank-stripping and checking against the schema are on by default),
and this only renders what came back. Nor does it build the error map: that is
`resource.fieldErrors(err)`, one owner in sierra, because a failed write
arrives in three different shapes and two copies of that unwrapping would
drift.

Two escape hatches, both narrow. `onsubmit` replaces the request and nothing
else — the in-flight state, the error mapping and the dirty tracking still
apply. `mapErrors` replaces only the unwrapping. Neither turns the rest off.

| Bind | What it is |
| --- | --- |
| `errors` | `{ [field]: message }` — replaced, never mutated |
| `formError` | the failure no field could render |
| `submitting` `dirty` `submitted` | the state machine |
| `submit()` `reset()` `clearErrors()` | via `bind:this` |

## The platform does the work

Where the browser already has the behavior, these components use it instead
of reimplementing it. That is not a style preference — each one deleted a real
bug:

| Component | Built on | What that replaced |
| --- | --- | --- |
| `Modal`, `Drawer` | `<dialog>` + `showModal()` | a hand-rolled Tab focus trap that could not make the background inert |
| `Accordion` | `<details>` / `<summary>` | a button with `aria-expanded` and a grid-rows animation |
| `Progress`, `Bar` | `<progress>` | a div with `role="progressbar"` and three ARIA attributes to keep in sync |
| `Switch` | `<input type="checkbox">` | a `<button role="switch">` that no form ever submitted |
| `RadioGroup` | real radios + `:has(:checked)` | a selected-state class beside the checked state |
| `Fieldset` | `<fieldset disabled>` | `opacity` + `pointer-events: none`, which a keyboard user tabbed straight through |
| `Select` | the UA's own chevron | `appearance: none` plus a hand-drawn arrow |
| `FileUpload` | a real `<button>` dropzone | `role="button"` plus a keydown handler that also scrolled the page on Space |
| `Table` | a `<button>` in the `<th>` | `on:click` on the `<th>`, which no keyboard user could reach |
| `Tabs`, `Breadcrumbs` | `[aria-selected]`, `[aria-current]` | an `.active` class that could disagree with what was announced |

`Tooltip` moved the other way for the same reason: it is now anchored rather
than portaled, because the anchored form is what carries `aria-describedby`
and shows on focus. A portaled tooltip escapes `overflow: hidden`; it also
announces nothing. Reach for `Popover` when you genuinely need to break out of
a scroll container.

## Escape hatches

Every component takes `{class}`, and it **merges** with the component's own
classes rather than replacing them:

```svelte
<Button class="my-thing">Save</Button>
<!-- → <button class="btn primary my-thing"> -->
```

Your own stylesheet is unlayered, and unlayered CSS beats every cascade layer
in `@frontierjs/css`, so overriding needs no `!important` and no specificity
ladder.

**Every component also forwards the attributes it does not declare** — `id`,
`data-*`, `aria-*`, `title`, anything:

```svelte
<Mono id="token" data-test="api-token">fjs_8x92…</Mono>
<!-- → <code class="…" id="token" data-test="api-token"> -->
```

The caller wins: an attribute the component sets itself is replaced, not
duplicated, so `<Breadcrumbs aria-label="Sections">` overrides the default.

**Where it lands is not the same everywhere, and the difference is the point:**

| Tier | The attributes go on |
| --- | --- |
| display · layout · feedback · overlay | the outermost element — the same one `{class}` lands on |
| form controls | the **control** (`<input>`, `<select>`, `<textarea>`), not the `.field-group` wrapper |

A form control is addressed by a `<label for>` and pointed at by
`aria-describedby`, so an id or an aria attribute on the wrapper would name the
wrong element. Two departures, each stated in the file: `FileUpload` puts them
on the visible dropzone rather than the visually-hidden `<input type="file">`,
and `DatePicker` has no control of its own — its trigger is whatever you put in
the slot — so they go on the wrapper.

Where a component **declares** `id` it means something else and the attribute
never reaches the DOM as an id: `Toast` (the identity the store dismisses by),
`Tab`/`TabPanel`/`AccordionItem` (which name a pairing and render as
`id="tab-{id}"`), `Label`/`Field` (the id of the control being labeled) and
`Tooltip` (the generated tooltip id). Address those with a `data-*` attribute.
`test/attributes.mjs` holds the whole contract, exceptions included.

## Tests

```bash
bun run test     # inside this package
```

Four suites, and the split matters:

- **`test/compile-all.mjs`** — every `.mesa` compiles *and* the emitted
  JavaScript parses. Those are different claims: Mesa can report zero errors
  and still emit a module that throws on load.
- **`test/render.mjs`** — renders a component from each tier and asserts the
  css vocabulary reaches the DOM, and that no utility class has crept back in.
  This is the suite that would have caught the original problem, where most
  of the kit was styled with Tailwind/Uno classes that nothing in this
  repo generates — so every one of them rendered unstyled while compiling
  perfectly.
- **`test/attributes.mjs`** — every component forwards its caller's attributes,
  the caller's value replaces the component's own, and `id` lands wherever it
  is not a declared prop. Renders every one; the ones it cannot render are named
  with the reason rather than filtered out, so nothing goes quiet. Almost the
  whole kit dropped every undeclared attribute before it existed.
- **`test/form.mjs`** — `<Form>` and the form context. Asserts the claim that
  makes the component worth having: a control handed nothing but a `name` comes
  out labeled, constrained and carrying its server error. Covers the wiring,
  not the state machine — the machine's inputs are pinned in sierra's
  `resource-validation.test.js`, and the whole of it in `example/`'s
  `bun run verify`.
- **`test/browser/`** — the kit drive: a server that compiles each `.mesa` on
  request behind an import map, and Chrome over CDP. It needs Chrome on PATH or
  `$FJS_CHROME`, and it is where everything this kit adds over
  `@frontierjs/css` is actually asserted — a focus trap, a calendar changing
  month, a dropzone taking a file, ⌘K, a toast settling in place. Input goes
  through the browser's own pipeline, because a dispatched `KeyboardEvent` is
  not trusted and moves no focus. Covering a component costs a fixture and a
  spec; the run reports which components no spec has opened.

## Toasts

```js
import { toasts } from '@frontierjs/ui/stores/toastStore.js'

toasts.success('Saved')

const said = toasts.loading('Sending…')
try   { await send(); said.update('success', 'Sent') }
catch (e) { said.update('error', e.message) }
```

`loading()` answers `{ id, update(type, message, duration?), dismiss() }` and
settles the same toast in place, so one notification covers a whole action. A
loading toast carries a spinner and does not dismiss itself; settling it gives
it a lifetime. Settling one the reader already dismissed answers `false` and
does not put it back.

## Status

Alpha, zero production consumers. Compiled, rendered, and **driven in a real
browser** by `test/browser/` and by `example/`'s two drives — see
`PROJECT_STATE.md` for which components each has opened.
