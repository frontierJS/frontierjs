# ui — layout

The file-by-file map of the package; `CLAUDE.md` § Where things are is the short list.

```
components/
  forms/      Form · Field · Fieldset · Label · Input · Textarea · Select ·
              Checkbox · RadioGroup · Switch · Slider · Thresholds · SignaturePad · NumberInput · Combobox ·
              MultiSelect · DatePicker · DateTimeInput · JsonInput · CodeInput ·
              FileUpload · FileField · GeoField · MoneyInput · Button ·
              Textbox (a <textarea> on vim's keys, toolbelt /textbox under
              mesa keys(); one .mesa for a tab and a terminal; its keys()
              answers its mode, which the terminal shell follows, and
              `idle` takes no key and keeps none — FJS-D1411)
  display/    Table · Badge · Pill · Tag · Stat · StatCard · Steps · Pagination ·
              Breadcrumbs · Callout · EmptyState · Avatar(+Group) · Sparkline ·
              Json · Markdown · HtmlFrame · TemplatePreview · SignatureView · BulkBar ·
              Transcript · Message · Composer (chat) · …
  layout/     Card · Tabs (Tabs/TabList/Tab/TabPanel) · Accordion(+Item) ·
              Shell (the app frame, drawn from a nav.js table; Sierra's
              page, session and isActive arrive as props)
  overlay/    Modal · Drawer · Popover · Tooltip · HoverCard · DropdownMenu(+Item/Group/
              Separator) · ConfirmationPopover · ConfirmPanel · ConfirmProvider ·
              CommandPalette
  feedback/   Alert(+Provider) · Toast(+er) · Progress · Spinner · Skeleton
stores/       alertStore · toastStore · commandPaletteStore
controls.js   control name → component; where an app contributes one
dnd.js        dndzone — drag and drop between flow lists, an {@attach}
drag.js       drag — one pointer drag, press to release or cancel, an {@attach}
nav.js        the `src/lib/nav.js` contract (typedefs) and sectionFor · visible ·
              paletteItems; never decides CURRENT, which is Sierra's isActive
rowlist.js    rowlist — the keys of a list of rows (cursor, one tab stop, open,
              select), an {@attach} over toolbelt `/keys` tables (FJS-2009)
selection.js  createSelection — the ticked KEYS of a list, signal-backed; the
              screen composes it with Checkbox `indeterminate` and BulkBar,
              and Table stays out of it (FJS-D671)
utils.js      shared helpers; `download()` saves a file, `openFile()` shows one in a tab
test/         compile-all.mjs · render.mjs · attributes.mjs · form.mjs ·
              nav.mjs (the nav.js contract)
test/browser/ the kit drive — run.mjs (the kit half: server, fixture path,
              coverage) · server.mjs (compiles .mesa on demand) · page.js
              (mounts a fixture) · fixtures/*.mesa · specs/*.spec.mjs.
              Chrome, CDP, real input, the spec runner and the DOM probes are
              mesa's — `mesa/test/browser/{drive.mjs,probes.js}`, read by relative
              path, because mesa is the leaf and a second CDP client is a
              second place to fix every trap
```
