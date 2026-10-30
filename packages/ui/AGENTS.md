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

```mesa fragment
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
a schema that says required, and `label=""` suppresses the label. `undefined`
and `null` both mean *not stated*, so a nullable column handed straight to a
prop falls back to the schema; `''`, `false` and `0` are answers.

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
| one row from a list, or the typed words as a thing of their own — a line picker's custom line | the same, with `allowNew`: Enter takes the first match and the words are the last row, reached with ↓ or a click. `oncreate(text)` fires before `onchange` for the words, `newLabel(text)` words that row, and `onquery(words)` hands out the box on every change. Rows a server finds on text the label does not show (full-text) come through `search={(words, signal) => …}`, drawn as answered |
| several values, tokens | `@frontierjs/ui/components/forms/MultiSelect.mesa` |
| a boolean in a form · a setting | `@frontierjs/ui/components/forms/Checkbox.mesa` · `@frontierjs/ui/components/forms/Switch.mesa` |
| one of a few options with descriptions | `@frontierjs/ui/components/forms/RadioGroup.mesa` |
| a `DateTime` column (an instant) | `@frontierjs/ui/components/forms/DateTimeInput.mesa` |
| a `@money` column | `@frontierjs/ui/components/forms/MoneyInput.mesa` — the box is in major units and hands back minor ones; `currency` feeds a `@money(field: …)` column its row's code |
| a calendar, a date range, presets | `@frontierjs/ui/components/forms/DatePicker.mesa` |
| a day a screen walks one at a time | the same, with `showStepper` — a prev/next pair beside the trigger. It steps only onto days the calendar would let you click, so the buttons go dead at the edge of `disabledDates` / `enabledDates` and at the past and future bounds |
| a stepper with its own formatting · a range | `@frontierjs/ui/components/forms/NumberInput.mesa` · `@frontierjs/ui/components/forms/Slider.mesa` |
| the cut points of a banded scale — a heat ramp, alert levels, price tiers — tuned against the distribution they cut | `@frontierjs/ui/components/forms/Thresholds.mesa`. The band of a value is `bandIndex()` from `@frontierjs/ui/utils`, which is what the plot colors itself by, so the picture and whatever it is tuning cannot disagree |
| a `Json` column | `@frontierjs/ui/components/forms/JsonInput.mesa` |
| a `String[]` or `Int[]` column, a list a person types item by item | `@frontierjs/ui/components/forms/MultiSelect.mesa` with `allowNew` and no options — what a generated form draws; Enter adds the typed item |
| source text edited in its own syntax — a template, a query, a snippet | `@frontierjs/ui/components/forms/CodeInput.mesa` — `language` is glow's, `numbered` draws a gutter. It is a real `<textarea>` over a highlighted `<pre>`, so style the box through `@frontierjs/css`'s `--code-*` variables and never by restating the text metrics on one layer |
| a `File` column · a free-standing dropzone | `@frontierjs/ui/components/forms/FileField.mesa` · `@frontierjs/ui/components/forms/FileUpload.mesa` |
| a list reordered by dragging, or items dragged between lists — a board, a queue | `dndzone` from `@frontierjs/ui/dnd`, an attachment rather than a component: `<ul {@attach dndzone(() => ({ items, type, onconsider, onfinalize }))}>`. Pass a GETTER — an object literal rebuilds the zone on every write and ends the drag. Every element child of the zone is one item in `items` order, so an empty-state row goes outside it. Persist from `onfinalize` only |
| a drawn signature — a client accepting a quote with a finger, a pen or the mouse; shown back read-only | `@frontierjs/ui/components/forms/SignaturePad.mesa` (`bind:value`, `{ paths, width, height }` or `null`, each stroke an SVG path in the pad's own pixels) · `@frontierjs/ui/components/display/SignatureView.mesa` draws that value back as an SVG. A Json column holds it as it is. The typed name is the page's field beside it, and is what a person who cannot use a pointer signs with |
| a handle, a splitter, a crop box, a pan — anything that follows the pointer from press to release | `drag` from `@frontierjs/ui/drag`: `<div {@attach drag(() => ({ start, move, end }))}>`. `move(e, from, { x, y })` gets the distance from the press, and `end(e, from, { cancelled })` fires on a release AND on a `pointercancel`, which a hand-written drag misses, so a touch scroll leaves it stuck mid-drag. A getter, as `dndzone` takes |
| a file the person saves — a CSV built on the page, an export from a raw route | `download(blob, filename)` from `@frontierjs/ui/utils`. An authenticated export is `await download(await client.fetch(path), fallbackName)`: a Response is saved under the name its `Content-Disposition` gives, `filename*` included, and the bearer rides `client.fetch`, never a hand-built `Authorization` header |
| a file the person reads in a new tab — a PDF to print | `openFile(() => client.fetch(path), { name, save })` from `@frontierjs/ui/utils`. It takes a function because the tab must open inside the click, before any `await`, or the browser blocks the popup; a blocked one saves the file under `name` instead |
| a label, hint and error around a control of your own | `@frontierjs/ui/components/forms/Field.mesa`, or `@frontierjs/ui/components/forms/Label.mesa` alone |
| a group that disables as one | `@frontierjs/ui/components/forms/Fieldset.mesa` |
| any button or button-styled link | `@frontierjs/ui/components/forms/Button.mesa` |

**Display**

| Need | Component |
|---|---|
| a list of rows, sortable | `@frontierjs/ui/components/display/Table.mesa`, each value through `@frontierjs/ui/components/display/Cell.mesa` |
| filters over a list's query | `@frontierjs/ui/components/display/FilterBar.mesa` |
| a list of rows worked from the keyboard — ↑/↓ or j/k, Enter to open, a key to select, one tab stop | `rowlist` from `@frontierjs/ui/rowlist`, an `{@attach}` on the list — § Keys over a list of rows |
| rows a person ticks to act on together — bulk delete, resend, complete | `createSelection` from `@frontierjs/ui/selection`, a header box through `@frontierjs/ui/components/forms/Checkbox.mesa`'s `indeterminate`, and `@frontierjs/ui/components/display/BulkBar.mesa` for the count and the actions — § Selecting rows |
| page numbers | `@frontierjs/ui/components/display/Pagination.mesa` |
| a count, or a badge floated over an icon · a status or plan label · a removable token · a status dot | `@frontierjs/ui/components/display/Badge.mesa` · `@frontierjs/ui/components/display/Pill.mesa` · `@frontierjs/ui/components/display/Tag.mesa` · `@frontierjs/ui/components/display/Dot.mesa` |
| a figure · a figure as a tile or link | `@frontierjs/ui/components/display/Stat.mesa` · `@frontierjs/ui/components/display/StatCard.mesa` |
| a meter · a trend line | `@frontierjs/ui/components/display/Bar.mesa` · `@frontierjs/ui/components/display/Sparkline.mesa` |
| one measure over categories, as columns, ranked bars or a line, with axes and a hover readout | `@frontierjs/ui/components/display/Chart.mesa` — `rows`, `x`, `y`, `type`, `label`, `format`, `formatTick`. `orientation="horizontal"` puts the names in a left gutter and every value at its bar's tip, for a ranked list with long names. `compare` names a second field holding the SAME measure — last year, the plan — drawn beside it, lighter, with a legend from `label` and `compareLabel`. `reference` is a dashed rule at one value, named by `referenceLabel` — a target, a reorder level. Pure SVG that renders on the server too, so it prints. One measure and one axis: a second measure is a second chart. Put the same values in a table beside it, since a tooltip may never be the only way to read one |
| nothing to show yet | `@frontierjs/ui/components/display/EmptyState.mesa` |
| a page or section heading with a trailing action | `@frontierjs/ui/components/display/SectionHeader.mesa` |
| guidance that sits on the page and is not announced | `@frontierjs/ui/components/display/Callout.mesa` |
| wayfinding · a multi-step flow | `@frontierjs/ui/components/display/Breadcrumbs.mesa` · `@frontierjs/ui/components/display/Steps.mesa` |
| a person · a stack of people · an account's state | `@frontierjs/ui/components/display/Avatar.mesa` · `@frontierjs/ui/components/display/AvatarGroup.mesa` · `@frontierjs/ui/components/display/AccountStatus.mesa` |
| a JSON document, read, diffed or `editable` | `@frontierjs/ui/components/display/Json.mesa` |
| a command or snippet somebody pastes — a block with a copy button in its corner | `@frontierjs/ui/components/display/Code.mesa` |
| Markdown somebody else wrote — a model's reply, a `@syntax(md)` column — read | `@frontierjs/ui/components/display/Markdown.mesa` — `text`, `headingBase` (the level a `#` draws at; 3 inside a card), `breaks`. Raw HTML in the text draws as text and a link goes only to http, https, mailto or this site, so it is safe on a public page with no sanitizer |
| HTML somebody else wrote — an email body, a template, filled with a sample record — previewed | `@frontierjs/ui/components/display/HtmlFrame.mesa` — `html`, `title` (the frame's accessible name), `height` (any CSS length; the document scrolls inside a fixed box). An `<iframe sandbox="">` with no token: no script, an opaque origin, no popup or form. A shadow root is not isolation and `srcdoc` is refused in a spread, so write this rather than your own frame |
| A stored template previewed as its channel — an email's subject, HTML body and text part; an sms's text with its segment count; a page fragment — over example data | `@frontierjs/ui/components/display/TemplatePreview.mesa` — `channel` (`email` · `sms` · `page`), `body`, `subject`/`text` (email), `fields` (a toolbelt `mergeFields` catalog: its `example()` is the data), `data` (a record over the examples), `height`. The body is HTML and `text`/sms are text, stated by the channel, so a value is escaped into the first only; the HTML is drawn by `HtmlFrame` |
| a chat screen — the log, a bubble, the box typed into | `@frontierjs/ui/components/display/Transcript.mesa` (a scrolling `role="log"` that follows the newest message until the reader scrolls up; give it a height; `scrollToEnd()` after the reader's own send) · `@frontierjs/ui/components/display/Message.mesa` (`side` `mine`/`theirs`, `tone`; a `<Markdown>` inside for a model's reply) · `@frontierjs/ui/components/display/ToolCalls.mesa` (`calls` `[{name, status, input, output}]`, status `running`/`done`/`failed`; one `<details>` per call, none folded by count; inside a `Message` above the reply) · `@frontierjs/ui/components/display/Composer.mesa` (`onsend(text)`, `bind:value`, `disabled`, `label`; Enter sends, Shift+Enter breaks) |
| one theme shown in itself · a picker over the app's themes | `@frontierjs/ui/components/display/ThemeSwatch.mesa` (`name`, a `theme-*` class; label and blurb from `@frontierjs/css/themes.js`) · `@frontierjs/ui/components/display/ThemePicker.mesa` — `themes={themes()} value={theme.preference} onchange={setTheme}` from `@frontierjs/sierra/theme`; never `bind:value`, which writes `theme` without notifying it. `'system'` checks no card |
| copy to clipboard · a shortcut · a token or id · a rule | `@frontierjs/ui/components/display/CopyButton.mesa` · `@frontierjs/ui/components/display/Kbd.mesa` · `@frontierjs/ui/components/display/Mono.mesa` · `@frontierjs/ui/components/display/Divider.mesa` |

**Layout, overlay, feedback**

| Need | Component |
|---|---|
| a surface with header and footer | `@frontierjs/ui/components/layout/Card.mesa` |
| the app frame: the nav, a drawer below md, the section's tabs | `@frontierjs/ui/components/layout/Shell.mesa` in the `_module.mesa`, drawn from a `src/lib/nav.js` table that `@frontierjs/ui/nav` types. `layout` is `sidebar`, `rail` or `topbar`; a topbar draws an unlabeled group flat and a labeled one as one menu named by its label, and gives the drawer the nav below md. `collapsible` adds a fold control to a `sidebar` and `bind:collapsed` is the choice (the app persists it); folded is a plain rail that does not peek. `foldable` draws each labeled group of a sidebar and of the drawer as a `<details>` its label opens: the first labeled group starts open and the rest closed, and the group holding the current page opens on arrival; the choice is not persisted. The page, the session and Sierra's `isActive` arrive as props, because the kit cannot import Sierra. A `show` predicate is handed `{ user, level }` and nothing else, and one that throws SHOWS its entry. Signed out, the frame is drawn when the table offers a guest any entry, so a members-only table marks its groups `show: ({ user }) => !!user` or its sign-in page draws the members' nav. ⌘K's Navigate rows are `paletteItems(groups, session, go)` from the same module, so the palette and the nav cannot disagree |
| tabs | `@frontierjs/ui/components/layout/Tabs.mesa` around `@frontierjs/ui/components/layout/TabList.mesa`, `@frontierjs/ui/components/layout/Tab.mesa`, `@frontierjs/ui/components/layout/TabPanel.mesa` |
| disclosure sections | `@frontierjs/ui/components/layout/Accordion.mesa` around `@frontierjs/ui/components/layout/AccordionItem.mesa` |
| a blocking dialog · a side panel | `@frontierjs/ui/components/overlay/Modal.mesa` · `@frontierjs/ui/components/overlay/Drawer.mesa` — `resizable` puts a handle on a left or right drawer's inner edge, `bind:width` (px) and `minWidth`; it stores nothing, so remember the width in one line over `bind:width` (`FJS-D1654`) |
| a floating panel the page stays live under (a chat, a notes box, an edge dock) | `@frontierjs/ui/components/overlay/Window.mesa` — `bind:open`, `bind:box` (`{ x, y, w, h }`, null while at its `anchor` corner), `dock`, an `action` snippet in the title bar, a `launcher` snippet for the corner button; it stores nothing, so remember the box in one line: `onchange={(b) => localStorage.box = JSON.stringify(b)}` (`FJS-D1661`) |
| a menu of actions | `@frontierjs/ui/components/overlay/DropdownMenu.mesa` with `@frontierjs/ui/components/overlay/DropdownItem.mesa`, `@frontierjs/ui/components/overlay/DropdownGroup.mesa`, `@frontierjs/ui/components/overlay/DropdownSeparator.mesa` |
| content that must escape a scroll container · a description on hover and focus | `@frontierjs/ui/components/overlay/Popover.mesa` · `@frontierjs/ui/components/overlay/Tooltip.mesa` |
| a card on hover and focus for MANY triggers in one region (every element matching `selector`), one card and two listeners | `@frontierjs/ui/components/overlay/HoverCard.mesa` — the region is `children`, `content(el)` is handed the trigger; a trigger needs `tabindex="0"` for the keyboard, and a touch pointer never opens it |
| confirm a destructive click | `@frontierjs/ui/components/overlay/ConfirmProvider.mesa` once, then `data-confirm` on any element — the provider's document listener is what reads the attribute, so with none mounted the click runs unconfirmed; `@frontierjs/ui/components/overlay/ConfirmationPopover.mesa` when a component owns its trigger or cannot be sure a provider is mounted |
| ⌘K | `@frontierjs/ui/components/overlay/CommandPalette.mesa` with `@frontierjs/ui/stores/commandPaletteStore` |
| a transient message · a banner for the whole app | `@frontierjs/ui/components/feedback/Toaster.mesa` with `@frontierjs/ui/stores/toastStore` · `@frontierjs/ui/components/feedback/AlertProvider.mesa` with `@frontierjs/ui/stores/alertStore` |
| a message in the page flow, announced as it appears (`role="alert"`) | `@frontierjs/ui/components/feedback/Alert.mesa` |
| work in flight | `@frontierjs/ui/components/feedback/Spinner.mesa` · `@frontierjs/ui/components/feedback/Skeleton.mesa` · `@frontierjs/ui/components/feedback/Progress.mesa` |

`Toaster`, `AlertProvider` and `ConfirmProvider` are mounted **once**, in the
root layout. `CommandPalette` renders under `{#if commandPalette.open}`, which
needs a `$: commandPalette.open` line to update. It matches each typed word on
its own, against `label`, `sub` and `group`. A palette that holds rows as well
as commands — bookmarks, customers — passes `searchGroups={false}`, or every
row matches its group's heading, and `minimumScore` (0–1) to drop rows that
match only thinly. A server search is `search={(query, signal) => Promise<Item[]>}`:
the palette waits for a pause in typing, aborts a search the words moved past,
and draws the answer as given, ahead of the ranked `items` — never `onquery`
replacing `items`, which ranks the server's hits again and drops any it made on
text the row does not show.

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
with no control — a `@scale` column, until the app contributes one — is left
off with a console warning naming it.

**A hand-written form writes the record itself.** Each control resolves its
label, rules and error from the form; its callback carries the value back:

```mesa fragment
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

The callbacks fall in two shapes, sorted by what the control is: a control that
IS a native element (`Input`, `Textarea`, `Select`, `CodeInput`) hands the DOM
event, so `e.target.files` and `e.target.form` stay reachable; every composite
hands its value, so `(v) => …` works on all of them. A handler written for one
shape throws on the other (`e.target` is undefined on a bare boolean).

| Component | Callback | Receives |
|---|---|---|
| `Input` · `Textarea` · `CodeInput` · `Select` | `oninput` (`onchange` on commit) | the DOM **event** |
| `Checkbox` · `Switch` | `onchange` | `checked` |
| `RadioGroup` · `Combobox` · `MultiSelect` | `onchange` | the value (an array for `multiple`) |
| `ThemePicker` | `onchange` | the `theme-*` class |
| `NumberInput` · `Slider` | `oninput` (`onchange` at the end of the gesture — release, key, Enter, blur) | the number (`null` for an emptied NumberInput), or `[start, end]` for a range |
| `Thresholds` | `onchange` | the cuts, ascending — an array, also written back through `bind:values` |
| `SignaturePad` | `onchange` | `{ paths, width, height }` once per stroke, `null` after Clear — also written back through `bind:value` |
| `DateTimeInput` · `JsonInput` · `FileField` | `onvalue` | an ISO instant · a parsed document · a `File`, `null` to clear, `undefined` to keep |
| `MoneyInput` | `onvalue` | minor units, `null` for a blank box — nothing while the text is not an amount |
| `FileUpload` | `onchange` | `File[]` |

**`autosave` saves once the typing stops** — `true` for 800 ms, or a number of
milliseconds. It is not a submit: it reveals no untouched field, fires
`onautosaved(result, record)` and never `ondone`, does not retry a refusal, and
the submit button disarms it. It only patches, so a record with no id gets a
warning. `bind:autosaveState` reads `idle`, `pending`, `saving`, `saved` or
`error`; call `flushAutosave()` when the screen is dismissed.

**A contributed control is two registrations**, made once at startup: sierra's
answers *which columns get it*, the kit's *what it renders as*.

```js fragment
import { registerControl }     from '@frontierjs/sierra/resource'
import { registerFormControl } from '@frontierjs/ui/controls'
import Duration from './Duration.mesa'

registerControl('duration', (rule) => (rule?.['x-unit']?.dimension === 'duration' ? 'duration' : null))
registerFormControl('duration', Duration)
```

The component is handed `{ name, field, value, onvalue, options }`; a third
argument `{ props: (ctx) => ({ … }) }` adapts an existing component instead.
**Put `name` on the element that emits input**, or dirty tracking cannot see it,
and wrap it in `<Field name={name}>` for the label and error. A registered name
replaces the kit's own. `registerDisplayComponent` and `registerFilterComponent`
do the same for `<Cell>` and `<FilterBar>` — see `@frontierjs/ui/controls`.

## Tables

```mesa fragment
<script>
  import Table from '@frontierjs/ui/components/display/Table.mesa'
  import Cell  from '@frontierjs/ui/components/display/Cell.mesa'
  import { orders } from '@/resources/Order.mesa'

  const { columns } = orders.columns()
  const list = orders.tethered()
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
A `footer(rows)` snippet is the table's `<tfoot>` — its own `<tr>`s, for a
totals line or an add-line row; it is drawn over no rows too (not over
skeletons), so a total that says nothing for nothing guards on `rows.length`.
`<Cell timeZone="America/Chicago">` shows an instant in that zone
rather than the viewer's; a `@unit` column reads `7.5 h` on its own.

### Selecting rows

A selection is a set of KEYS the screen owns, not a mode of `<Table>`: the
table draws the header box through its `header(col)` snippet and the row box
in your `row` snippet.

```mesa fragment
<script>
  import Table    from '@frontierjs/ui/components/display/Table.mesa'
  import Checkbox from '@frontierjs/ui/components/forms/Checkbox.mesa'
  import BulkBar  from '@frontierjs/ui/components/display/BulkBar.mesa'
  import Button   from '@frontierjs/ui/components/forms/Button.mesa'
  import { createSelection } from '@frontierjs/ui/selection'
  import { surveys } from '@/resources/Survey.mesa'

  const list = surveys.tethered()
  const picked = createSelection()              // keyed by row.id
  $: list.rows, (rows) => picked.retain(rows)   // a deleted row stops counting
  const columns = [{ name: 'pick', label: 'Select', hideLabel: true }, ...surveys.columns().columns]
  const all = picked.stateOf(list.rows)

  async function resend() {
    for (const id of picked.keys) await surveys.service.invoke('resend', id)
    picked.clear()
  }
</script>

<BulkBar selection={picked}>
  <Button size="sm" onclick={resend}>Resend</Button>
</BulkBar>

<Table {columns} rows={list.rows} rowKey="id">
  {#snippet header(col)}
    {#if col.name === 'pick'}
      <Checkbox label="" aria-label="Select every row shown" checked={all === 'all'}
                indeterminate={all === 'some'} onchange={(on) => picked.set(list.rows, on)} />
    {/if}
  {/snippet}
  {#snippet row(s)}
    <tr>
      <td><Checkbox label="" aria-label={'Select ' + s.title} checked={picked.has(s)} onchange={() => picked.toggle(s)} /></td>
      ...
    </tr>
  {/snippet}
</Table>
```

| Verb | Does |
|---|---|
| `createSelection(keyOf?)` | `keyOf(row)` is the identity, `row.id` when omitted. Two kinds of row in one list need a key that names the kind — `(r) => r.kind + ':' + r.id` — or message 7 and ticket 7 are one key |
| `has(row)` · `toggle(row)` | one row's box |
| `set(rows, on = true)` | ticks every one of `rows`, or with `false` unticks them; rows not given keep their state |
| `stateOf(rows)` | `'none'`, `'some'` or `'all'` over `rows` only — the page, or one group for a per-group header box. An empty list is `'none'` |
| `clear()` · `retain(rows)` | untick everything · untick every key not among `rows` |
| `count` · `keys` | how many keys are held · the keys, in the order ticked |

**A key outlives its row's visibility.** A search, a filter, a collapsed group
or a page turn unticks nothing, so `count` and `keys` can name rows not on
screen — and the bulk action acts on `keys`, which is what the bar's number
says it will touch. The header box judges only the rows it is handed. A list
whose rows can go for good (a delete, somebody else's write) calls `retain` on
them, or the bar counts rows that no longer exist.

**The header handler is `onchange={(on) => s.set(rows, on)}` and nothing
else**: the browser ticks a mixed box on a press, so a part-ticked header
ticks the rest and a full one unticks the rows it governs.

**`<BulkBar>` renders nothing at 0**, so place it unconditionally. Its children
are the actions and it adds Clear after them. Every read subscribes, so a
template needs no `$:` to follow a selection, and the verbs are closures:
`rows.filter(picked.has)` is the ticked rows on screen.

### Keys over a list of rows

A screen worked from the keyboard — an inbox — takes `rowlist` from
`@frontierjs/ui/rowlist`, an `{@attach}` on the element holding the rows:

```mesa fragment
<ul {@attach rowlist(() => ({
  onopen:   (row) => goto(row.dataset.id),
  onselect: (row) => picked.toggle(byId[row.dataset.id]),
}))}>
  {#each items as it (it.id)}<li data-row data-id={it.id}>{it.title}</li>{/each}
</ul>
```

↑/↓ or k/j move, Home/End jump, Enter is `onopen`, Space or `x` is `onselect`.
The list is one tab stop (the cursor row; the controls inside the other rows
are skipped by Tab). A row is `[data-row]` unless `row:` names another
selector. A key typed in a field inside a row stays the field's, and Enter on a
button inside a row is the button's click. Pass a getter, not an object. It
writes no `role`: state `list`/`listitem` or whatever the rows are.

## Attributes, `class` and snippets

**Every component forwards the attributes it does not declare**, and the
caller's value replaces the component's own. Where they land is not uniform:

| Component | Attributes land on |
|---|---|
| display · layout · feedback · `Modal` · `Drawer` · `Window` | the outermost element |
| `Popover` · `DropdownMenu` · `ConfirmationPopover` | the wrapper around the TRIGGER, never the panel |
| every form control | the `<input>`, `<select>` or `<textarea>`, so `<label for>` and `aria-describedby` reach it |
| `FileUpload` · `DatePicker` · `Slider` · `Thresholds` | the visible dropzone · the wrapper · the wrapper · the root, since there are N range inputs and no one control an `aria-describedby` could mean |

**`class` merges with the component's own classes**; on a form control it lands
on the wrapper while other attributes reach the control. Where a component
declares `id` it names something else — a `Toast`'s identity, a `Tab` and
`TabPanel` pairing, an `AccordionItem`, the control a `Label` or `Field` points
at, a `Tooltip`'s own element — so address those with `data-*`.

**A `Slider` or an `Avatar` takes its color from `tone`, or from the data.**
`tone` is one of the seven css tones and follows the theme. A color that IS the
data (an HSL slider accented in its own hue, a client's stored `avatarColor`) is
`--data-accent` on the component or an ancestor, the custom-property name
`fli check` lets a raw color sit in; it wins over `tone`, and an Avatar's initials
keep their contrast on it:
`<Slider style={`--data-accent: hsl(${h} 80% 50%)`} … />`.

**Trailing content has three names**: `actions` on `Form` and `Table`, `action`
on `SectionHeader`, `EmptyState` and `Drawer`, `footer` on `Modal`, `Drawer` and
`Card`.

---

## Icons

**The kit ships no icons and keeps no registry** (`FJS-D1655`). A component
that shows one takes it as a snippet, as `Shell` does; it never takes an icon
name. **An app writes ONE `Icon` component**, and every icon on every screen
goes through it — two icon components are two copies of one decision, and
they drift:

```mesa fragment
<script>
  import { icons } from '../lib/icons.js'   // name → path data, from the set the app chose
  export let name
</script>

<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
     aria-hidden="true" {class} {...$attributes}>
  {#each icons[name] ?? [] as d}<path {d} />{/each}
</svg>
```

It carries no size. Inside a kit component (a button, a navlink, an alert) the
css sizes it; anywhere else `class="icon"` does, and an unsized `<svg>` draws at
300×150. Uno's preset-icons works too: any class starting `i-` is sized, not
only `i-heroicons:`. An icon beside a label stays `aria-hidden`; an icon-only
`<Button square>` puts the name in its `aria-label`.

---

## Wrong guesses

What a habit from shadcn, MUI, Headless UI, Bootstrap or a Svelte component
library produces, and what this kit wants.

| You will write | The kit wants |
|---|---|
| `<Button variant="destructive">`, `color="red"`, `size="icon"` | `tone="danger"` (with `treatment="outlined"` for an outline), `square` plus an `aria-label` |
| `<Button on:click={save}>`, `onClick` | `onclick={save}` |
| `<Button>Save</Button>` as a form's submit | `<Button type="submit">` — the kit's default `type` is `button` |
| `<Dialog open onOpenChange>` | `<Modal bind:open title="…" onclose={…}>` |
| `<DataTable data={rows} columns={[{ accessorKey, cell }]} />` | `<Table {columns} {rows}>` with a `row` snippet |
| `{ key: 'total', label: 'Total' }` in `columns` | `{ name: 'total', label: 'Total' }` |
| `${(order.total / 100).toFixed(2)}` | `<Cell value={order.total} column={c} />` |
| `<FormControl><FormLabel/>`, react-hook-form, zod | `<Input name="email" />` inside `<Form resource={…}>` — rules and validation are the resource's |
| `<Input bind:value={record.email} />` | `value={draft.email} oninput={…}`; `bind:` takes a top-level `let` |
| `toast.success()` from a provider hook | `toasts.success()` from `@frontierjs/ui/stores/toastStore`, `<Toaster />` once |
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
