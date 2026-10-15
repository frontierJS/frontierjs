/*
 * filter-bar-key.mjs
 * A declared custom field is filtered through the column its slot generated
 * (`FJS-1735`): the filter's `name` is `fields.severity` and its `queryKey` is
 * `t1`, which is the only key the Data boundary takes a where on. A bar that
 * reads the query under `name` shows an empty box over a filtered list.
 *
 * Run: node test/filter-bar-key.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const slotted = { name: 'fields.severity', label: 'Severity', op: 'contains', kind: 'text', display: 'text', queryKey: 't1' }
const plain   = { name: 'title', label: 'Title', op: 'contains', kind: 'text', display: 'text' }

async function render(data) {
  const out = await renderComponent(readFileSync(join(ROOT, 'components/display/FilterBar.mesa'), 'utf8'), {
    data, cwd: ROOT, filename: 'components/display/FilterBar.mesa', styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  return out.html
}

let failed = 0
const check = (ok, label) => { if (!ok) { console.error(`✗ ${label}`); failed++ } }

// Clear is drawn only while a filter holds a value, and a server render does
// not print an input's value, so it is what says the bar found the query.
const active = (html) => /Clear/.test(html)

check(active(await render({ filters: [slotted], value: { t1: { contains: 'high' } } })),
  'a slotted filter reads the query held under its queryKey')
check(!active(await render({ filters: [slotted], value: { 'fields.severity': { contains: 'high' } } })),
  'and not one held under the column name, which the boundary refuses')
check(active(await render({ filters: [plain], value: { title: { contains: 'hi' } } })),
  'a filter with no queryKey still reads its column name')

console.log(failed ? `${failed} filter-bar-key case(s) failed` : '3/3 filter-bar-key cases hold')
if (failed) process.exit(1)
