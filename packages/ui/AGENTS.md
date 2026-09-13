# @frontierjs/ui — for agents

Compressed reference for building screens with this kit, written for a program
that must get one screen right without reading the rest. Changing the package
itself is the repository's `CLAUDE.md`.

**It does not teach the `.mesa` language** (`@frontierjs/mesa/AGENTS.md`),
routes and resources (`@frontierjs/sierra/AGENTS.md`), or the classes, tones
and treatments the kit draws with (`@frontierjs/css/AGENTS.md`), all under
`node_modules/`. **Nor does it list every prop**: there is no generated catalog,
and each component's `.mesa` file opens with a header and declares its props as
`export let`. When this file and a component disagree, the component is right.

---

## The one rule

**Hand the kit the resource and the declaration. Do not hand it a fact the
schema already holds.**

Inside `<Form>`, every control resolves its own label (`@label`, then the
humanized column name), `required`, `maxlength`, `min`/`max`, input `type`,
enum options, foreign-key rows and server error from `$context.form`. In a
table, `<Cell>` renders a value from the column's declaration — money, enum
labels, instants. A label or an option list typed into a page is a second
answer that drifts.

```mesa
<script>
  import Form   from '@frontierjs/ui/components/forms/Form.mesa'
  import Button from '@frontierjs/ui/components/forms/Button.mesa'
  import { goto } from '@frontierjs/sierra/router'
  import { leads } from '@/resources/Lead.mesa'
</script>

<!-- Every writable column, in schema order, each with the control its type implies -->
<Form resource={leads} except={['internalRef']} ondone={(row) => goto(`/leads/${row.id}/`)}>
  <Button slot="actions" type="submit">Save</Button>
</Form>
```

**A stated prop always wins, including a falsy one** — `required={false}` beats
a schema that says required, and `label=""` suppresses the label. Only
`undefined` means *not stated*.

---

## Choosing a component

Import each by the full path in its row, group folder and `.mesa` included;
the package has no root entry.

**Forms**

| Need | Component |
|---|---|
| a whole model's form, created or edited | `@frontierjs/ui/components/forms/Form.mesa` with no default children — or the Resource file's own `<Order />` |
| text, email, url, number, password | `@frontierjs/ui/components/forms/Input.mesa` |
| long text | `@frontierjs/ui/components/forms/Textarea.mesa` |
| an enum, or a short list, as a native select | `@frontierjs/ui/components/forms/Select.mesa` |
| one value from a long or searchable list, a foreign key | `@frontierjs/ui/components/forms/Combobox.mesa` |
| several values, tokens | `@frontierjs/ui/components/forms/MultiSelect.mesa` |
| a boolean in a form · a setting | `@frontierjs/ui/components/forms/Checkbox.mesa` · `@frontierjs/ui/components/forms/Switch.mesa` |
| one of a few options with descriptions | `@frontierjs/ui/components/forms/RadioGroup.mesa` |
| a `DateTime` column (an instant) | `@frontierjs/ui/components/forms/DateTimeInput.mesa` |
| a calendar, a date range, presets | `@frontierjs/ui/components/forms/DatePicker.mesa` |
| a stepper with its own formatting · a range | `@frontierjs/ui/components/forms/NumberInput.mesa` · `@frontierjs/ui/components/forms/Slider.mesa` |
| a `Json` column | `@frontierjs/ui/components/forms/JsonInput.mesa` |
| a `File` column · a free-standing dropzone | `@frontierjs/ui/components/forms/FileField.mesa` · `@frontierjs/ui/components/forms/FileUpload.mesa` |
| a label, hint and error around a control of your own | `@frontierjs/ui/components/forms/Field.mesa`, or `@frontierjs/ui/components/forms/Label.mesa` alone |
| a group that disables as one | `@frontierjs/ui/components/forms/Fieldset.mesa` |
| any button or button-styled link | `@frontierjs/ui/components/forms/Button.mesa` |

**Display**

