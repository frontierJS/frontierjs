// A backslash escape in a schema string is an escape, not "keep the next
// character" (`FJS-2670`): `@default("a\nb")` stores a newline, so a
// multi-line default can be written.

import { describe, it, expect } from 'bun:test'
import { createClient, parse } from '../src/index.js'

const SCHEMA = String.raw`
model Note {
  id    Int    @id
  body  String @default("a\nb\tc\r\n\"q\" \\ \x")
}
`

describe('string escapes in a schema', () => {
  it('takes \\n \\t \\r as the control character, and \\" \\\\ as themselves', () => {
    const { schema } = parse(SCHEMA)
    const attr = schema.models[0].fields[1].attributes.find((a: any) => a.kind === 'default')
    expect(attr.value.value).toBe('a\nb\tc\r\n"q" \\ x')
  })

  it('writes the multi-line default into the column', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.note.create({ data: {} })
    expect(row.body).toBe('a\nb\tc\r\n"q" \\ x')
  })
})

// A template takes the same escapes (`FJS-2837`): `\n` in a @generated template is a newline.
describe('template escapes in @generated', () => {
  it('puts a newline between the fields', async () => {
    const db = await createClient({
      db: ':memory:',
      schema: String.raw`
model Card {
  id    Int    @id
  line1 String
  line2 String
  block String @generated(` + '`{line1}\\n{line2}`' + String.raw`)
}
`,
    })
    const row = await db.card.create({ data: { line1: 'a', line2: 'b' } })
    expect(row.block).toBe('a\nb')
  })
})
