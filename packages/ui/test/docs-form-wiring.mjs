/*
 * docs-form-wiring.mjs
 * A <Form> example in the docs never shows a named control with nothing writing it back.
 *
 * Inside a <Form> a control resolves its label, rules and error from the
 * schema, but the RECORD is written only by the generated form or by a
 * callback the control is handed (`FJS-1135`). A hand-written example with a
 * bare `<Input name="email" />` shows the typing and submits the seed — and it
 * is the first shape a reader copies.
 *
 * So each `<Form ...>` … `</Form>` span in README.md and in the forms/ headers
 * is scanned, and every control carrying `name=` must also carry a callback
 * (`oninput`, `onchange`, `onvalue`). A `bind:` does not count: it writes the
 * caller's local, and the record is a different object. A span holding no
 * named control (a generated form) passes; a pair of controls proves the check
 * refuses the bare shape and accepts the wired one.
 *
 * Run: node test/docs-form-wiring.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const CONTROL = /<(Input|Textarea|Select|Checkbox|Switch|RadioGroup|Combobox|MultiSelect|NumberInput|Slider|MoneyInput|DateTimeInput|JsonInput|GeoField)\b[^>]*?\bname=[^>]*>/g
const WIRED   = /\b(oninput|onchange|onvalue)=/

export function unwired(text) {
  const found = []
  for (const span of text.matchAll(/<Form\b[\s\S]*?<\/Form>/g))
    for (const c of span[0].matchAll(CONTROL))
      if (!WIRED.test(c[0])) found.push(c[0].trim())
  return found
}

const files = [
  'README.md',
  ...readdirSync(join(ROOT, 'components/forms')).filter(f => f.endsWith('.mesa')).map(f => 'components/forms/' + f),
]

const failures = []
for (const f of files)
  for (const c of unwired(readFileSync(join(ROOT, f), 'utf8')))
    failures.push(`${f}: ${c} — inside <Form> nothing writes this control's value to the record`)

if (!unwired('<Form {r}>\n<Input name="email" />\n</Form>').length) failures.push('control: a bare named <Input> was accepted')
if (unwired('<Form {r}>\n<Input name="email" value={d.email} oninput={w} />\n</Form>').length) failures.push('control: a wired <Input> was refused')

if (failures.length) {
  console.error(`✗ docs-form-wiring — ${failures.length} failure(s)`)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`✓ docs-form-wiring — ${files.length} files, every named control in a <Form> example is wired`)