| Need | Component |
|---|---|
| a list of rows, sortable | `@frontierjs/ui/components/display/Table.mesa`, each value through `@frontierjs/ui/components/display/Cell.mesa` |
| filters over a list's query | `@frontierjs/ui/components/display/FilterBar.mesa` |
| page numbers | `@frontierjs/ui/components/display/Pagination.mesa` |
| a count, or a badge floated over an icon · a status or plan label · a removable token · a status dot | `@frontierjs/ui/components/display/Badge.mesa` · `@frontierjs/ui/components/display/Pill.mesa` · `@frontierjs/ui/components/display/Tag.mesa` · `@frontierjs/ui/components/display/Dot.mesa` |
| a figure · a figure as a tile or link | `@frontierjs/ui/components/display/Stat.mesa` · `@frontierjs/ui/components/display/StatCard.mesa` |
| a meter · a trend line | `@frontierjs/ui/components/display/Bar.mesa` · `@frontierjs/ui/components/display/Sparkline.mesa` |
| nothing to show yet | `@frontierjs/ui/components/display/EmptyState.mesa` |
| a page or section heading with a trailing action | `@frontierjs/ui/components/display/SectionHeader.mesa` |
| guidance that sits on the page and is not announced | `@frontierjs/ui/components/display/Callout.mesa` |
| wayfinding · a multi-step flow | `@frontierjs/ui/components/display/Breadcrumbs.mesa` · `@frontierjs/ui/components/display/Steps.mesa` |
| a person · a stack of people · an account's state | `@frontierjs/ui/components/display/Avatar.mesa` · `@frontierjs/ui/components/display/AvatarGroup.mesa` · `@frontierjs/ui/components/display/AccountStatus.mesa` |
| a JSON document, read, diffed or `editable` | `@frontierjs/ui/components/display/Json.mesa` |
| copy to clipboard · a shortcut · a token or id · a rule | `@frontierjs/ui/components/display/CopyButton.mesa` · `@frontierjs/ui/components/display/Kbd.mesa` · `@frontierjs/ui/components/display/Mono.mesa` · `@frontierjs/ui/components/display/Divider.mesa` |

**Layout, overlay, feedback**

| Need | Component |
|---|---|
| a surface with header and footer | `@frontierjs/ui/components/layout/Card.mesa` |
| tabs | `@frontierjs/ui/components/layout/Tabs.mesa` around `@frontierjs/ui/components/layout/TabList.mesa`, `@frontierjs/ui/components/layout/Tab.mesa`, `@frontierjs/ui/components/layout/TabPanel.mesa` |
| disclosure sections | `@frontierjs/ui/components/layout/Accordion.mesa` around `@frontierjs/ui/components/layout/AccordionItem.mesa` |
| a blocking dialog · a side panel | `@frontierjs/ui/components/overlay/Modal.mesa` · `@frontierjs/ui/components/overlay/Drawer.mesa` |
| a menu of actions | `@frontierjs/ui/components/overlay/DropdownMenu.mesa` with `@frontierjs/ui/components/overlay/DropdownItem.mesa`, `@frontierjs/ui/components/overlay/DropdownLabel.mesa`, `@frontierjs/ui/components/overlay/DropdownSeparator.mesa` |
| content that must escape a scroll container · a description on hover and focus | `@frontierjs/ui/components/overlay/Popover.mesa` · `@frontierjs/ui/components/overlay/Tooltip.mesa` |
| confirm a destructive click | `@frontierjs/ui/components/overlay/ConfirmProvider.mesa` once, then `data-confirm` on any element; `@frontierjs/ui/components/overlay/ConfirmationPopover.mesa` when a component owns its trigger |
| ⌘K | `@frontierjs/ui/components/overlay/CommandPalette.mesa` with `@frontierjs/ui/stores/commandPaletteStore.js` |
| a transient message · a banner for the whole app | `@frontierjs/ui/components/feedback/Toaster.mesa` with `@frontierjs/ui/stores/toastStore.js` · `@frontierjs/ui/components/feedback/AlertProvider.mesa` with `@frontierjs/ui/stores/alertStore.js` |
| a message in the page flow, announced as it appears (`role="alert"`) | `@frontierjs/ui/components/feedback/Alert.mesa` |
| work in flight | `@frontierjs/ui/components/feedback/Spinner.mesa` · `@frontierjs/ui/components/feedback/Skeleton.mesa` · `@frontierjs/ui/components/feedback/Progress.mesa` |

`Toaster`, `AlertProvider` and `ConfirmProvider` are mounted **once**, in the
root layout. `CommandPalette` renders under `{#if commandPalette.open}`, which
needs a `$: commandPalette.open` line to update.

---

## Forms

**`<Form resource={r}>` owns the write**: in-flight state, dirty tracking,
server errors per field, no double submit, and `create` or `patch` from the
model's id field. `ondone(result, record)` and `onerror(err)` report;
`onsubmit(record)` replaces only the request. `errors`, `dirty` and `submitting`
bind, and `bind:this` gives `submit()`, `reset()` and `flushAutosave()`.

**Generation is on when the form has no default children.** `only` narrows and
orders, `except` removes, `auto` forces either way. Buttons go in
`slot="actions"` or an `actions` snippet, which keeps generation on. A column
with no control — `@money`, until the app contributes one — is left off with a
console warning naming it.

**A hand-written form writes the record itself.** Each control resolves its
label, rules and error from the form; its callback carries the value back:

