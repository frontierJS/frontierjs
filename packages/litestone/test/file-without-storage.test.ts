// file-without-storage.test.ts — a File column on a client that installs no FileStorage.
//
// `FJS-1898` refused the first upload by name instead of about atomic operators.
// `FJS-D1549` then made that refusal a server's last resort: a client with a disk
// installs FileStorage itself, and one configured by nothing keeps the bytes
// beside the main database, under the directory a deploy keeps (`FJS-D493`). A
// browser has no disk and still refuses — `refuseFileWithoutStorage` and the
// `FJS-2908` notice are its path now, and `#host`'s `defaultFileStorage` is the switch.

import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { createClient, autoMigrate } from '../src/index.js'
import { ExternalRefPlugin } from '../src/plugins/external-ref.js'
import { FileStorage, FILES_ENV } from '../src/storage/index.js'
import { tempDir } from '../src/tmp-dirs.js'

const SCHEMA = `
  model Doc {
    id     Int    @id
    name   String
    resume File?
    photos File[]
  }
`

const upload = () => new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' })

/** On disk, so the default has a database directory to keep its files under. */
async function client(plugins: unknown[] = [], schema = SCHEMA) {
  const dir = tempDir('ls-file-default-')
  const db = await createClient({ schema, db: join(dir, 'app.db'), plugins } as any)
  await autoMigrate(db)
  return { db: db as any, sys: (db as any).asSystem(), dir }
}

const fileStore = (db: any) => db.$files ?? undefined

/** Stands in for an app's own store: one the app installs is the one that runs. */
class RecordingStore extends ExternalRefPlugin {
  fieldType = 'File'
  async serialize(value: any) { return { key: `k/${value.name}` } }
}

const ENV_BEFORE = Object.fromEntries(Object.values(FILES_ENV).map(n => [n, process.env[n]]))
afterEach(() => {
  for (const [n, v] of Object.entries(ENV_BEFORE)) v == null ? delete process.env[n] : process.env[n] = v
})

describe('a server client with a File column installs FileStorage itself (FJS-D1549)', () => {
  test('an upload lands under <database directory>/files', async () => {
    const { db, sys, dir } = await client()
    expect(fileStore(db)?.localRoot).toBe(join(dir, 'files'))
    const row = await sys.doc.create({ data: { id: 1, name: 'a', resume: upload(), photos: [upload()] } })
    const ref = (await sys.doc.findUnique({ where: { id: 1 }, select: { resume: { resolve: false } } })).resume
    expect(ref.provider).toBe('local')
    expect(ref.key).toMatch(/^Doc\/resume\/.+\.pdf$/)
    expect(existsSync(join(dir, 'files', ref.key))).toBe(true)
    expect(readdirSync(join(dir, 'files', 'Doc', 'photos'))).toHaveLength(1)
    // No public base is known to litestone, so the read has no address yet:
    // junction gives it one when it serves the directory (FJS-1504).
    expect(row.resume).toBeNull()
  })

  test('an update is stored the same way', async () => {
    const { sys, dir } = await client()
    await sys.doc.create({ data: { id: 1, name: 'b' } })
    await sys.doc.update({ where: { id: 1 }, data: { resume: upload() } })
    expect(readdirSync(join(dir, 'files', 'Doc', 'resume'))).toHaveLength(1)
  })

  test('a schema with no File column installs nothing', async () => {
    const { db } = await client([], 'model Note { id Int @id  body String }')
    expect(fileStore(db)).toBeUndefined()
  })

  test('a read-only client installs it too, so its reads resolve like the writer\'s', async () => {
    const dir = tempDir('ls-file-default-ro-')
    const writer = await createClient({ schema: SCHEMA, db: join(dir, 'app.db') } as any)
    await autoMigrate(writer)
    const reader = await createClient({ schema: SCHEMA, db: join(dir, 'app.db'), readOnly: true } as any)
    expect(fileStore(reader)?.localRoot).toBe(join(dir, 'files'))
  })

  test('an in-memory client keeps the store\'s own default, having no directory', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' } as any)
    expect(fileStore(db)?.localRoot).toBe(join(process.cwd(), 'storage'))
  })

  test('says nothing at build, since nothing is missing', async () => {
    const said: string[] = []
    const real = console.warn
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')) }
    try { await client([], 'model Cv { id Int @id  scan File? }') } finally { console.warn = real }
    expect(said.join('\n')).not.toContain('FileStorage')
  })
})

