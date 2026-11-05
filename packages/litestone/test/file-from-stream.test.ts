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
import { FileStorage, fromStream, fromPath } from '../src/storage/file-storage.js'
import { S3Provider } from '../src/storage/providers/s3.js'
import { tempDir } from '../src/tmp-dirs.js'

const root = tempDir('file-from-stream')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const PART_BYTES = 8 * 1024 * 1024
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

  // A fake S3 that keeps what multipart sends, so the object it assembles is read back.
  const fakeS3 = (opts: { failPart?: number } = {}) => {
    const real = globalThis.fetch
    const log: string[] = []
    const parts: Record<number, Uint8Array> = {}
    let completed: Uint8Array | null = null
    let aborted = false
    globalThis.fetch = (async (url: string, init: any) => {
      const u = new URL(url)
      const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null
      log.push(`${init.method} ${u.search || '(whole)'}`)
      if (init.method === 'POST' && u.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>up/1</UploadId></InitiateMultipartUploadResult>')
      if (init.method === 'PUT' && u.searchParams.has('partNumber')) {
        const n = Number(u.searchParams.get('partNumber'))
        if (n === opts.failPart) return new Response('boom', { status: 500 })
        parts[n] = body!
        return new Response('', { headers: { etag: `"e${n}"` } })
      }
      if (init.method === 'POST' && u.searchParams.has('uploadId')) {
        expect(u.searchParams.get('uploadId')).toBe('up/1')
        const xml = new TextDecoder().decode(body!)
        const order = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"e(\d+)"<\/ETag>/g)].map(m => [m[1], m[2]])
        expect(order.every(([a, b]) => a === b)).toBe(true)
        completed = Buffer.concat(order.map(([n]) => parts[Number(n)]))
        return new Response('<CompleteMultipartUploadResult/>')
      }
      if (init.method === 'DELETE' && u.searchParams.has('uploadId')) { aborted = true; return new Response('', { status: 204 }) }
      if (init.method === 'PUT') { completed = body; return new Response('') }
      return new Response('', { status: 400 })
    }) as any
    return { log, parts, get completed() { return completed }, get aborted() { return aborted }, restore: () => { globalThis.fetch = real } }
  }
  const big = new Uint8Array(PART_BYTES * 2 + 12_345).map((_, i) => (i * 7) % 251)

  test('a stream with no size is a multipart upload that reassembles to its bytes', async () => {
    const s3 = fakeS3()
    try {
      await provider('https://s3.example.com').put('k', streamOf(big, 1_000_003), { contentType: 'video/mp4' })
      expect(s3.log).toEqual(['POST ?uploads', 'PUT ?partNumber=1&uploadId=up%2F1', 'PUT ?partNumber=2&uploadId=up%2F1', 'PUT ?partNumber=3&uploadId=up%2F1', 'POST ?uploadId=up%2F1'])
      expect(Object.values(s3.parts).map(p => p.length)).toEqual([PART_BYTES, PART_BYTES, 12_345])
      expect(sha(s3.completed!)).toBe(sha(big))
    } finally { s3.restore() }
  })

  test('a stream over plain http is multipart too, since a part is buffered and can be signed', async () => {
    const s3 = fakeS3()
    try {
      await provider('http://localhost:9000').put('k', streamOf(big, 1_000_003), { contentType: 'video/mp4', size: big.length })
      expect(s3.log[0]).toBe('POST ?uploads')
      expect(sha(s3.completed!)).toBe(sha(big))
    } finally { s3.restore() }
  })

  test('an unsized stream that ends inside one part is one ordinary PUT, and an empty one too', async () => {
    const s3 = fakeS3()
    try {
      await provider('https://s3.example.com').put('k', streamOf(png), { contentType: 'image/png' })
      expect(s3.log).toEqual(['PUT (whole)'])
      expect(sha(s3.completed!)).toBe(sha(png))
      await provider('https://s3.example.com').put('k', streamOf(new Uint8Array(0)), { contentType: 'image/png' })
      expect(s3.completed!.length).toBe(0)
    } finally { s3.restore() }
  })

  test('a part that fails aborts the upload and the error surfaces', async () => {
    const s3 = fakeS3({ failPart: 2 })
    try {
      await expect(provider('https://s3.example.com').put('k', streamOf(big, 1_000_003), { contentType: 'video/mp4' }))
        .rejects.toThrow(/multipart part 2 failed \(500\)/)
      expect(s3.aborted).toBe(true)
      expect(s3.completed).toBeNull()
    } finally { s3.restore() }
  })

  test('through FileStorage an unsized stream stores, with the hash and count taken in the one pass', async () => {
    const s3 = fakeS3()
    try {
      const files = FileStorage({ provider: 'minio', bucket: 'b', endpoint: 'https://s3.example.com', accessKeyId: 'k', secretAccessKey: 's' }) as any
      const db: any = await createClient({ schema: `model Doc {\n id Int @id\n file File?\n @@allow(all, true)\n}`, db: ':memory:', plugins: [files] })
      await autoMigrate(db)
      const row = await db.asSystem().doc.create({ data: { id: 1, file: fromStream(streamOf(big, 1_000_003)) }, select: raw })
      expect(row.file.size).toBe(big.length)
      expect(row.file.sha256).toBe(sha(big))
      expect(sha(s3.completed!)).toBe(sha(big))
      db.$close()
    } finally { s3.restore() }
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

  test('through FileStorage a stream that fails before its first byte makes no request, delete included', async () => {
    const g = guard()
    try {
      const files = FileStorage({ provider: 'minio', bucket: 'b', endpoint: 'https://s3.example.com', accessKeyId: 'k', secretAccessKey: 's' }) as any
      const db: any = await createClient({ schema: `model Doc {\n id Int @id\n file File?\n @@allow(all, true)\n}`, db: ':memory:', plugins: [files] })
      await autoMigrate(db)
      const broken = new ReadableStream({ pull() { throw new Error('socket reset') } })
      await expect(db.asSystem().doc.create({ data: { id: 1, file: fromStream(broken) } })).rejects.toThrow(/socket reset/)
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
    expect(stored().length).toBe(1)
    db.$close()
  })

  // FJS-3985: the object is stored before the sibling is compared, so a
  // refusal that keeps it leaves a file no row names.
  test('a refused sibling leaves no object, from bytes, a File, a stream, a path, or a moved path', async () => {
    const { db, stored } = await client(`file File? @digest(sha256)\n sha256 String?\n gallery File[]`)
    const src = join(root, 'refused-src.png')
    const wrong = 'ab'.repeat(32)
    for (const file of [
      () => png,
      () => new File([png], 'a.png', { type: 'image/png' }),
      () => fromStream(streamOf(png), { name: 'a.png', size: png.length }),
      () => fromPath(src),
      () => fromPath(src, { move: true }),
    ]) {
      await Bun.write(src, png)
      const value = file()
      await expect(db.asSystem().doc.create({ data: { id: 1, file: value, sha256: wrong, gallery: [png] } })).rejects.toThrow(/sha256 states/)
      expect(stored()).toEqual([])
    }
    db.$close()
  })

  test('a disagreeing sibling on an update is refused, the row is unchanged, and its file outlives the next write', async () => {
    const { db, dir, stored } = await client(`file File? @digest(sha256)\n sha256 String?\n note String?`)
    const row = await db.asSystem().doc.create({ data: { id: 1, file: png }, select: raw })
    await expect(db.asSystem().doc.update({ where: { id: 1 }, data: { file: new Uint8Array([1, 2, 3]), sha256: sha(png) } }))
      .rejects.toThrow(/sha256/)
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 }, select: { sha256: true } })).sha256).toBe(sha(png))
    expect(stored().length).toBe(1)
    await db.asSystem().doc.update({ where: { id: 1 }, data: { note: 'x' } })
    expect(existsSync(join(dir, row.file.key))).toBe(true)
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