```mesa
<script>
  import Form   from '@frontierjs/ui/components/forms/Form.mesa'
  import Input  from '@frontierjs/ui/components/forms/Input.mesa'
  import Select from '@frontierjs/ui/components/forms/Select.mesa'
  import Button from '@frontierjs/ui/components/forms/Button.mesa'
  import { leads } from '@/resources/Lead.mesa'

  let draft = leads.make()
  const write = (name, value) => { draft = { ...draft, [name]: value } }
</script>

<Form resource={leads} bind:record={draft}>
  <Input  name="email"  value={draft.email}  oninput={(e) => write('email', e.target.value)} />
  <Select name="status" value={draft.status} oninput={(e) => write('status', e.target.value)} />
  <Button type="submit">Save</Button>
</Form>
```

The callbacks disagree:

| Component | Callback | Receives |
|---|---|---|
| `Input` · `Textarea` · `Select` | `oninput` (`onchange` on commit) | the DOM **event** |
| `Checkbox` · `Switch` | `onchange` | `checked` |
| `RadioGroup` · `Combobox` · `MultiSelect` | `onchange` | the value (an array for `multiple`) |
| `NumberInput` · `Slider` | `onchange` | `{ value }`, or `{ start, end }` for a range |
| `DateTimeInput` · `JsonInput` · `FileField` | `onvalue` | an ISO instant · a parsed document · a `File`, `null` to clear, `undefined` to keep |
| `FileUpload` | `onchange` | `File[]` |

**`autosave` saves once the typing stops** — `true` for 800 ms, or a number of
milliseconds. It is not a submit: it reveals no untouched field, fires
`onautosaved(result, record)` and never `ondone`, does not retry a refusal, and
the submit button disarms it. It only patches, so a record with no id gets a
warning. `bind:autosaveState` reads `idle`, `pending`, `saving`, `saved` or
`error`; call `flushAutosave()` when the screen is dismissed.

**A contributed control is two registrations**, made once at startup: sierra's
answers *which columns get it*, the kit's *what it renders as*.

```js
import { registerControl }     from '@frontierjs/sierra/junction'
import { registerFormControl } from '@frontierjs/ui/controls'
import Money from './Money.mesa'

registerControl('money', (rule) => (rule?.['x-money'] ? 'money' : null))
registerFormControl('money', Money)
```

The component is handed `{ name, field, value, onvalue, options }`; a third
argument `{ props: (ctx) => ({ … }) }` adapts an existing component instead.
**Put `name` on the element that emits input**, or dirty tracking cannot see it,
and wrap it in `<Field name={name}>` for the label and error. A registered name
replaces the kit's own. `registerDisplayComponent` and `registerFilterComponent`
do the same for `<Cell>` and `<FilterBar>` — see `node_modules/@frontierjs/ui/controls.js`.

## Tables

```mesa
<script>
  import Table from '@frontierjs/ui/components/display/Table.mesa'
  import Cell  from '@frontierjs/ui/components/display/Cell.mesa'
  import { orders } from '@/resources/Order.mesa'

  const { columns } = orders.columns()
  const list = orders.list()
</script>

<Table {columns} rows={list.rows} orderBy={list.directives.orderBy} onsort={list.sort}
       loading={list.loading && !list.rows.length} emptyText="No orders yet.">
  {#snippet row(order)}
    <tr>
      {#each columns as c (c.name)}<td><Cell value={order[c.name]} column={c} record={order} /></td>{/each}
    </tr>
  {/snippet}
</Table>
```

A column is `{ name, label, sortable?, align?, width?, hideLabel? }`. `orderBy`
is the `$orderBy` directive; `onsort(next)` reports a sort, `bind:orderBy` owns it.

## Attributes, `class` and snippets

**Every component forwards the attributes it does not declare**, and the
caller's value replaces the component's own. Where they land is not uniform:

| Component | Attributes land on |
|---|---|
| display · layout · feedback · `Modal` · `Drawer` | the outermost element |
| `Popover` · `DropdownMenu` · `ConfirmationPopover` | the wrapper around the TRIGGER, never the panel |
| every form control | the `<input>`, `<select>` or `<textarea>`, so `<label for>` and `aria-describedby` reach it |
| `FileUpload` · `DatePicker` · `Slider` | the visible dropzone · the wrapper · the wrapper |

**`class` merges with the component's own classes**; on a form control it lands
on the wrapper while other attributes reach the control. Where a component
declares `id` it names something else — a `Toast`'s identity, a `Tab` and
`TabPanel` pairing, an `AccordionItem`, the control a `Label` or `Field` points
at, a `Tooltip`'s own element — so address those with `data-*`.

**Trailing content has three names**: `actions` on `Form` and `Table`, `action`
on `SectionHeader` and `EmptyState`, `footer` on `Modal`, `Drawer` and `Card`.

---

## Wrong guesses

What a habit from shadcn, MUI, Headless UI, Bootstrap or a Svelte component
library produces, and what this kit wants.

