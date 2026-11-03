// file-from-stream.test.ts — a request body larger than memory reaches a File
// column as a stream (FJS-D1159, FJS-D1808), and @digest names the column that
// follows the hash of its bytes (FJS-D1292).
//
// The local provider writes to a real directory, so "stores nothing" and "no
// object left" are read off the disk. The S3 refusals are asserted before any
// request is made: a fetch that is attempted fails the test.

import { describe, test, expect, afterAll } from 'bun:test'
import { createHash } from 'crypto'
import { readdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage, fromStream } from '../src/storage/file-storage.js'
import { S3Provider } from '../src/storage/providers/s3.js'
import { tempDir } from '../src/tmp-dirs.js'

const root = tempDir('file-from-stream')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(20_000).map((_, i) => i % 251)])

/** A stream in `chunk`-byte pieces, so the head spans several reads. */
function streamOf(bytes: Uint8Array, chunk = 1000) {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close()
      c.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
  })
}

let n = 0
async function client(schemaBody = `file File? @accept("image/png")\n sha256 String?`) {
  const dir = join(root, `c${n++}`)
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test', localPath: dir }) as any
  const db: any = await createClient({
    schema: `model Doc {\n id Int @id\n ${schemaBody}\n @@allow(all, true)\n}`,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  const stored = () => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()) : [])
  return { db, files, dir, stored }
}
const raw = { file: { resolve: false } }

describe('fromStream', () => {
  test('stores the stream whole, sniffs the type from its head and hashes the bytes', async () => {
    const { db, dir, stored } = await client()
    const row = await db.asSystem().doc.create({
      data: { id: 1, file: fromStream(streamOf(png), { name: 'a.txt', type: 'text/plain', size: png.length }) }, select: raw,
    })
    expect(row.file.mime).toBe('image/png')
    expect(row.file.size).toBe(png.length)
    expect(row.file.sha256).toBe(sha(png))
    expect(new Uint8Array(readFileSync(join(dir, row.file.key)))).toEqual(png)
    expect(stored().length).toBe(1)
    db.$close()
  })

  test('a body shorter than the sniff head is stored, and a Node Readable is taken', async () => {
    const { db, dir } = await client(`file File?`)
    const small = new Uint8Array([1, 2, 3])
    const row = await db.asSystem().doc.create({ data: { id: 1, file: fromStream(Readable.from([Buffer.from(small)]), { name: 'x.bin' }) }, select: raw })
    expect(row.file.size).toBe(3)
    expect(new Uint8Array(readFileSync(join(dir, row.file.key)))).toEqual(small)
    db.$close()
  })

  test('an @accept refusal stores nothing and cancels the stream', async () => {
    const { db, stored } = await client()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`%PDF-1.7 ${'x'.repeat(5000)}`)) },
      cancel() { cancelled = true },
    })
    await expect(db.asSystem().doc.create({ data: { id: 1, file: fromStream(body, { type: 'image/png', size: 5009 }) } }))
      .rejects.toThrow(/not allowed/)
    expect(stored()).toEqual([])
    expect(cancelled).toBe(true)
    db.$close()
  })

  test('a count that disagrees with the stated size is refused and no object is left', async () => {
    const { db, stored } = await client()
    await expect(db.asSystem().doc.create({ data: { id: 1, file: fromStream(streamOf(png), { size: png.length + 1 }) } }))
      .rejects.toThrow(/disagree with its stated size/)
    expect(stored()).toEqual([])
    await expect(db.asSystem().doc.create({ data: { id: 2, file: fromStream(streamOf(png), { size: png.length - 1 }) } }))
      .rejects.toThrow(/disagree with its stated size/)
    expect(stored()).toEqual([])
    db.$close()
  })

  test('a stream that fails part-way leaves no object', async () => {
    const { db, stored } = await client(`file File?`)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent++ < 3) c.enqueue(new Uint8Array(5000).fill(9)); else c.error(new Error('client went away')) },
    })
    await expect(db.asSystem().doc.create({ data: { id: 1, file: fromStream(body) } })).rejects.toThrow(/client went away/)
    expect(stored()).toEqual([])
    db.$close()
  })

  test('a value that is not a stream is refused when it is built', () => {
    expect(() => fromStream('bytes' as any)).toThrow(/ReadableStream/)
    expect(() => fromStream(streamOf(png), { size: -1 })).toThrow(/size/)
  })
})