// FJS-3991: the object is stored before SQLite or a later field can refuse the
// write, and the rows a transaction rolls back are not the store's to restore.
describe('a write the database does not keep keeps no object (FJS-3991)', () => {
  test('a create refused by a taken id, or by a later field, stores nothing', async () => {
    const { db, stored } = await client(`file File?\n second File? @accept("image/png")`)
    await db.asSystem().doc.create({ data: { id: 1 } })
    await expect(db.asSystem().doc.create({ data: { id: 1, file: png } })).rejects.toThrow(/taken/)
    await expect(db.asSystem().doc.create({ data: { id: 2, file: png, second: new Uint8Array([1, 2, 3]) } })).rejects.toThrow()
    expect(stored()).toEqual([])
    db.$close()
  })

  test('an update refused by a unique keeps the old file through the next update', async () => {
    const { db, dir, stored } = await client(`file File?\n tag String? @unique\n note String?`)
    await db.asSystem().doc.create({ data: { id: 1, tag: 'a' } })
    const row = await db.asSystem().doc.create({ data: { id: 2, file: png }, select: raw })
    await expect(db.asSystem().doc.update({ where: { id: 2 }, data: { file: png, tag: 'a' } })).rejects.toThrow()
    await db.asSystem().doc.update({ where: { id: 2 }, data: { note: 'x' } })
    expect(stored().length).toBe(1)
    expect(existsSync(join(dir, row.file.key))).toBe(true)
    db.$close()
  })

  test('a transaction that rolls back keeps the old file and none of the new', async () => {
    const { db, dir, stored } = await client(`file File?`)
    const s = db.asSystem()
    const row = await s.doc.create({ data: { id: 1, file: png }, select: raw })
    const nope = (fn: (t: any) => Promise<unknown>) => s.$transaction(async (t: any) => { await fn(t); throw new Error('nope') }).catch(() => {})
    await nope(t => t.doc.create({ data: { id: 2, file: png } }))
    await nope(t => t.doc.update({ where: { id: 1 }, data: { file: png } }))
    await nope(t => t.doc.delete({ where: { id: 1 } }))
    expect(stored().length).toBe(1)
    expect(existsSync(join(dir, row.file.key))).toBe(true)
    await s.$transaction((t: any) => t.doc.update({ where: { id: 1 }, data: { file: png } }))
    expect(stored().length).toBe(1)
    expect(existsSync(join(dir, row.file.key))).toBe(false)
    db.$close()
  })
})

// FJS-3929: the write pass fills the column a File's @digest names, so the
// generated Create type must not require it -- the documented write that
// leaves it out has to typecheck.
describe('@digest target in the generated Create type (FJS-3929)', () => {
  test('the named sibling is optional, whether or not it is nullable', async () => {
    const { parse } = await import('../src/index.js')
    const { generateTypeScript } = await import('../src/tools/typegen.js')
    const ts = generateTypeScript(parse(`
model Doc {
  id     Int    @id
  file   File   @digest(sha256)
  sha256 String @immutable
  other  String
}
`).schema)
    const create = ts.slice(ts.indexOf('export interface DocCreate'))
    const body = create.slice(0, create.indexOf('\n}'))
    expect(body).toMatch(/\n\s+sha256\?: string/)
    expect(body).toMatch(/\n\s+other: string/)
  })
})