| You will write | The kit wants |
|---|---|
| `<Button variant="destructive">`, `color="red"`, `size="icon"` | `tone="danger"` (with `variant="outlined"` for an outline), `square` plus an `aria-label` |
| `<Button on:click={save}>`, `onClick` | `onclick={save}` |
| `<Button>Save</Button>` as a form's submit | `<Button type="submit">` — the kit's default `type` is `button` |
| `<Dialog open onOpenChange>` | `<Modal bind:open title="…" onclose={…}>` |
| `<DataTable data={rows} columns={[{ accessorKey, cell }]} />` | `<Table {columns} {rows}>` with a `row` snippet |
| `{ key: 'total', label: 'Total' }` in `columns` | `{ name: 'total', label: 'Total' }` |
| `${(order.total / 100).toFixed(2)}` | `<Cell value={order.total} column={c} />` |
| `<FormControl><FormLabel/>`, react-hook-form, zod | `<Input name="email" />` inside `<Form resource={…}>` — rules and validation are the resource's |
| `<Input bind:value={record.email} />` | `value={draft.email} oninput={…}`; `bind:` takes a top-level `let` |
| `toast.success()` from a provider hook | `toasts.success()` from `@frontierjs/ui/stores/toastStore.js`, `<Toaster />` once |
| `<Tabs value onValueChange>` with `TabsTrigger`/`TabsContent` | `<Tabs bind:activeId>` with `Tab id` and `TabPanel id` |
| `onDelete={() => confirm('Sure?') && remove()}` | `data-confirm="Delete this order?"` under a mounted `ConfirmProvider` |
| importing the kit's `tokens.css` | nothing — tokens are `@frontierjs/css`'s, and no component reads that file |

---

## Silent failures

Everything above is loud somewhere. These are not.

- **Any default child turns generation off.** A `<p>` of help text inside
  `<Form>` means you are writing the form, and every generated field vanishes.
  The console warns only when the form ends up holding no control at all.
- **A control that does not write the record submits the seed.** The box shows
  what was typed; the record still holds the blank `make()` gave it.
- **`<Table>` with no `row` snippet renders its header over an empty body.** It
  does not fall back to `<Cell>`.
- **A callback name from another component is never called.** `onvalue` on
  `Input` is the common one: nothing refuses the prop and nothing writes.
- **`class` on a bare `Input` is dropped.** With no `label` and no `name` there
  is no wrapper for it, and the `<input>` does not take it.
- **`<Modal open={x}>` without `bind:` cannot reopen after Escape.** The dialog
  closes itself, `x` stays `true`, and setting it `true` again changes nothing.
  Write `bind:open`. `onclose` fires for a dismissal by the person, not for your
  own `open = false`.
- **`export var` props are read once at mount** — `Drawer`'s `side`, `Table`'s
  `skeletonRows`, `CommandPalette`'s `maxHeight`, `maxWidth` and
  `closeOnSelect`, every control's `id`.

---

## Accessibility the caller still owns

The kit owns focus trapping, roving tabindex, `aria-activedescendant`,
`aria-sort` and announcing field errors. It cannot know these:

1. An icon-only `<Button square>` carries an `aria-label`.
2. A `Modal` or `Drawer` has a `title`; without one the dialog is unnamed.
3. A `Table` column of row actions declares `hideLabel: true`, not `label: ''`.
4. `Dot`, `Sparkline`, `Progress`, a `Popover` panel and a `TabList` take a
   `label`; an `Avatar` that is the only identification is `standalone`.
5. A `Tooltip`'s trigger carries `aria-describedby` — pass `id`, or take `tipId`
   from a `children` snippet — and nothing essential lives only in a tooltip.
6. A control outside `<Form>` with no `label` and no `name` gets an
   `aria-label`; a placeholder is not a name.

## Checklist before emitting a screen

1. No label, required flag, enum list or money arithmetic is written in the page.
2. A generated `<Form>` has no default children; its submit is `type="submit"`
   in `slot="actions"` or an `actions` snippet.
3. Every control in a hand-written form writes the record through its callback.
4. Every `<Table>` has a `row` snippet, columns keyed `name`, values in `<Cell>`.
5. Providers are mounted once in the root layout; `Modal` and `Drawer` bind `open`.
6. The accessibility obligations above are met.

---

## What grades it

**`fli check` is the executable half of this document.** `table-column-key`
fails a `<Table>` column spelled `key`, `money-rendered-raw` warns on a `@money`
column interpolated bare, and `css-token-undefined` fails a `var(--token)` no
installed stylesheet defines.

**The console is the other half.** `[Form]` names a column a generated form left
off, a refused autosave or a form with no fields; `[FormField]` a control nobody
bound; `[@frontierjs/ui]` a native constraint in a `<form>` without `novalidate`.
`fli make:scaffold` and `fli admin:generate` write pages on this kit — read one
before writing a screen by hand.
