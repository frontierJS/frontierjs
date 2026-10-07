// file-without-storage.test.ts — a File column on a client with no FileStorage.
//
// `FJS-1898`. `fli new`'s `db.ts` installs the gate and nothing else, so the
// first upload into a `File?` column was refused about atomic operators — a
// message that names neither the column's type nor the plugin missing — and a
// `File[]` was not refused at all: it went down the Json path and stored `[{}]`.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { ExternalRefPlugin } from '../src/plugins/external-ref.js'

const SCHEMA = `
  model Doc {
    id     Int    @id
    name   String
    resume File?
    photos File[]
  }
`

const upload = () => new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' })

async function client(plugins: unknown[] = []) {
  const db = await createClient({ schema: SCHEMA, db: ':memory:', plugins } as any)
  await autoMigrate(db)
  return (db as any).asSystem()
}

/** Stands in for FileStorage: whatever stores a `File` is what lifts the refusal. */
class RecordingStore extends ExternalRefPlugin {
  fieldType = 'File'
  async serialize(value: any) { return { key: `k/${value.name}` } }
}

describe('a File column with no FileStorage installed', () => {
  test('a single File is refused naming FileStorage', async () => {
    const sys = await client()
    const err = await sys.doc.create({ data: { name: 'a', resume: upload() } }).catch((e: any) => e)
    expect(err?.name).toBe('ValidationError')
    expect(err.message).toContain('resume is a File column')
    expect(err.message).toContain('FileStorage')
    expect(err.message).not.toContain('atomic operators')
  })

  test('a File[] is refused rather than stored as [{}]', async () => {
    const sys = await client()
    const err = await sys.doc.create({ data: { name: 'b', photos: [upload()] } }).catch((e: any) => e)
    expect(err?.name).toBe('ValidationError')
    expect(err.message).toContain('photos is a File column')
    expect(await sys.doc.count()).toBe(0)
  })

  test('an update is refused the same way', async () => {
    const sys = await client()
    await sys.doc.create({ data: { id: 1, name: 'c' } })
    const err = await sys.doc.update({ where: { id: 1 }, data: { resume: upload() } }).catch((e: any) => e)
    expect(err?.message).toContain('FileStorage')
  })

  test('a row that leaves its File columns empty still writes', async () => {
    const sys = await client()
    const row = await sys.doc.create({ data: { name: 'd', resume: null } })
    expect(row.resume).toBeNull()
  })
})

describe('a File column with a plugin that stores File', () => {
  test('the upload reaches the plugin and the column keeps its reference', async () => {
    const sys = await client([new RecordingStore()])
    const row = await sys.doc.create({ data: { name: 'e', resume: upload(), photos: [upload()] } })
    expect(JSON.parse(row.resume)).toEqual({ key: 'k/cv.pdf' })
    expect(row.photos).toEqual([{ key: 'k/cv.pdf' }])
  })

  // The plugin handed the validator its refs as JSON text, and the array-shape
  // check refused every File[] upload as "must be an array" (FJS-1899).
  test('a File[] upload passes the array-shape check', async () => {
    const sys = await client([new RecordingStore()])
    await sys.doc.create({ data: { id: 1, name: 'f' } })
    const row = await sys.doc.update({ where: { id: 1 }, data: { photos: [upload(), upload()] } })
    expect(row.photos).toHaveLength(2)
  })
})
