/*
 * render.mjs
 * Renders a representative component from each tier and asserts that the
 * @frontierjs/css vocabulary actually reaches the DOM.
 *
 * Compiling proves the file is valid; it proves nothing about styling. These
 * assertions are the ones that would have caught the original problem — 55 of
 * 63 components emitting `bg-gray-100 text-gray-600`, utility classes that
 * nothing in this repo generates, so every one of them rendered unstyled.
 *
 * Run: node test/render.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Utility-class shapes that must never come back. A hit here means a
// component is styling itself with classes no stylesheet in this repo ships.
const UNO = /\bclass="[^"]*\b(?:bg-(?:gray|blue|red|green|yellow|white|slate)-\d|text-(?:gray|blue|red|white|slate)-\d|border-gray-\d|rounded-(?:md|lg|xl|full)|shadow-(?:sm|md|lg)|(?:px|py|pt|pb|w|h|gap)-\d|shrink-0|sr-only)\b/

const CASES = [
  // file,                              props,                       classes that must appear
  ['components/forms/Button.mesa',      { tone: 'danger' },          ['btn', 'danger']],
  ['components/forms/Button.mesa',      { treatment: 'outlined' },   ['btn', 'outlined']],
  ['components/forms/Button.mesa',      { tone: 'danger', treatment: 'ghost' }, ['btn', 'danger', 'ghost']],
  ['components/forms/Input.mesa',       { label: 'Email' },          ['field-group', 'field']],
  ['components/forms/Input.mesa',       { label: 'Email', error: 'Taken' }, ['field-group', 'danger']],
  // FJS-2517: no label and no name still draws its message and hint.
  ['components/forms/Input.mesa',       { label: '', error: 'Taken' }, ['field-group', 'field-hint', 'danger']],
  ['components/forms/Input.mesa',       { error: 'Taken' },          ['field-group', 'field-hint', 'danger']],
  ['components/forms/Input.mesa',       { hint: 'Paste a URL' },     ['field-group', 'field-hint']],
  ['components/forms/Select.mesa',      { options: ['a'] },          ['field']],
  ['components/forms/Textarea.mesa',    {},                          ['field']],
  // A nullable @length column hands a generated form null, and the counter
  // reading its length took the whole mount down (FJS-2603). The counter is
  // the assertion.
  ['components/forms/Textarea.mesa',    { value: null, maxlength: 10 }, ['field', 'field-hint']],
  ['components/forms/Checkbox.mesa',    { label: 'Yes' },            ['field-check']],
  ['components/forms/Switch.mesa',      { label: 'On' },             ['field-check', 'switch']],
  // The Reset button is the assertion: this control composes another kit
  // component, so a broken compose renders a plot with no way back.
  ['components/forms/Thresholds.mesa',  { values: [10, 30], data: [1, 4, 40], defaults: [10, 30], label: 'Cuts' },
                                                                 ['field-group', 'btn', 'outlined']],
  ['components/display/Badge.mesa',     { tone: 'success' },         ['badge', 'success']],
  ['components/display/Pill.mesa',      { tone: 'warning' },         ['pill', 'warning']],
  ['components/display/Tag.mesa',       {},                          ['pill', 'removable', 'pill-close']],
  ['components/display/Stat.mesa',      { label: 'MRR', value: '1' }, ['tile-label', 'tile-value']],
  ['components/display/EmptyState.mesa',{ title: 'None' },           ['empty', 'empty-title']],
  ['components/display/Breadcrumbs.mesa', { items: [{ label: 'Home' }] }, ['breadcrumb']],
  ['components/display/Table.mesa',     { columns: [{ name: 'a', label: 'A' }] }, ['table', 'table-wrap']],
  ['components/display/Kbd.mesa',       {},                          ['kbd']],
  // A prerendered page draws a markdown column rendered, not as its source
  // until hydration (FJS-3153, FJS-D821). The renderer's class is the assertion.
  ['components/display/Cell.mesa',      { value: '**b**', column: { name: 'notes', display: 'markdown' } }, ['cell', 'fjs-markdown']],
  // auth's user.name is String?, so null is the value a signed-in user hands
  // over; a prop default covers undefined only, and a throw at setup takes the
  // whole mount down (FJS-2604). The person icon is the assertion.
  ['components/display/Avatar.mesa',    { name: null },              ['avatar', 'muted']],
  ['components/display/AvatarGroup.mesa', { users: [{ name: null }, { name: 'Dana Ortiz' }] }, ['avatars', 'avatar', 'muted']],
  // Chart renders on the SERVER, which is the point of it: the same SVG prints
  // to PDF and screenshots to PNG for an email (DL V3, R5, R6). One mark per
  // row and a focusable hit target per row are the assertions.
  ['components/display/Chart.mesa',     { rows: [{ m: 'Jan', v: 3 }, { m: 'Feb', v: 5 }], x: 'm', y: 'v', label: 'Per month' },
                                                                 ['fjs-chart', 'fjs-chart-bar', 'fjs-chart-hit', 'fjs-chart-grid']],
  ['components/display/Chart.mesa',     { rows: [{ m: 'Jan', v: 3 }, { m: 'Feb', v: 5 }], x: 'm', y: 'v', type: 'line', tone: 'success' },
                                                                 ['fjs-chart', 'success', 'fjs-chart-line', 'fjs-chart-area', 'fjs-chart-dot']],
  ['components/display/Chart.mesa',     { rows: [{ m: 'Acme', v: 3 }, { m: 'Bolt', v: 5 }], x: 'm', y: 'v', orientation: 'horizontal' },
                                                                 ['fjs-chart', 'fjs-chart-bar', 'fjs-chart-name', 'fjs-chart-zero', 'fjs-chart-value']],
  ['components/display/Chart.mesa',     { rows: [{ m: 'Jan', v: 3, p: 2 }, { m: 'Feb', v: 5, p: 4 }], x: 'm', y: 'v', compare: 'p', reference: 4, type: 'line' },
                                                                 ['fjs-chart', 'fjs-chart-compare', 'fjs-chart-key', 'fjs-chart-key-compare', 'fjs-chart-reference', 'fjs-chart-reference-text']],
  // The heading TAG is the assertion: it comes from <mesa:element this={'h'+level}>,
  // and a level that stopped reaching the DOM would render something that looks
  // identical and carries a different document outline.
  ['components/display/SectionHeader.mesa', { title: 'T', level: 3 }, ['section-header', 'h3']],
  ['components/layout/Card.mesa',       { tone: 'danger' },          ['card', 'danger']],
  ['components/layout/Tab.mesa',        { id: 'x' },                 ['tab']],
  ['components/feedback/Alert.mesa',    { tone: 'danger' },          ['alert', 'danger', 'alert-icon']],
  ['components/feedback/Spinner.mesa',  {},                          ['spinner', 'visually-hidden']],
  ['components/feedback/Progress.mesa', { value: 40 },               ['progress']],
  // Renderable at all only since mesa stopped running {@attach} server-side
  // (FJS-146) — its fade-in attachment called el.animate on a happy-dom node.
  ['components/feedback/Toast.mesa',    { message: 'Saved', tone: 'success' }, ['toast', 'success', 'alert-icon']],
  ['components/feedback/Skeleton.mesa', { variant: 'text' },         ['skeleton', 'text']],
  ['components/overlay/Modal.mesa',     { title: 'T' },              ['dialog', 'surface-header']],
  ['components/overlay/Drawer.mesa',    { title: 'T' },              ['drawer', 'from-right']],
  ['components/overlay/DropdownGroup.mesa', { heading: 'Account' },  ['items', 'navlist-label']],
]

let failed = 0

for (const [file, data, expected] of CASES) {
  const label = `${file} ${JSON.stringify(data)}`
  let html
  try {
    const out = await renderComponent(readFileSync(join(ROOT, file), 'utf8'), {
      data,
      cwd: ROOT,
      filename: file,
      styleTag: false,
      // Components import '../../utils.js', and a bare relative import resolves
      // from the TEMP file's directory, not the source's. Two levels under the
      // package root puts the temp module at the same depth every component
      // sits at, so '../../utils.js' lands on the real one.
      tmpDir: join(ROOT, 'components', '.mesa-tmp'),
    })
    // renderComponent returns { html, css, exports, … }, not a string.
    html = out.html
  } catch (err) {
    console.error(`✗ ${label}\n    render threw: ${err.message}`)
    failed++
    continue
  }

  // Read off class attributes and tag names, not the whole document: an
  // undeclared prop lands as an attribute, so `treatment="outlined"` would
  // satisfy a word search while the button carries no `.outlined`.
  const classes = new Set([...html.matchAll(/\bclass="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)))
  const tags    = new Set([...html.matchAll(/<([a-z][\w-]*)/g)].map(m => m[1]))
  const missing = expected.filter(c => !classes.has(c) && !tags.has(c))
  if (missing.length) {
    console.error(`✗ ${label}\n    missing class(es): ${missing.join(', ')}`)
    failed++
    continue
  }

  const uno = html.match(UNO)
  if (uno) {
    console.error(`✗ ${label}\n    utility class leaked back in: ${uno[0].slice(0, 80)}`)
    failed++
  }
}

// ── A menu section is named by its heading ──────────────────────────────────
//
// `FJS-1688`. A heading written as a sibling above its rows named nothing, so a
// screen reader moving through a menu was never told which section it was in.
// The group has to wrap the rows and point at the heading's own id.
{
  const GROUP = `<script>
  import DropdownGroup from '../overlay/DropdownGroup.mesa'
  import DropdownItem  from '../overlay/DropdownItem.mesa'
</script>
<DropdownGroup heading="Account"><DropdownItem>Profile</DropdownItem></DropdownGroup>`
  const out = await renderComponent(GROUP, {
    cwd: ROOT, filename: 'components/layout/GroupFixture.mesa', styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  const group   = out.html.match(/<div[^>]*role="group"[^>]*>/)?.[0] ?? ''
  const labelled = group.match(/aria-labelledby="([^"]+)"/)?.[1]
  const heading = labelled && out.html.match(new RegExp(`<div[^>]*id="${labelled}"[^>]*>([^<]*)<`))
  const problems = []
  if (!group) problems.push('no role="group" wrapper')
  else if (!labelled) problems.push(`group has no aria-labelledby: ${group}`)
  else if (!heading || heading[1].trim() !== 'Account') problems.push(`aria-labelledby ${labelled} does not reach the heading`)
  if (group && !/role="group"[\s\S]*menuitem/.test(out.html)) problems.push('the rows are not inside the group')
  if (problems.length) {
    console.error(`✗ DropdownGroup names its section\n    ${problems.join('\n    ')}`)
    failed++
  }
}

// ── A caller's trigger draws the button ─────────────────────────────────────
//
// `FJS-2511`. A trigger-only CopyButton is the third usage its header shows, and
// it was drawn `.square` and named 'Copy to clipboard' whatever the trigger
// showed: a palette row measured 157px square, and eight swatches were eight
// buttons with one name.
const TRIGGER = `<script>
  import CopyButton from '../display/CopyButton.mesa'
</script>
<CopyButton text="#542522">
  {#snippet trigger(copied)}<span class="swatch">#542522</span>{/snippet}
</CopyButton>`

{
  const out = await renderComponent(TRIGGER, {
    cwd: ROOT, filename: 'components/layout/CopyTrigger.mesa', styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  const button = out.html.match(/<button[^>]*>/)?.[0] ?? ''
  const problems = []
  if (!/class="swatch\b/.test(out.html)) problems.push('the trigger did not render')
  if (/\bsquare\b/.test(button)) problems.push(`drawn square: ${button}`)
  if (/aria-label/.test(button)) problems.push(`named over its own content: ${button}`)
  if (problems.length) {
    console.error(`✗ CopyButton with a trigger snippet\n    ${problems.join('\n    ')}`)
    failed++
  }
}

// ── A tone and a treatment are two props ────────────────────────────────────
//
// `FJS-2943`. Read off the CLASS list: an undeclared prop lands on the element
// as an attribute, so `treatment="outlined"` matches a whole-html search while
// the button is drawn a plain primary.
{
  const BUTTONS = [
    ['forms/Button.mesa',      {},                                         'btn primary'],
    ['forms/Button.mesa',      { tone: 'danger' },                         'btn danger'],
    ['forms/Button.mesa',      { treatment: 'ghost' },                     'btn ghost'],
    ['forms/Button.mesa',      { tone: 'danger', treatment: 'outlined' },  'btn danger outlined'],
    ['display/CopyButton.mesa', { text: 'x', label: 'Copy' },              'btn ghost'],
    ['display/CopyButton.mesa', { text: 'x', label: 'Copy', treatment: 'outlined' }, 'btn outlined'],
  ]
  for (const [file, data, want] of BUTTONS) {
    const out = await renderComponent(readFileSync(join(ROOT, 'components', file), 'utf8'), {
      data, cwd: ROOT, filename: `components/${file}`, styleTag: false,
      tmpDir: join(ROOT, 'components', '.mesa-tmp'),
    })
    const tag = out.html.match(/<(?:button|a)\b[^>]*>/)?.[0] ?? ''
    const got = (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean).sort().join(' ')
    if (got !== want.split(' ').sort().join(' ')) {
      console.error(`✗ ${file} ${JSON.stringify(data)}\n    class "${got}", want "${want}"`)
      failed++
    }
  }
}

// ── Long category labels ────────────────────────────────────────────────────
//
// `FJS-2735`. formatX is the tick, the tooltip and the mark's accessible name,
// so a long category either collided with its neighbors on the axis or was
// shortened by the caller and shortened for assistive tech too. The tick fits
// its slot; the tooltip and the accessible name keep the whole label.
{
  const LONG = 'Final Details (cleaning pavement, closing fence gate, etc.)'
  const rows = [LONG, 'Prep', 'Framing', 'Roofing', 'Paint', 'Trim'].map((c, i) => ({ x: c, y: i + 2 }))
  const out = await renderComponent(readFileSync(join(ROOT, 'components/display/Chart.mesa'), 'utf8'), {
    data: { rows, x: 'x', y: 'y', width: 640, label: 'Hours by phase' },
    cwd: ROOT, filename: 'components/display/Chart.mesa', styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  const ticks = [...out.html.matchAll(/<text[^>]*text-anchor="middle"[^>]*fjs-chart-tick[^>]*>([^<]*)</g)].map(m => m[1])
  const problems = []
  if (!ticks.length) problems.push('no x ticks rendered')
  // ~6.5 units a character at the tick size, inside a 96-unit band.
  const over = ticks.filter(s => s.length * 6.5 > 96)
  if (over.length) problems.push(`tick wider than its slot: ${over.join(' | ')}`)
  if (ticks.includes(LONG)) problems.push('the long label was drawn whole on the axis')
  if (!out.html.includes(`aria-label="${LONG}: 2"`)) problems.push('the accessible name lost the full label')
  if (!out.html.includes(`${LONG}: 2</title>`)) problems.push('the <title> lost the full label')
  if (problems.length) {
    console.error(`✗ Chart with a long category label\n    ${problems.join('\n    ')}`)
    failed++
  }
}

// ── A caller's class lands on the outermost element Input draws ─────────────
//
// `FJS-1138`. Field takes `class` on its wrapper, so an Input with no label, no
// name, no hint and no message drew no wrapper and dropped the class.
{
  const HOST = (attrs) => `<script>
  import Input from './forms/Input.mesa'
</script>
<Input ${attrs} class="mine" />`
  const CLASS_ON = [
    ['bare',          '',                  /^<input\b[^>]*class="[^"]*\bmine\b/],
    ['reveal addon',  'type="password"',   /^<div\b[^>]*class="[^"]*\bfield-row\b[^"]*\bmine\b/],
    ['named',         'name="a"',          /^<div\b[^>]*class="[^"]*\bfield-group\b[^"]*\bmine\b/],
    ['labeled',       'label="L"',         /^<div\b[^>]*class="[^"]*\bfield-group\b[^"]*\bmine\b/],
  ]
  for (const [label, attrs, want] of CLASS_ON) {
    const out = await renderComponent(HOST(attrs), {
      data: {}, cwd: ROOT, filename: 'components/Host.mesa', styleTag: false,
      tmpDir: join(ROOT, 'components', '.mesa-tmp'),
    })
    const html = out.html.trim()
    if (!want.test(html) || (html.match(/\bmine\b/g) ?? []).length !== 1) {
      console.error(`✗ Input class (${label})\n    class "mine" must land once, on the outermost element: ${html.slice(0, 160)}`)
      failed++
    }
  }

  // `FJS-3268`. Textarea and Select wrap in a Field the same way, so the same
  // bare case drew the control with `class="field"` alone.
  const CLASS_ON_CONTROL = [
    ['Textarea', 'textarea', 'Textarea'],
    ['Select',   'select',   'Select'],
  ]
  for (const [comp, tag] of CLASS_ON_CONTROL) {
    for (const [label, attrs, want] of [
      ['bare',    '',           new RegExp(`^<${tag}\\b[^>]*class="[^"]*\\bmine\\b`)],
      ['named',   'name="a"',   /^<div\b[^>]*class="[^"]*\bfield-group\b[^"]*\bmine\b/],
      ['labeled', 'label="L"',  /^<div\b[^>]*class="[^"]*\bfield-group\b[^"]*\bmine\b/],
    ]) {
      const src = `<script>
  import ${comp} from './forms/${comp}.mesa'
</script>
<${comp} ${attrs} class="mine" />`
      const out = await renderComponent(src, {
        data: {}, cwd: ROOT, filename: 'components/Host.mesa', styleTag: false,
        tmpDir: join(ROOT, 'components', '.mesa-tmp'),
      })
      const html = out.html.trim()
      if (!want.test(html) || (html.match(/\bmine\b/g) ?? []).length !== 1) {
        console.error(`✗ ${comp} class (${label})\n    class "mine" must land once, on the outermost element: ${html.slice(0, 160)}`)
        failed++
      }
    }
  }
}

const passed = CASES.length - failed
console.log(`${passed}/${CASES.length} render cases carry the @frontierjs/css vocabulary`)
if (failed) process.exit(1)