describe('the environment names what code leaves unsaid (FJS-D1549)', () => {
  test('FILES_PUBLIC_BASE gives a local read its address', async () => {
    process.env.FILES_PUBLIC_BASE = 'https://app.example/api/files'
    const { sys } = await client()
    const row = await sys.doc.create({ data: { id: 1, name: 'c', resume: upload() } })
    expect(row.resume).toMatch(/^https:\/\/app\.example\/api\/files\/Doc\/resume\/.+\.pdf$/)
  })

  test('FILES_PROVIDER names an object store, which then needs its keys', async () => {
    process.env.FILES_PROVIDER = 'r2'
    const err = await client().catch((e: any) => e)
    expect(err?.message).toContain("provider 'r2' needs accessKeyId")
  })

  test('an option passed in code wins over its name', async () => {
    process.env.FILES_PROVIDER = 'r2'
    const dir = tempDir('ls-file-default-code-')
    const store = FileStorage({ provider: 'local', localPath: join(dir, 'mine') })
    const { db } = await client([store])
    expect(fileStore(db)).toBe(store)
    expect(store.localRoot).toBe(join(dir, 'mine'))
  })
})

describe('a File column with a plugin that stores File', () => {
  test('the upload reaches the plugin and the column keeps its reference', async () => {
    const { sys } = await client([new RecordingStore()])
    const row = await sys.doc.create({ data: { name: 'e', resume: upload(), photos: [upload()] } })
    expect(row.resume).toEqual({ key: 'k/cv.pdf' })
    expect(row.photos).toEqual([{ key: 'k/cv.pdf' }])
  })

  // The plugin handed the validator its refs as JSON text, and the array-shape
  // check refused every File[] upload as "must be an array" (FJS-1899).
  test('a File[] upload passes the array-shape check', async () => {
    const { sys } = await client([new RecordingStore()])
    await sys.doc.create({ data: { id: 1, name: 'f' } })
    const row = await sys.doc.update({ where: { id: 1 }, data: { photos: [upload(), upload()] } })
    expect(row.photos).toHaveLength(2)
  })
})

// A File column kept any string written to it, so a reader trusting the column
// rendered a stranger's URL (FJS-2699). The default store refuses it as well.
describe('a string written to a File column under the default store', () => {
  test.each([
    ['an outside URL', 'https://evil.example/x.png'],
    ['a path', '/etc/passwd'],
  ])('%s is refused', async (_name, value) => {
    const { sys } = await client()
    const err = await sys.doc.create({ data: { name: 'g', resume: value } }).catch((e: any) => e)
    expect(err?.name).toBe('ValidationError')
    expect(err.message).toContain('resume: a File column takes bytes')
    expect(await sys.doc.count()).toBe(0)
  })

  test('an update is refused and the stored value stands', async () => {
    const { sys } = await client()
    await sys.doc.create({ data: { id: 1, name: 'h' } })
    const err = await sys.doc.update({ where: { id: 1 }, data: { resume: 'https://evil.example/x.png' } }).catch((e: any) => e)
    expect(err?.name).toBe('ValidationError')
    expect((await sys.doc.findUnique({ where: { id: 1 } })).resume).toBeNull()
  })

  test('a string inside a File[] is refused too', async () => {
    const { sys } = await client()
    const err = await sys.doc.create({ data: { name: 'i', photos: ['https://evil.example/x.png'] } }).catch((e: any) => e)
    expect(err?.message).toContain('photos')
    expect(await sys.doc.count()).toBe(0)
  })
})