describe('the S3 provider and a stream (FJS-D1808)', () => {
  const guard = () => {
    const real = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => { calls.push(String(url)); throw new Error('no network in this test') }) as any
    return { calls, restore: () => { globalThis.fetch = real } }
  }
  const provider = (endpoint: string) => new S3Provider({ provider: 'minio', bucket: 'b', endpoint, accessKeyId: 'k', secretAccessKey: 's' })

  test('a stream with no size is refused by name, before any request', async () => {
    const g = guard()
    try {
      await expect(provider('https://s3.example.com').put('k', streamOf(png), { contentType: 'image/png' }))
        .rejects.toThrow(/fromStream to provider minio needs size -- an S3 PUT carries Content-Length/)
      expect(g.calls).toEqual([])
    } finally { g.restore() }
  })

  test('a stream over plain http is refused by name, before any request', async () => {
    const g = guard()
    try {
      await expect(provider('http://localhost:9000').put('k', streamOf(png), { contentType: 'image/png', size: png.length }))
        .rejects.toThrow(/fromStream to provider minio needs https/)
      expect(g.calls).toEqual([])
    } finally { g.restore() }
  })

  test('with a size over https it is one PUT carrying Content-Length and an unsigned payload', async () => {
    const real = globalThis.fetch
    let seen: any
    globalThis.fetch = (async (_url: string, init: any) => { seen = init; await new Response(init.body).arrayBuffer(); return new Response('') }) as any
    try {
      await provider('https://s3.example.com').put('k', streamOf(png), { contentType: 'image/png', size: png.length })
      expect(seen.method).toBe('PUT')
      expect(seen.headers['content-length']).toBe(String(png.length))
      expect(seen.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    } finally { globalThis.fetch = real }
  })

  test('a File over plain http is still read whole and sent signed, with its hash -- only a stream is refused there', async () => {
    const real = globalThis.fetch
    let seen: any
    globalThis.fetch = (async (_url: string, init: any) => { seen = init; return new Response('') }) as any
    try {
      const files = FileStorage({ provider: 'minio', bucket: 'b', endpoint: 'http://localhost:9000', accessKeyId: 'k', secretAccessKey: 's' }) as any
      const db: any = await createClient({ schema: `model Doc {\n id Int @id\n file File?\n @@allow(all, true)\n}`, db: ':memory:', plugins: [files] })
      await autoMigrate(db)
      const row = await db.asSystem().doc.create({ data: { id: 1, file: new File([png], 'a.png', { type: 'image/png' }) }, select: { file: { resolve: false } } })
      expect(seen.headers['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD')
      expect(row.file.sha256).toBe(new Bun.CryptoHasher('sha256').update(png).digest('hex'))
      db.$close()
    } finally { globalThis.fetch = real }
  })

  test('through FileStorage a refusal before the first byte makes no delete request either', async () => {
    const g = guard()
    try {
      const files = FileStorage({ provider: 'minio', bucket: 'b', endpoint: 'https://s3.example.com', accessKeyId: 'k', secretAccessKey: 's' }) as any
      const db: any = await createClient({ schema: `model Doc {\n id Int @id\n file File?\n @@allow(all, true)\n}`, db: ':memory:', plugins: [files] })
      await autoMigrate(db)
      await expect(db.asSystem().doc.create({ data: { id: 1, file: fromStream(streamOf(png)) } })).rejects.toThrow(/needs size/)
      expect(g.calls).toEqual([])
      db.$close()
    } finally { g.restore() }
  })
})

describe('@digest (FJS-D1292)', () => {
  test('the sibling is filled from the bytes when the write leaves it out', async () => {
    const { db } = await client(`file File? @digest(sha256)\n sha256 String?`)
    const row = await db.asSystem().doc.create({ data: { id: 1, file: png }, select: { ...raw, sha256: true } })
    expect(row.sha256).toBe(sha(png))
    expect(row.file.sha256).toBe(sha(png))
    const next = new Uint8Array([...png, 1])
    const upd = await db.asSystem().doc.update({ where: { id: 1 }, data: { file: next }, select: { ...raw, sha256: true } })
    expect(upd.sha256).toBe(sha(next))
    db.$close()
  })

  test('a required sibling the write leaves out is filled, not reported missing', async () => {
    const { db } = await client(`file File @digest(sha256)\n sha256 String`)
    const row = await db.asSystem().doc.create({ data: { id: 1, file: fromStream(streamOf(png)) }, select: { sha256: true } })
    expect(row.sha256).toBe(sha(png))
    db.$close()
  })

  test('a sibling that agrees passes; one that disagrees is refused on the sibling, naming both columns', async () => {
    const { db, stored } = await client(`file File? @digest(sha256)\n sha256 String?`)
    await db.asSystem().doc.create({ data: { id: 1, file: png, sha256: sha(png) } })
    const err: any = await db.asSystem().doc.create({ data: { id: 2, file: png, sha256: 'ab'.repeat(32) } }).catch((e: any) => e)
    expect(err.name).toBe('ValidationError')
    expect(err.field).toBe('sha256')
    expect(err.message).toMatch(/sha256/)
    expect(err.message).toMatch(/file/)
    expect(await db.asSystem().doc.count()).toBe(1)
    expect(stored().length).toBeGreaterThanOrEqual(1)
    db.$close()
  })

  test('a disagreeing sibling on an update is refused and the row is unchanged', async () => {
    const { db } = await client(`file File? @digest(sha256)\n sha256 String?`)
    await db.asSystem().doc.create({ data: { id: 1, file: png } })
    await expect(db.asSystem().doc.update({ where: { id: 1 }, data: { file: new Uint8Array([1, 2, 3]), sha256: sha(png) } }))
      .rejects.toThrow(/sha256/)
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 }, select: { sha256: true } })).sha256).toBe(sha(png))
    db.$close()
  })

  test('the sibling cannot be set without the file', async () => {
    const { db } = await client(`file File? @digest(sha256)\n sha256 String?`)
    const err: any = await db.asSystem().doc.create({ data: { id: 1, sha256: sha(png) } }).catch((e: any) => e)
    expect(err.field).toBe('sha256')
    expect(err.message).toMatch(/without a file/)
    await db.asSystem().doc.create({ data: { id: 2, file: png } })
    await expect(db.asSystem().doc.update({ where: { id: 2 }, data: { sha256: 'cd'.repeat(32) } })).rejects.toThrow(/without a file/)
    await expect(db.asSystem().doc.update({ where: { id: 2 }, data: { sha256: null } })).rejects.toThrow(/without a file/)
    db.$close()
  })

  test('clearing the file clears the sibling, and a value stated beside the clear is refused', async () => {
    const { db } = await client(`file File? @digest(sha256)\n sha256 String?`)
    await db.asSystem().doc.create({ data: { id: 1, file: png } })
    await expect(db.asSystem().doc.update({ where: { id: 1 }, data: { file: null, sha256: sha(png) } })).rejects.toThrow(/clears/)
    const row = await db.asSystem().doc.update({ where: { id: 1 }, data: { file: null }, select: { sha256: true, file: true } })
    expect(row.file).toBeNull()
    expect(row.sha256).toBeNull()
    db.$close()
  })

  test('an update that touches neither column leaves the sibling alone', async () => {
    const { db } = await client(`file File? @digest(sha256)\n sha256 String?\n note String?`)
    await db.asSystem().doc.create({ data: { id: 1, file: png } })
    const row = await db.asSystem().doc.update({ where: { id: 1 }, data: { note: 'x' }, select: { sha256: true } })
    expect(row.sha256).toBe(sha(png))
    db.$close()
  })
})
