# ui — package map

**`@frontierjs/ui`** — a Mesa component kit over `@frontierjs/css`. 70
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
              MultiSelect · DatePicker · DateTimeInput · JsonInput · FileUpload ·
              FileField · Button
  display/    Table · Badge · Pill · Tag · Stat · StatCard · Steps · Pagination ·
              Breadcrumbs · Callout · EmptyState · Avatar(+Group) · Sparkline ·
              Json · …
  layout/     Card · Tabs (Tabs/TabList/Tab/TabPanel) · Accordion(+Item)
  overlay/    Modal · Drawer · Popover · Tooltip · DropdownMenu(+Item/Label/
              Separator) · ConfirmationPopover · ConfirmPanel · ConfirmProvider ·
              CommandPalette
  feedback/   Alert(+Provider) · Toast(+er) · Progress · Spinner · Skeleton
stores/       alertStore · toastStore · commandPaletteStore
controls.js   control name → component; where an app contributes one
utils.js      shared helpers
tokens.css    the kit's own tokens, on top of @frontierjs/css
test/         compile-all.mjs · render.mjs · attributes.mjs · form.mjs
test/browser/ the kit drive — run.mjs (the kit half: server, fixture path,
              coverage) · server.mjs (compiles .mesa on demand) · page.js
              (mounts a fixture) · fixtures/*.mesa · specs/*.spec.mjs.
              Chrome, CDP, real input, the spec runner and the DOM probes are
              mesa's — `mesa/test/browser/{drive,probes}.js`, read by relative
              path, because mesa is the leaf and a second CDP client is a
              second place to fix every trap
```

---

## What bites here

- **`$context.form` is the seam.** `forms/Form.mesa` provides
  `{ errors, submitting, disabled, fields, submitted, optionsFor, reportInvalid }`;
  **every control reads it**
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
- **A `Table` column that holds row actions declares `hideLabel: true`.** Not an
  empty `label` — a `<th>` with no text announces nothing for a column that has
  a control in every row, and the app's own a11y pass only checks `scope`, so
  the gap is silent. Not `aria-label` on the `<th>` either: the text belongs in
  the cell, which is where a table's header navigation reads it from.
- **`type="password"` draws a reveal toggle and only the ELEMENT's type flips.**
  `resolvedType` is what the field IS — what `Field` and `Label` are told, and
  what decides whether a toggle belongs here at all — and `inputType` is what
  the `<input>` carries. Conflating them would make a revealed password report
  itself as a text box to everything above the control. Two more that are not
  obvious: the button refuses `mousedown`'s default, because blurring the input
  takes the caret with it and costs a typist their place mid-password; and
  `aria-pressed` is written as the STRING `'true'`/`'false'`, because a `false`
  attribute value is dropped and left the button unselectable in exactly the
  state that matters. `reveal={false}` opts out.
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
  only be *removed*, never added. Do not re-implement it per control. A submit
  reveals every field and then asks them — and **refuses only over a control the
  form is SHOWING** (`FJS-316`). `make()` seeds every writable column, so a
  hand-written form legitimately renders three of them and completes the rest in
  its own `onsubmit`; refusing over the whole record makes such a form
  unsubmittable with no message anywhere, which is what `basecamp`'s drive
  caught.
- **`$context.form` reports `disabled` and `submitting` separately, because
  they do not mean the same thing to everything under a form.** A field locks on
  either — typing into a form being saved edits a record already in flight —
  and only a `type="submit"` button follows `submitting`, so Cancel stays live
  during a slow save. A control resolves it as
  `stated(disabled, form?.disabled || form?.submitting)`, which is why every
  control's own `disabled` prop defaults to **`undefined`** and not `false`:
  `stated()` takes the first non-null, so a `false` default would win and the
  form could never answer.
- **`method="auto"` is decided in the form, not by the service's `upsert`.**
  The client's `upsert` is a convenience hardcoded to `data.id`, while the form
  knows the model's real `idField` from the schema — the two disagree on any
  model keyed by anything else, and the disagreement created a duplicate row
  instead of editing one (`FJS-316`).
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
- **A panel positioned in a frame callback must not be visible before that
  frame.** The frame that PAINTS a newly inserted panel is the one before the
  callback that places it — input is dispatched, mesa's flush inserts the
  panel, style and paint run, and the `requestAnimationFrame` the handler
  queued waits for the next frame — and `x`/`y` still hold the LAST open's
  placement. So every open shows one frame wherever the trigger used to be,
  and when that lands ON the trigger the click meant to close the panel falls
  inside it, where click-away deliberately lets it through: the panel stays
  open and nothing on screen says why (`FJS-331`). `DropdownMenu` and `Popover`
  render `visibility: hidden` and are shown by the
  frame that places them — not painted, not hit-tested, and no extra frame,
  because `placed` reaches the DOM on the microtask inside that same frame.
  **Focus goes after that flush, not before it**: focus is refused on a hidden
  element. Assert it at INSERTION with a `MutationObserver`; a poll cannot see
  a single frame.
  **`ConfirmPanel` places itself synchronously instead**, off a forced layout,
  and only then becomes visible — waiting for a frame is a bet that a frame
  arrives, and headless Chrome delivers almost none after load, so the panel sat
  hidden at 0,0 while a click aimed at its confirm button landed behind it
  (`FJS-402`). The frame callback is kept as a re-place for a panel whose content
  resized.
- **A `Json` column is the one shape with no schema under it, and both halves of
  the answer are new.** `display/Json.mesa` reads a document and
  `forms/JsonInput.mesa` edits one; Sierra's table answers `json` where the
  schema states no type at all — which is what a `Json` column emits, and NOT
  `type: 'object'` — where it used to answer `null` and have `<Form>` warn the
  column off the form. Three things about them:
  - **The viewer ships no palette.** It marks tokens with the elements `glow()`
    uses — `<b>` a key, `<em>` a value, `<strong>` a keyword, `<i>`
    punctuation, `<sup>` an annotation — inside a `<code language="json">`,
    which is the shape `code.css` themes. So it retints with the theme for free.
    A theme that stops matching still renders a legible tree in ONE colour,
    which is why the drive asserts the computed colours differ.
  - **A row is selected by `data-path`, not by its text.** Two keys at two
    depths read identically, and a key that CONTAINS a dot is the shape that
    breaks a joined path — `['a.b']` and `['a','b']` are two nodes and one
    string.
  - **The tree is ONE grid and a row is `display: contents`.** Three columns —
    key · value · tools — so a value at depth three starts at the same x as a
    value at depth zero and every remove button shares one right edge; a flex
    line per row aligns each row only with itself. Two consequences bite. A row
    has no box, so `getBoundingClientRect()` on one is empty and any assertion
    built on a row's height passes against anything — measure the tree. And
    **every row must emit exactly three cells**, empty ones included, or grid
    auto-placement pulls the next row's key into the tools column. An add row
    and a refusal message opt out with `grid-column`, the add row because an
    `<input>` in column one sizes that column to itself and pushes every value
    in the document right.
    The grid is also what makes `.code`'s `white-space: pre` survivable: a
    whitespace-only text node is not a grid item, so the newlines the compiler
    emits between the rows are dropped. As a block they render, and the tree
    came out 1619px tall for 9 rows on a screen nobody could read.
  - **`editable` adds edit, rename, remove and add, and every write answers a
    COPY** — the operations are `@frontierjs/toolbelt/json`'s, so a rename keeps
    its key in place and a removal goes by index. The draft is `undefined` until
    the first edit, so a read-only tree always shows the live prop and only an
    edited one holds its own document. A boolean is a toggle rather than a box
    (two values is not a thing to type), a leaf edit runs through `coerceLike`
    so a number stays a number, and the ROOT has its own add affordance because
    it is not a row, and it is always on screen rather than behind a `+` —
    `.fjs-json-addroot` is that row, not a trigger, so a drive types into it
    directly. There is no reorder: the kit has no move operation and
    inventing one here would be a second definition of what a write is.
    **Asserting immutability needs the LIVE object** — an in-place mutation
    changes no binding, so an `<output>` holding `JSON.stringify(doc)` still
    shows what it rendered at mount, and the assertion passes against exactly
    the bug it exists for. Measured: the fixture exposes the object on `window`
    for that reason.
  - **The tree is a `treegrid`, and a row must have a BOX.** `display: contents`
    keeps the role in the a11y tree (measured — the folklore is out of date) but
    gives no box, and an element with no box cannot take focus, which rules out
    a roving tabindex and with it the whole pattern. `grid-template-columns:
    subgrid` gives the box AND the column alignment. One tab stop: the tree
    carries `tabindex="0"`, every stop inside carries `-1`, and focusing the
    tree hands focus straight to the cursor. Navigation reads the DOM rather
    than mirroring it in state — the rows already carry `data-path`, and a
    parallel model is a second thing to keep in step with search, undo and
    collapse. Two rules that need holding: the column survives a row change, and
    **a caret owns the arrows** inside any input or select.
  - **`copy` is per row as well as per document**, and the path it copies is
    built rather than joined: `headers.content-type` parses as a subtraction,
    `odd.0` is a syntax error, and a pointer joined with slashes names nothing
    once a key holds one. `pathStyle="pointer"` is the RFC 6901 spelling.
    **The document actions overlap the first row** unless the block reserves
    room — they sit in `.code`'s top padding and a `.btn.square` is taller than
    it, so the first row's buttons were present, correct and unclickable. Assert
    that class of thing with `elementFromPoint`, never with a presence check.
    The copy itself is `CopyButton`'s exported `copyText` (`FJS-D116`), because
    its non-HTTPS fallback is what a second implementation would silently drop.
  - **`search` is a filter over the rows, and it must open its own ancestors.**
    `treeRows` emits children of an OPEN container only, so a hit four levels
    down is not a row — `searchDoc` answers `open` for that, and the drive's
    fixture is `expand={0}` so the assertion cannot pass without it. Hits are
    marked with the package's `<mark>` (themed inside `code[language]`, with a
    negative margin so it does not disturb the monospace grid), every
    occurrence and in the document's own casing. The count is there because a
    filter that matched nothing and an empty document look identical.
  - **The box coerces, the control converts, and both rules are live.**
    `coerceLike` keeps the type an edit replaces; a `<select>` in the row tools
    changes it on purpose through `convertTo`. Without the second a document
    can be edited and never reshaped. The select is also the only thing that
    says what kind a row holds — `""` and `"null"` read identically otherwise.
    **Mark the current kind on the OPTION, never as the select's `value`**: a
    select's value is applied before its `{#each}` builds the options, so
    nothing matches and every row falls back to the first one, reporting the
    whole document as strings. A probe that sets `el.value` itself cannot see
    that; assert what the control REPORTS.
  - **Undo is a stack of documents, and it is affordable only because every
    write answers a copy** — `setIn` shares every branch it did not touch, so an
    entry costs the path that changed. Capped at 50. The rule that matters:
    **the echo is recognized by VALUE, not identity.** A controlled caller that
    adopts a write and rebuilds its own object hands back an equal document with
    a different identity; by identity that is a second, foreign change, the
    write lands twice, and every edit costs two presses to undo. A document that
    is genuinely not the one we announced IS a history step, so undo walks back
    over somebody else's edit rather than letting it vanish. An undo is
    announced like any other write, a fresh edit drops the forward stack, and
    ⌘Z is bound to the TREE — a document-level handler takes the shortcut off a
    page that has its own.
  - **`against` is diff mode, and it walks a MERGED document.** A removed key
    is in neither `value` nor any tree built from it, so a diff that walks
    `value` shows every change except the ones that took something away.
    `diffDocs` answers the merge, the per-path status, the previous value and
    the rows to open. The marks are the PACKAGE's — `<ins>`/`<del>`/`<dfn>`
    inside a `code[language]`, which `code.css` draws as stripes off
    `--code-ins`/`--code-del`/`--code-note` — so this makes no colour decision
    here either. Two shapes worth knowing: a changed leaf renders both sides,
    old above new, because a status word cannot say *changed from what*; and
    `--code-pad` is zeroed on the value cell, since the package bleeds a stripe
    out to the block's edge (right for a source line, wrong for one cell of a
    grid, where it runs back under the key column and reads as though the key
    changed too). `editable` is refused while `against` is set.
  - **A new `value` IDENTITY clears the draft**, which is what makes the tree
    usable as one editor among several over the same object: a caller that
    binds `onchange` back into `value` is controlled and always sees its own
    state, a caller that ignores it keeps its draft because `value` never
    moves. `example`'s /settings/ is the live case — the tree and the form
    controls edit one preferences document, either way round.
  - **The control writes only what parses, and tells the form so.**
    `$context.form.reportInvalid(name, message)` is the channel (`FJS-404`) — a
    control saying *the value I am showing is not one I can hand over*, with a
    null message retracting it. It is the FOURTH error source in `Form.mesa`
    and the only one that judges the box rather than the record: the record
    holds the last value the control could convert, so every check on it passes
    while the screen shows something else. Three things follow from that:
    it merges LAST, over a server and a live message, because it is the only
    one describing what is on screen now; it refuses a submit **even in a
    hand-written form**, where `FJS-316` deliberately stops the record-level
    checks (the control is on screen by construction — it is the thing that
    reported); and `clearErrors()` does NOT clear it, because it is about text
    still in the box and only the control that raised it can retract it. Guard
    a `reportInvalid` on no-change: it rebuilds `$context.form`, which
    re-derives the control that called it.
- **A component file may export the verbs that belong to its noun** (`FJS-D116`).
  `import FileUpload, { formatBytes, isImage } from '.../FileUpload.mesa'` — a
  `<script module>` export compiles to a plain top-level ESM export beside the
  default, so a caller importing the function imports a function and no
  component. Two boundaries: a SECOND component needing it moves it to
  `utils.js`, or this kit grows component→component imports; and anything the
  server would also want goes to `@frontierjs/toolbelt`, because a `.mesa`
  import needs the Mesa build plugin.
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
  - **The import map is what resolves a bare specifier, and there is no
    guessing.** A subpath with no extension has to be spelled out. The
    **toolbelt half is generated from that package's own `exports`**, because
    the hand list held two kits while `field-rules` grew a third: the browser
    failed to resolve `@frontierjs/toolbelt/jsonschema` and four form specs
    died before their first assertion, reported as *spec threw*, which reads as
    the drive being broken rather than as one missing line.
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
  - **A `[Mesa]` console warning fails the run.** The framework reports a
    render it survived but corrupted — a duplicate `{#each}` key above all —
    through `console.warn`, and the drive listened for `console.error` only. So
    Mesa said exactly what was wrong with `Pagination`, in the browser, every
    render, for as long as the component has existed (`FJS-315`).
  - **`clickAt` scrolls an element into view when it is outside the viewport.**
    A press is dispatched at viewport coordinates, so a control below the fold
    used to be clicked at a point off-screen: the event landed elsewhere or
    nowhere, and the assertion after it read as a component that ignores
    clicks. What it tests is the POINT it is about to press, not the element:
    a full-width field at the end of a long form has its top in view and its
    center past the bottom edge, which asking about the element misses. It
    scrolls only when that point is out of view — a spec that has positioned
    the page on purpose (where a popover flips) must not have that undone.
  - **No backticks in a probe's own comments.** Everything passed to
    `t.evaluate` is a template literal, so a backtick inside a comment in it
    ends the string and the spec fails to parse — which reads as the drive
    being broken rather than the spec. It has bitten twice.
  - **`--verbose` prints the passing assertions.** A spec that THROWS half way
    reports one failure and no clue how far it got; the rows are the only
    record.
  - **`waitSettled(sel)` before a coordinate click near anything animating.**
    `waitVisible` answers *can this be seen*, which is not *has it stopped
    moving*: `t.clickAt` reads a rect and then presses that point, so a
    neighbor still growing into place puts the target somewhere else by the
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
- **A `const` consumer of `$context.x` is the VALUE, and it is live** — it
  tracks the provider (Rule 25a), so it reads current inside a handler that
  runs much later, and it is neither a getter to call nor a snapshot taken at
  setup. `TabList` guarded with `typeof getActiveId === 'function'`; that
  branch was dead. The shape reads as prudence and is really a second answer to
  what a context read is.
- **What a part registers with its parent, it registers as a getter.** `Tab`
  hands `Tabs` `(id, () => disabled)`, because `disabled` is its own prop and
  can change long after the registration ran — a copied boolean is a strip that
  keeps stepping onto a tab the app has since turned off, and it passes every
  assertion written against the initial state (`FJS-313`). Order in that
  registry is mount order, and the default pick is taken from it, so a
  `TabList` that defers a child changes which tab opens.
- **A list with a keyboard cursor takes the pointer on `mousemove`, never on
  `mouseenter`.** `mouseenter` fires when an ELEMENT arrives under a still
  pointer, which is the ordinary case twice over: a ⌘K palette opens under
  whatever the mouse was last left on, and arrow-keying a long list scrolls
  rows under it. Either way the cursor jumps to a row nobody chose and Enter
  runs it, with nothing on screen to distinguish that from the component
  working (`FJS-322`). `mousemove` needs the pointer to actually move; guard
  the assignment (`if (idx !== gi)`) since it fires per pixel.
- **A control whose focus lives in a text box has to name the active row.**
  `aria-selected` moving down a listbox says nothing to a screen reader while
  focus never moves — the input needs `role="combobox"` and
  `aria-activedescendant`, and the rows need ids. All three do it now
  (`FJS-322`, `FJS-323`). Assert it through `document.getElementById`: an
  `aria-activedescendant` naming an element that does not exist reads exactly
  like one that works.
- **A `$:` watch fires on CHANGE, so it cannot be where state is first built.**
  `MultiSelect`'s option map was filled only by `$: options, () => …`, and a
  caller handing over a static array changed nothing — the map stayed empty for
  the life of the component and every dropdown said "No options" (`FJS-324`).
  Seed at the declaration and let the watch merge what arrives later. The
  symptom is silent in the ordinary case: the control renders, opens, and is
  empty.
- **A long action holds a toast HANDLE, it does not fire two of them.**
  `toasts.loading(msg)` answers `{ id, update(type, message, duration?),
  dismiss() }` and settles the same toast in place — `toasts.update(id, patch)`
  is underneath it. A loading toast has `duration: 0` and a spinner rather than
  a verdict icon, so it does not dismiss itself and does not draw a drain bar
  it cannot honor. Settling one the reader already dismissed answers `false`
  and does not put it back; `update()` reschedules the timer only when a
  duration is stated. **The test that matters is node identity** — a
  remove-and-add looks identical on screen and loses the reader's place in the
  stack.
- Errors arrive through `toFieldErrors()` (sierra's `field-rules.js`), which is
  the one owner of "a thrown value → per-field messages". `<Form>` calls it and
  knows nothing else about error shapes.

## Proving a change

`bun run test` — which now includes the browser drive — then `example`:
`bun run verify:ui`, the behavioral components on real screens. `verify` covers
the 13 that carry every route. The two drives answer different questions and
both are worth running: this one mounts a component alone and can reach modes no
screen uses, `example`'s puts it in an app with a real service behind it.
