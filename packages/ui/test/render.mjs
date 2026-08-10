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
  ['components/forms/Button.mesa',      { variant: 'danger' },       ['btn', 'danger']],
  ['components/forms/Button.mesa',      { variant: 'outlined' },     ['btn', 'outlined']],
  ['components/forms/Input.mesa',       { label: 'Email' },          ['field-group', 'field']],
  ['components/forms/Input.mesa',       { label: 'Email', error: 'Taken' }, ['field-group', 'danger']],
  ['components/forms/Select.mesa',      { options: ['a'] },          ['field']],
  ['components/forms/Textarea.mesa',    {},                          ['field']],
  ['components/forms/Checkbox.mesa',    { label: 'Yes' },            ['field-check']],
  ['components/forms/Switch.mesa',      { label: 'On' },             ['field-check', 'switch']],
  ['components/display/Badge.mesa',     { tone: 'success' },         ['badge', 'success']],
  ['components/display/Pill.mesa',      { tone: 'warning' },         ['pill', 'warning']],
  ['components/display/Tag.mesa',       {},                          ['pill', 'removable', 'pill-close']],
  ['components/display/Stat.mesa',      { label: 'MRR', value: '1' }, ['tile-label', 'tile-value']],
  ['components/display/EmptyState.mesa',{ title: 'None' },           ['empty', 'empty-title']],
  ['components/display/Breadcrumbs.mesa', { items: [{ label: 'Home' }] }, ['breadcrumb']],
  ['components/display/Table.mesa',     { columns: [{ key: 'a', label: 'A' }] }, ['table', 'table-wrap']],
  ['components/display/Kbd.mesa',       {},                          ['kbd']],
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
  ['components/overlay/DropdownLabel.mesa', {},                      ['navlist-label']],
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

  const missing = expected.filter(c => !new RegExp(`\\b${c}\\b`).test(html))
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

const passed = CASES.length - failed
console.log(`${passed}/${CASES.length} render cases carry the @frontierjs/css vocabulary`)
if (failed) process.exit(1)
