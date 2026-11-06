// file-from-path.test.ts — a File column never reads a string off the disk.
//
// A string shaped like a path (`/x`, `./x`, `../x`, `~/x`) was taken as a file
// to upload and read with readFileSync, whoever was calling. Junction types a
// File column `any`, so a JSON body naming `/etc/hostname` stored the SERVER's
// file and answered its public URL (FJS-2061). `asSystem()` is no exception: a
// system import of untrusted rows carries the same `./x`. Uploading from disk
// is `fromPath(path)`, a wrapper only code can build.

import { describe, test, expect, afterAll } from 'bun:test'
import { writeFileSync, rmSync, statSync, existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
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
    async put(key: string, body: Uint8Array | Blob | ReadableStream) { puts.push({ key, bytes: body instanceof Uint8Array ? Buffer.from(body).toString() : await new Response(body).text() }) },
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
    const row = await db.asSystem().photo.create({ data: { id: 1, name: 'x', original: fromPath(secret) }, select: { original: { resolve: false } } })
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
    const row = await db.asSystem().photo.create({ data: { id: 1, original: new Unreadable([png], { type: 'text/plain' }) }, select: { original: { resolve: false } } })
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
    files._provider = { async put(_key: string, body: unknown) { bodies.push(body); await new Response(body as any).arrayBuffer() }, async get() { return null }, async delete() {} }
    const row = await db.asSystem().photo.create({ data: { id: 1, original: fromPath(secret) }, select: { original: { resolve: false } } })
    expect(bodies[0]).toBeInstanceOf(ReadableStream)
    expect(row.original.size).toBe('server-only bytes'.length)
    db.$close()
  })
})

// A resumed upload is assembled on the server's disk and handed over at the
// end. Copying it is its size read and written again; on the same filesystem
// the last step is one read (the hash) and a rename (FJS-3971).
describe('fromPath(path, { move: true }) adopts the file (FJS-3971)', () => {
  async function onDisk() {
    const root = join(dir, `adopt-${crypto.randomUUID()}`)
    const db: any = await createClient({
      schema: `model Photo {\n id Int @id\n original File?\n @@allow(all, true)\n}`,
      db: ':memory:', plugins: [FileStorage({ provider: 'local', bucket: 'test', localPath: root, publicBase: 'https://cdn.test' })],
    })
    await autoMigrate(db)
    return { db, root }
  }

  test('the source is renamed into the store: same inode, source gone, hash and size recorded', async () => {
    const { db, root } = await onDisk()
    const part = join(dir, `${crypto.randomUUID()}.part.txt`)
    writeFileSync(part, 'assembled bytes')
    const inode = statSync(part).ino
    const row = await db.asSystem().photo.create({ data: { id: 1, original: fromPath(part, { move: true }) }, select: { original: { resolve: false } } })
    expect(existsSync(part)).toBe(false)
    expect(statSync(join(root, row.original.key)).ino).toBe(inode)
    expect(readFileSync(join(root, row.original.key), 'utf8')).toBe('assembled bytes')
    expect(row.original.size).toBe('assembled bytes'.length)
    expect(row.original.sha256).toBe(createHash('sha256').update('assembled bytes').digest('hex'))
    db.$close()
  })

  test('without move the source stays and the store holds a copy', async () => {
    const { db, root } = await onDisk()
    const part = join(dir, `${crypto.randomUUID()}.txt`)
    writeFileSync(part, 'kept')
    const row = await db.asSystem().photo.create({ data: { id: 1, original: fromPath(part) }, select: { original: { resolve: false } } })
    expect(existsSync(part)).toBe(true)
    expect(statSync(join(root, row.original.key)).ino).not.toBe(statSync(part).ino)
    db.$close()
  })

  test('a refused type leaves the source where it was', async () => {
    const root = join(dir, `adopt-${crypto.randomUUID()}`)
    const db: any = await createClient({
      schema: `model Photo {\n id Int @id\n original File? @accept("image/png")\n @@allow(all, true)\n}`,
      db: ':memory:', plugins: [FileStorage({ provider: 'local', bucket: 'test', localPath: root })],
    })
    await autoMigrate(db)
    const part = join(dir, `${crypto.randomUUID()}.txt`)
    writeFileSync(part, 'not a png')
    await expect(db.asSystem().photo.create({ data: { id: 1, original: fromPath(part, { move: true }) } })).rejects.toThrow()
    expect(existsSync(part)).toBe(true)
    db.$close()
  })

  test('a provider with no adopt stores the bytes, then removes the source', async () => {
    const files = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const db: any = await createClient({
      schema: `model Photo {\n id Int @id\n original File?\n @@allow(all, true)\n}`,
      db: ':memory:', plugins: [files],
    })
    await autoMigrate(db)
    const got: string[] = []
    files._provider = { async put(_k: string, body: any) { got.push(await new Response(body).text()) }, async get() { return null }, async delete() {} }
    const part = join(dir, `${crypto.randomUUID()}.txt`)
    writeFileSync(part, 'remote bytes')
    await db.asSystem().photo.create({ data: { id: 1, original: fromPath(part, { move: true }) } })
    expect(got).toEqual(['remote bytes'])
    expect(existsSync(part)).toBe(false)
    db.$close()
  })
})

// An upload assembled as <id>.part and adopted by path is stored under that
// temp name unless the app, which has the handshake's name and type, says
// otherwise (FJS-3972).
describe('fromPath(path, { name, type, size }) states what the sender said', () => {
  const part = join(dir, 'abc123.part.bin')
  const bytes = Buffer.from('hello from a phone')
  writeFileSync(part, bytes)

  async function withStore() {
    const root = join(dir, `store-${crypto.randomUUID()}`)
    const db: any = await createClient({
      schema: `model Photo {\n id Int @id\n original File?\n @@allow(all, true)\n}`,
      db: ':memory:', plugins: [FileStorage({ provider: 'local', bucket: 'test', localPath: root, publicBase: 'https://cdn.test' })],
    })
    await autoMigrate(db)
    return db
  }
  const make = (db: any, original: unknown) =>
    db.asSystem().photo.create({ data: { id: 1, original }, select: { original: { resolve: false } } })

  test('name is kept on the ref and type is the claim sniffing falls back to', async () => {
    const db = await withStore()
    const row = await make(db, fromPath(part, { name: 'IMG_0042', type: 'text/plain' }))
    expect(row.original.name).toBe('IMG_0042')
    expect(row.original.mime).toBe('text/plain')
    expect(row.original.key.endsWith('.txt')).toBe(true)
    db.$close()
  })

  test('without an override the file keeps its own name', async () => {
    const db = await withStore()
    const row = await make(db, fromPath(part))
    expect(row.original.name).toBe('abc123.part.bin')
    db.$close()
  })

  test('a stated size that disagrees with the file is refused, and a move keeps the file where it was', async () => {
    const db = await withStore()
    const mine = join(dir, 'moveme.bin')
    writeFileSync(mine, bytes)
    await expect(make(db, fromPath(mine, { move: true, size: bytes.length + 1 }))).rejects.toThrow(/size/)
    expect(existsSync(mine)).toBe(true)
    const row = await make(db, fromPath(part, { size: bytes.length }))
    expect(row.original.size).toBe(bytes.length)
    db.$close()
  })

  test('a malformed size is refused at construction, as fromStream refuses it', () => {
    expect(() => fromPath(part, { size: -1 })).toThrow(/size/)
  })
})
