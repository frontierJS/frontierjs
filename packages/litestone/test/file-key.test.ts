// file-key.test.ts — where a stored object lands (FJS-2098).
//
// A create's row has no id when the object is written, so a key naming `:id`
// filed every created object under `<Model>/new/`. The default names no id, and
// a pattern that does is refused where the plugin starts.

import { describe, test, expect } from 'bun:test'
import { parse }       from '../src/core/parser.js'
import { FileStorage } from '../src/storage/file-storage.js'

const SCHEMA = `
  model Batch {
    id   Int   @id
    body File?
  }
`

function plugin(config: Record<string, unknown> = {}) {
  const puts: string[] = []
  const p = FileStorage({ provider: 'local', publicBase: 'https://cdn.test', localPath: '/tmp', ...config }) as any
  const schema = parse(SCHEMA).schema
  p.onInit(schema, { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) })
  p._provider = {
    async put(key: string) { puts.push(key) },
    async get() { return null },
    async delete() {},
    async sign(key: string) { return `https://cdn.test/${key}` },
  }
  return { p, puts }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('the default key', () => {
  test('a create names no row id and a recognized Buffer gets its extension', async () => {
    const { p } = plugin()
    const ref = await p.serialize(Buffer.from(PNG), { field: 'body', model: 'Batch', id: undefined, ctx: {} })
    expect(ref.key).toMatch(/^Batch\/body\/[0-9a-f]{12}\.png$/)
    expect(ref.key).not.toContain('new')
  })

  test('an update keys the same way', async () => {
    const { p } = plugin()
    const ref = await p.serialize(Buffer.from(PNG), { field: 'body', model: 'Batch', id: 'upd', ctx: {} })
    expect(ref.key).toMatch(/^Batch\/body\/[0-9a-f]{12}\.png$/)
  })

  test('a pattern naming :id is refused at init, since a create has no id yet', () => {
    expect(() => plugin({ keyPattern: ':model/:id/:field/:uuid.:ext' })).toThrow(/:id/)
  })
})

// FJS-1997: the ref keeps the name the bytes arrived under. The key sanitizes
// to [a-z0-9_-], so a name served from it came back as Rechnung_M_rz_2026.pdf.
describe('the original filename', () => {
  const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])

  test('a File keeps its name on the ref, unsanitized', async () => {
    const { p } = plugin()
    const file = new File([PDF], 'Rechnung März 2026.pdf', { type: 'application/pdf' })
    const ref = await p.serialize(file, { field: 'body', model: 'Batch', id: undefined, ctx: {} })
    expect(ref.name).toBe('Rechnung März 2026.pdf')
  })

  test('a path in the name is dropped and control characters stripped', async () => {
    const { p } = plugin()
    const file = new File([PDF], '..\\..\\etc/pass\r\nwd\u0000.pdf', { type: 'application/pdf' })
    const ref = await p.serialize(file, { field: 'body', model: 'Batch', id: undefined, ctx: {} })
    expect(ref.name).toBe('passwd.pdf')
  })

  test('bytes with no name leave the ref without one', async () => {
    const { p } = plugin()
    const ref = await p.serialize(Buffer.from(PNG), { field: 'body', model: 'Batch', id: undefined, ctx: {} })
    expect('name' in ref).toBe(false)
  })

  test('fromPath keeps the file name of the path', async () => {
    const { p } = plugin()
    const { fromPath } = await import('../src/storage/file-storage.js')
    const dir = await import('node:fs').then(fs => fs.mkdtempSync('/tmp/fjs1997-'))
    await Bun.write(`${dir}/Übersicht Q3.pdf`, PDF)
    const ref = await p.serialize(fromPath(`${dir}/Übersicht Q3.pdf`), { field: 'body', model: 'Batch', id: undefined, ctx: {} })
    expect(ref.name).toBe('Übersicht Q3.pdf')
  })
})
