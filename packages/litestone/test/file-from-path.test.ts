// file-from-path.test.ts — a File column never reads a string off the disk.
//
// A string shaped like a path (`/x`, `./x`, `../x`, `~/x`) was taken as a file
// to upload and read with readFileSync, whoever was calling. Junction types a
// File column `any`, so a JSON body naming `/etc/hostname` stored the SERVER's
// file and answered its public URL (FJS-2061). `asSystem()` is no exception: a
// system import of untrusted rows carries the same `./x`. Uploading from disk
// is `fromPath(path)`, a wrapper only code can build.

import { describe, test, expect, afterAll } from 'bun:test'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage, fromPath } from '../src/storage/file-storage.js'
import { tempDir } from '../src/tmp-dirs.js'

const dir = tempDir('file-from-path')
const secret = join(dir, 'secret.txt')
writeFileSync(secret, 'server-only bytes')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model Photo {
        id       Int    @id
        name     String
        original File?
        @@allow(all, true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  const puts: Array<{ key: string, bytes: string }> = []
  files._provider = {
    async put(key: string, body: Uint8Array | Blob) { puts.push({ key, bytes: body instanceof Blob ? await body.text() : Buffer.from(body).toString() }) },
    async get() { return null },
    async delete() {},
  }
  return { db, puts }
}

describe('a string in a File column is never a path (FJS-2061)', () => {

  for (const path of [secret, `./${join('.', 'package.json')}`, '../package.json', '~/.bashrc']) {
    test(`a principal's create naming ${path.startsWith('/') ? 'an absolute path' : path} is refused, and nothing is read`, async () => {
      const { db, puts } = await client()
      await expect(db.$setAuth({ id: 7 }).photo.create({ data: { id: 1, name: 'x', original: path } }))
        .rejects.toThrow(/fromPath/)
      expect(puts).toEqual([])
      db.$close()
    })
  }

  test('asSystem() refuses it too — a system import of untrusted rows carries the same string', async () => {
    const { db, puts } = await client()
    await expect(db.asSystem().photo.create({ data: { id: 1, name: 'x', original: secret } }))
      .rejects.toThrow(/fromPath/)
    expect(puts).toEqual([])
    db.$close()
  })

  test('an update naming a path is refused the same way', async () => {
    const { db, puts } = await client()
    const sys = db.asSystem()
    await sys.photo.create({ data: { id: 1, name: 'x' } })
    await expect(sys.photo.update({ where: { id: 1 }, data: { original: secret } }))
      .rejects.toThrow(/fromPath/)
    expect(puts).toEqual([])
    db.$close()
  })

  test('fromPath(path) is how code uploads from disk', async () => {
    const { db, puts } = await client()
    const row = await db.asSystem().photo.create({ data: { id: 1, name: 'x', original: fromPath(secret) } })
    expect(puts.map(p => p.bytes)).toEqual(['server-only bytes'])
    expect(puts[0].key.endsWith('.txt')).toBe(true)
    expect(row.original.key).toBe(puts[0].key)
    db.$close()
  })

  test('a JSON body cannot spell the wrapper', async () => {
    const { db, puts } = await client()
    const forged = JSON.parse(JSON.stringify(fromPath(secret)))
    await expect(db.$setAuth({ id: 7 }).photo.create({ data: { id: 1, name: 'x', original: forged } }))
      .rejects.toThrow()
    expect(puts).toEqual([])
    db.$close()
  })
})

// An upload read whole costs its size again in heap, on top of the copies the
// transport already made, so four 40 MB photos took an API from 89 to 580 MB.
// Only the head is read, for the type; the rest goes to the provider as a Blob.
describe('a file reaches the provider without being read whole (FJS-3094)', () => {
  class Unreadable extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('read whole') }
    override bytes(): Promise<Uint8Array<ArrayBuffer>> { throw new Error('read whole') }
    override text(): Promise<string> { throw new Error('read whole') }
  }

  async function onDisk() {
    const root = join(dir, `store-${crypto.randomUUID()}`)
    const db: any = await createClient({
      schema: `
        model Photo {
          id       Int    @id
          original File?
          @@allow(all, true)
        }
      `,
      db: ':memory:', plugins: [FileStorage({ provider: 'local', bucket: 'test', localPath: root, publicBase: 'https://cdn.test' })],
    })
    await autoMigrate(db)
    return { db, root }
  }

  test('a Blob is written to the local store with only its head read, and its type sniffed from that head', async () => {
    const { db, root } = await onDisk()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(100_000).fill(7)])
    const row = await db.asSystem().photo.create({ data: { id: 1, original: new Unreadable([png], { type: 'text/plain' }) } })
    expect(row.original.mime).toBe('image/png')
    expect(row.original.size).toBe(png.length)
    expect(new Uint8Array(await Bun.file(join(root, row.original.key)).arrayBuffer())).toEqual(png)
    db.$close()
  })

  test('fromPath hands the provider the file, not its bytes', async () => {
    const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
    const db: any = await createClient({
      schema: `model Photo {\n id Int @id\n original File?\n @@allow(all, true)\n}`,
      db: ':memory:', plugins: [files],
    })
    await autoMigrate(db)
    const bodies: unknown[] = []
    files._provider = { async put(_key: string, body: unknown) { bodies.push(body) }, async get() { return null }, async delete() {} }
    const row = await db.asSystem().photo.create({ data: { id: 1, original: fromPath(secret) } })
    expect(bodies[0]).toBeInstanceOf(Blob)
    expect(row.original.size).toBe('server-only bytes'.length)
    db.$close()
  })
})
