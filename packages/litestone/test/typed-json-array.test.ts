// `Json @type(T[])` -- a column holding a LIST of typed records (`FJS-3069`).
// Without it the list was unchecked Json, and the one guard a type member has
// (a validator on a member) could not reach the elements.

import { describe, it, expect } from 'bun:test'
import { createClient, generateJsonSchema, parse } from '../src/index.js'
import { generateTypeScript } from '../src/tools/typegen.js'

const SCHEMA = `
type Field {
  name  String @length(1, 40)
  value String @default("")
  kind  Int    @default(0)
}
model Cipher {
  id     Int @id
  title  String
  fields Json @type(Field[])
  maybe  Json? @type(Field[])
}
`

describe('Json @type(T[])', () => {
  it('parses', () => {
    const { schema } = parse(SCHEMA)
    const attr = schema.models[0].fields.find((f: any) => f.name === 'fields').attributes.find((a: any) => a.kind === 'type')
    expect(attr.name).toBe('Field')
    expect(attr.array).toBe(true)
  })

  it('accepts a list of the type and fills member defaults on each element', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.cipher.create({ data: { title: 'a', fields: [{ name: 'x' }, { name: 'y', value: 'v' }] } })
    expect(row.fields).toEqual([{ name: 'x', value: '', kind: 0 }, { name: 'y', value: 'v', kind: 0 }])
    expect((await db.cipher.create({ data: { title: 'b', fields: [] } })).fields).toEqual([])
  })

  it('refuses an element that breaks the type, naming its index', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const err: any = await db.cipher.create({ data: { title: 'a', fields: [{ name: 'ok' }, { name: '' }] } }).catch((e: any) => e)
    expect(err.name).toBe('ValidationError')
    expect(JSON.stringify(err.errors ?? err.issues ?? err.message)).toContain('1')
    const unknown: any = await db.cipher.create({ data: { title: 'a', fields: [{ name: 'ok', extra: 1 }] } }).catch((e: any) => e)
    expect(unknown.name).toBe('ValidationError')
  })

  it('refuses a value that is not a list', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const err: any = await db.cipher.create({ data: { title: 'a', fields: { name: 'x' } } }).catch((e: any) => e)
    expect(err.name).toBe('ValidationError')
    const scalar: any = await db.cipher.create({ data: { title: 'a', fields: ['x'] } }).catch((e: any) => e)
    expect(scalar.name).toBe('ValidationError')
  })

  it('accepts null on an optional column', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.cipher.create({ data: { title: 'a', fields: [], maybe: null } })
    expect(row.maybe).toBeNull()
  })

  it('is an array of the type in JSON Schema and in generated types', () => {
    const js: any = generateJsonSchema(parse(SCHEMA).schema)
    const prop = JSON.stringify(js)
    expect(prop).toContain('"type":"array"')
    expect(prop).toContain('#/$defs/Field')
    const ts = generateTypeScript(parse(SCHEMA).schema)
    expect(ts).toMatch(/fields: Field\[\]/)
  })

  it('refuses an unknown type name at parse', () => {
    expect(parse(`model M { id Int @id\n x Json @type(Nope[]) }`).errors.join(' ')).toMatch(/unknown type 'Nope'/)
  })
})

describe('Json @type(T[]) at the edges', () => {
  it('refuses a where path and a $merge by name rather than matching nothing', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.cipher.create({ data: { title: 'a', fields: [{ name: 'x' }] } })
    await expect(db.cipher.findMany({ where: { fields: { name: 'x' } } })).rejects.toThrow(/a list of them/)
    await expect(db.cipher.update({ where: { id: row.id }, data: { fields: { $merge: { name: 'y' } } } })).rejects.toThrow(/list/)
  })

  it('replaces the whole list on update and grades it', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.cipher.create({ data: { title: 'a', fields: [{ name: 'x' }] } })
    const next = await db.cipher.update({ where: { id: row.id }, data: { fields: [{ name: 'z' }] } })
    expect(next.fields).toEqual([{ name: 'z', value: '', kind: 0 }])
    await expect(db.cipher.update({ where: { id: row.id }, data: { fields: [{ name: '' }] } })).rejects.toThrow()
  })

  it('refuses @point on a list of a type', () => {
    const { errors } = parse(`type P { lat Float\n lng Float }\nmodel M { id Int @id\n at Json @type(P[]) @point(lat, lng) }`)
    expect(errors.join(' ')).toMatch(/list/)
  })
})
