/*
 * attributes.mjs
 * Every component forwards the attributes its caller wrote on it.
 *
 * `{...$attributes}` is `restProps(props, declared)` — whatever the caller
 * passed that the component did not declare. A component without the spread
 * DROPS all of it silently: `<Mono id="x">` used to render a bare <code>, so
 * the caller could not address the element they had just written,
 * aria-describedby had nothing to point at, and a browser drive's selector
 * found nothing rather than failing. 55 of 64 components were in that state.
 *
 * What this asserts, per component:
 *   1. an undeclared attribute (`data-test`) reaches the DOM
 *   2. `id` reaches the DOM — except where `id` is a declared prop with its
 *      own meaning, which is the ID_IS_A_PROP list below, each with a reason
 *   3. the caller wins: an attribute the component sets itself is REPLACED,
 *      not duplicated, when the caller states it
 *
 * Where the spread lands is not uniform, and that is deliberate:
 *   • display / layout / feedback / overlay — the outermost element, the same
 *     one `{class}` lands on
 *   • form controls — the CONTROL (`<input>`, `<select>`, the dropzone
 *     button), not the `.field-group` wrapper, because that is what a
 *     `<label for>` and an `aria-describedby` have to reach
 *
 * Run: node test/attributes.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Props a component needs before it renders anything at all. Without these it
// renders an empty shell and the assertion below would pass on nothing.
const PROPS = {
  'display/AvatarGroup': { users: [{ name: 'Ada' }, { name: 'Bob' }] },
  'display/Bar':         { value: 40 },
  'display/Breadcrumbs': { items: [{ label: 'Home', href: '/' }, { label: 'Orders' }] },
  'display/Kbd':         { keys: ['⌘', 'K'] },
  'display/Pagination':  { total: 100, page: 2, perPage: 10 },
  'display/Sparkline':   { data: [1, 4, 2, 8, 5] },
  'display/Stat':        { label: 'MRR', value: '£1,204' },
  'display/StatCard':    { label: 'MRR', value: '£1,204' },
  'display/Steps':       { steps: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }] },
  'display/Table':       { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Ada' }] },
  'feedback/Toast':      { message: 'Saved' },
  'forms/Combobox':      { options: ['alpha', 'beta'] },
  'forms/Label':         { label: 'Email' },
  'forms/MultiSelect':   { options: ['alpha', 'beta'] },
  'forms/RadioGroup':    { name: 'plan', items: [{ value: 'a', label: 'A' }] },
  'forms/Select':        { options: ['alpha', 'beta'] },
  'layout/Tab':          { id: 'one' },
  'layout/TabPanel':     { id: 'one' },
  'overlay/CommandPalette': { open: true, items: [{ id: 'a', label: 'Alpha' }] },
  'overlay/ConfirmationPopover': { open: true },
  'overlay/DropdownMenu':   { open: true },
  'overlay/Popover':        { open: true },
}

// `id` is a declared prop here and means something other than a DOM id, so the
// spread never sees it. A caller addressing one of these writes data-*.
const ID_IS_A_PROP = {
  'feedback/Toast':       'id is the toast identity the store dismisses by',
  'layout/Tab':           'id names the pairing, and renders as id="tab-{id}"',
  'layout/TabPanel':      'id names the pairing, and renders as id="panel-{id}"',
  'layout/AccordionItem': 'id names the summary/body pairing',
  'forms/Field':          'id is the CONTROL\'s id — it goes on the <label for>, not the wrapper',
  'overlay/Tooltip':      'id overrides the generated tooltip id the trigger describes itself by',
  'forms/Label':          'id is the id of the control this label points `for` at',
  // Every other form control also declares `id` and puts it on the control
  // itself, so the id lands — which is why it is asserted separately from
  // data-test rather than assumed.
}

// Not renderable by this harness, each for a reason that is not a passthrough
// failure. Named rather than filtered, so a component cannot go quiet.
const SKIP = {
  'feedback/AlertProvider': 'portals to document.body; no SSR output',
  'feedback/Toaster':       'portals to document.body; no SSR output',
  'overlay/CommandPalette': 'portals to document.body; no SSR output',
  'layout/AccordionItem':   'reads Accordion\'s $context; standalone render has none',
  // It renders whichever control the field asked for and hands that control
  // the props its entry built — there is no element of its own for a caller's
  // attributes to land on, and a caller does not write one. <Form> does.
  'forms/FormField':        'a dispatcher, not an element — the control it picks owns the attributes',
}

// Components that set this attribute themselves, on the element the spread
// lands on. Passing it must REPLACE the component's own value, not duplicate
// the attribute — that is the caller-wins half of the contract.
const CALLER_WINS = {
  'display/Breadcrumbs': 'aria-label',
  'forms/FileUpload':    'aria-label',
  'display/Steps':       'aria-label',
}

const files = readdirSync(join(ROOT, 'components'), { withFileTypes: true })
  .filter(d => d.isDirectory())
  .flatMap(d => readdirSync(join(ROOT, 'components', d.name))
    .filter(f => f.endsWith('.mesa'))
    .map(f => `${d.name}/${f.replace(/\.mesa$/, '')}`))
  .sort()

let failed = 0
let skipped = 0

const render = async (key, data) => {
  const file = `components/${key}.mesa`
  const out = await renderComponent(readFileSync(join(ROOT, file), 'utf8'), {
    data,
    cwd: ROOT,
    filename: file,
    styleTag: false,
    // '../../utils.js' resolves from the TEMP file's directory, so the temp
    // module has to sit at the depth every component sits at.
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  return out.html
}

for (const key of files) {
  if (SKIP[key]) {
    console.log(`  skip ${key} — ${SKIP[key]}`)
    skipped++
    continue
  }

  const base = PROPS[key] ?? {}
  let html
  try {
    html = await render(key, { ...base, id: 'probe-id', 'data-test': 'probe' })
  } catch (err) {
    console.error(`✗ ${key}\n    render threw: ${err.message}`)
    failed++
    continue
  }

  if (!html.includes('data-test="probe"')) {
    console.error(`✗ ${key}\n    dropped an undeclared attribute — is {...$attributes} on the rendered element?`)
    failed++
    continue
  }

  if (!ID_IS_A_PROP[key] && !html.includes('id="probe-id"')) {
    console.error(`✗ ${key}\n    dropped id`)
    failed++
    continue
  }

  const attr = CALLER_WINS[key]
  if (attr) {
    // A component that no longer sets the attribute itself would make the
    // override below pass without testing anything.
    const bare = await render(key, base)
    if (!bare.includes(`${attr}=`)) {
      console.error(`✗ ${key}\n    no longer sets its own ${attr} — this case tests nothing, repoint it`)
      failed++
      continue
    }

    const withMine = await render(key, { ...base, [attr]: 'CALLER' })
    const count = (withMine.match(new RegExp(`${attr}=`, 'g')) || []).length
    if (!withMine.includes(`${attr}="CALLER"`)) {
      console.error(`✗ ${key}\n    the component's own ${attr} won over the caller's`)
      failed++
    } else if (count !== 1) {
      console.error(`✗ ${key}\n    ${attr} emitted ${count}× — the caller's value must replace, not duplicate`)
      failed++
    }
  }
}

const checked = files.length - skipped
if (failed) {
  console.error(`\n${failed} of ${checked} components fail the attribute contract`)
  process.exit(1)
}
console.log(`${checked}/${checked} components forward their caller's attributes (${skipped} skipped, named above)`)
