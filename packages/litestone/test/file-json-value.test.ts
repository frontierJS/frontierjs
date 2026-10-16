// file-json-value.test.ts — a caller over JSON or /mcp supplies a File column.
//
// JSON has no bytes, and the only value a File column took over it was a
// server path (FJS-2061, closed). The create tool's schema described the
// STORED ref, which the ORM refuses as an object, so no upload flow ran through
// an app's own agent (FJS-2062). FJS-D666: the bytes go inline, as a base64
// data URL or `{ name, type, data }`, and the server stays the ref's only author.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate, parse } from '../src/index.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { FileStorage } from '../src/storage/file-storage.js'

// The first bytes of a PNG and of a PDF: what `sniff` recognizes.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n')

const SCHEMA = `
  model Photo {
    id       Int    @id
    original File?  @accept("image/*")
    extras   File[]
    @@allow('all', true)
  }
`

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [files] })
  await autoMigrate(db)
  const puts: Array<{ key: string, bytes: Buffer, type: string }> = []
  files._provider = {
    async put(key: string, bytes: Uint8Array, { contentType }: { contentType: string }) { puts.push({ key, bytes: Buffer.from(bytes), type: contentType }) },
    async get() { return null },
    async delete() {},
  }
  return { db, puts, user: db.$setAuth({ id: 7 }) }
}

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`
const stored  = async (db: any, id: number) => JSON.parse(db.$db.query('SELECT original FROM "Photo" WHERE id = ?').get(id).original ?? 'null')

describe('a File column takes its bytes inline over JSON (FJS-D666)', () => {

  test('a principal\'s create with a data URL stores the bytes and writes the ref', async () => {
    const { db, puts, user } = await client()
    await user.photo.create({ data: { id: 1, original: dataUrl('image/png', PNG) } })
    expect(puts).toHaveLength(1)
    expect(puts[0].bytes.equals(PNG)).toBe(true)
    expect(puts[0].type).toBe('image/png')
    expect(puts[0].key.endsWith('.png')).toBe(true)
    const ref = await stored(db, 1)
    expect(ref.key).toBe(puts[0].key)
    expect(ref.size).toBe(PNG.length)
    db.$close()
  })

  test('{ name, type, data } is the same value with a name, kept for a download', async () => {
    const { db, puts, user } = await client()
    await user.photo.create({ data: { id: 1, original: { name: 'beach.png', type: 'image/png', data: PNG.toString('base64') } } })
    expect(puts[0].bytes.equals(PNG)).toBe(true)
    expect((await stored(db, 1)).name).toBe('beach.png')
    db.$close()
  })

  test('the name is the sender\'s string: a path in it is not kept', async () => {
    const { db, user } = await client()
    await user.photo.create({ data: { id: 1, original: { name: '../../etc/x.png', data: PNG.toString('base64') } } })
    expect((await stored(db, 1)).name).toBe('x.png')
    db.$close()
  })

  test('the bytes are graded, not the claim: a PDF called image/png is refused by @accept', async () => {
    const { db, puts, user } = await client()
    await expect(user.photo.create({ data: { id: 1, original: dataUrl('image/png', PDF) } }))
      .rejects.toThrow(/not allowed — accepted: image\/\*/)
    expect(puts).toEqual([])
    db.$close()
  })

  test('an update takes the same value', async () => {
    const { db, puts, user } = await client()
    await user.photo.create({ data: { id: 1 } })
    await user.photo.update({ where: { id: 1 }, data: { original: { type: 'image/png', data: PNG.toString('base64') } } })
    expect(puts).toHaveLength(1)
    expect((await stored(db, 1)).key).toBe(puts[0].key)
    db.$close()
  })

  test('a File[] takes it per item', async () => {
    const { db, puts, user } = await client()
    await user.photo.create({ data: { id: 1, extras: [dataUrl('image/png', PNG), { name: 'b.pdf', data: PDF.toString('base64') }] } })
    expect(puts.map(p => p.type)).toEqual(['image/png', 'application/pdf'])
    db.$close()
  })

  for (const [what, value, message] of [
    ['data that is not base64',           { data: 'not base64 at all!' },             /not base64/],
    ['a data URL that is not base64',     'data:text/plain,hello',                    /base64 only/],
    ['a data URL whose data is mangled',  'data:image/png;base64,iVBOR*w0K',          /not base64/],
  ] as const) {
    test(`${what} is refused, and nothing is stored`, async () => {
      const { db, puts, user } = await client()
      await expect(user.photo.create({ data: { id: 1, original: value } })).rejects.toThrow(message)
      expect(puts).toEqual([])
      db.$close()
    })
  }

  test('a stored ref sent by a caller is refused by what a File column takes, not by atomic operators', async () => {
    const { db, puts, user } = await client()
    const ref = { key: 'Photo/original/someone-elses.png', bucket: 'test', provider: 'local', size: 1, mime: 'image/png', uploadedAt: new Date().toISOString() }
    const err = await user.photo.create({ data: { id: 1, original: ref } }).catch((e: Error) => e)
    expect(String(err?.message ?? err)).toMatch(/is a File column[\s\S]*data:<type>;base64/)
    expect(String(err?.message ?? err)).not.toMatch(/atomic operators/)
    expect(puts).toEqual([])
    db.$close()
  })

  // The same ref as JSON text named another row's key, and this row's delete
  // or replace then removed that row's file from the provider (FJS-3114).
  test('a stored ref sent as JSON text is refused on create and on update', async () => {
    const { db, puts, user } = await client()
    const ref = JSON.stringify({ key: 'Photo/original/someone-elses.png', bucket: 'test', provider: 'local', size: 1, mime: 'image/png', uploadedAt: new Date().toISOString() })
    await expect(user.photo.create({ data: { id: 1, original: ref } })).rejects.toThrow(/is a File column[\s\S]*data:<type>;base64/)
    await user.photo.create({ data: { id: 2 } })
    await expect(user.photo.update({ where: { id: 2 }, data: { original: ` ${ref}` } })).rejects.toThrow(/is a File column/)
    expect(await stored(db, 2)).toBe(null)
    expect(puts).toEqual([])
    db.$close()
  })

  test('the server writes a ref as JSON text, as asSystem()', async () => {
    const { db } = await client()
    const ref = JSON.stringify({ key: 'Photo/original/restored.png', bucket: 'test' })
    await db.asSystem().photo.create({ data: { id: 1, original: ref } })
    expect((await stored(db, 1)).key).toBe('Photo/original/restored.png')
    db.$close()
  })

  test('an object with keys beyond name, type and data is not read as a file', async () => {
    const { db, puts, user } = await client()
    await expect(user.photo.create({ data: { id: 1, original: { data: PNG.toString('base64'), key: 'x' } } }))
      .rejects.toThrow(/is a File column/)
    expect(puts).toEqual([])
    db.$close()
  })
})

describe('the schema a writer reads describes what it sends (FJS-2062)', () => {
  const ast = parse(SCHEMA).schema
  const at  = (mode: string) => generateJsonSchema(ast, { mode }) as any

  for (const mode of ['create', 'update']) {
    test(`${mode}: a File column and a File[]'s items are FileInput`, () => {
      const doc   = at(mode)
      const props = doc.$defs.Photo.properties
      expect(JSON.stringify(props.original)).toContain('#/$defs/FileInput')
      expect(props.extras.items).toEqual({ $ref: '#/$defs/FileInput' })
      expect(doc.$defs.FileInput['x-litestone-file']).toBe(true)
      expect(doc.$defs.FileInput.oneOf.map((o: any) => o.type)).toEqual(['string', 'object'])
    })
  }

  test('full: a read is still the stored FileRef, and FileInput is not emitted', () => {
    const doc = at('full')
    expect(JSON.stringify(doc.$defs.Photo.properties.original)).toContain('#/$defs/FileRef')
    expect(doc.$defs.Photo.properties.extras.items).toEqual({ $ref: '#/$defs/FileRef' })
    expect(doc.$defs.FileInput).toBeUndefined()
  })
})
