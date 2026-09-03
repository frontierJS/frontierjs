// tests/filestorage-safety.test.ts
//
// FJS-692 — `createFileStorage` joined the caller's `id` straight into a path,
// derived the content type from a caller-supplied filename and served it inline
// with no `nosniff`, and answered 206 to ranges that cannot be satisfied.
//
//   ../../../../outside/p2  → written two directories above the root
//   x.svg                   → served image/svg+xml inline = stored XSS
//   bytes=50-10             → 206, content-length -39
//   bytes=200-  on 100 B    → 206, `bytes 200-99/100`
//
// A real temp directory throughout, because the escape is a real path and the
// headers are what a browser reads.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { createFileStorage, assertSafeId } from '../src/storage/filestorage/index.ts'

let root  = ''
let store: ReturnType<typeof createFileStorage>

beforeAll(async () => {
  root  = await mkdtemp(join(tmpdir(), 'fjs-fs-'))
  store = createFileStorage('uploads', join(root, 'store'))
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const req = (headers: Record<string, string> = {}) => new Request('http://x/f', { headers })

describe('an id is a path segment (FJS-692)', () => {

  test('a traversal is refused by name', async () => {
    await expect(store.save('../../../../outside/p2', 'x.txt', 'pwned'))
      .rejects.toThrow(/not a valid id/)
    // Nothing was written anywhere. The refusal names the id rather than
    // sanitising it: a silently rewritten id is a file nobody can find again.
    // Nothing outside the store — the escape wrote `outside/p2.file` two
    // directories above the root, which is what a `.toThrow` alone would miss.
    expect(await readdir(root)).not.toContain('outside')
  })

  test('every path-touching entry point refuses it', async () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(129), 'a b'])
      expect(() => assertSafeId(bad)).toThrow()
    await expect(store.read('../x')).rejects.toThrow()
    await expect(store.remove('../x')).rejects.toThrow()
    await expect(store.exists('../x')).rejects.toThrow()
    await expect(store.meta('../x')).rejects.toThrow()
  })

  test('an ordinary id still works', async () => {
    const meta = await store.save('ok-id_1', 'note.txt', 'hello')
    expect(meta.size).toBe(5)
    expect(await store.exists('ok-id_1')).toBe(true)
  })

  test('toResponse answers 404 rather than throwing at the HTTP edge', async () => {
    const res = await store.toResponse('../../etc/passwd', req())
    expect(res.status).toBe(404)
  })
})

describe('what a browser is told about the bytes (FJS-692)', () => {

  test('an svg is an attachment with nosniff', async () => {
    await store.save('svg1', 'logo.svg', '<svg onload="alert(1)"></svg>')
    const res = await store.toResponse('svg1', req())
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // The type came off a filename the caller chose, so the one thing it may
    // not do is render as a document on this origin.
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })

  test('a png is still served inline', async () => {
    await store.save('png1', 'photo.png', 'notreallyapng')
    const res = await store.toResponse('png1', req())
    // The control. A rule that made everything an attachment would look
    // identical from the svg's side and would break every avatar.
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('an explicit download is an attachment whatever the type', async () => {
    const res = await store.toResponse('png1', req(), 'named.png')
    expect(res.headers.get('content-disposition')).toContain('named.png')
  })
})

describe('ranges (FJS-692)', () => {

  beforeAll(async () => { await store.save('hundred', 'blob.bin', 'x'.repeat(100)) })

  test('an inverted range is 416 with the length', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=50-10' }))
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })

  test('a start past the end is 416', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=200-' }))
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })

  test('a satisfiable range is a correct 206', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=10-19' }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect((await res.text()).length).toBe(10)
  })

  test('an end past the file is clamped rather than lied about', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=90-500' }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 90-99/100')
  })

  test('a suffix range reads from the end', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=-10' }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 90-99/100')
  })

  test('a range naming neither end is 416', async () => {
    const res = await store.toResponse('hundred', req({ range: 'bytes=-' }))
    expect(res.status).toBe(416)
  })
})

describe('a size bound (FJS-692)', () => {

  test('maxBytes refuses before the write', async () => {
    await expect(store.save('big', 'big.bin', 'x'.repeat(50), { maxBytes: 10 }))
      .rejects.toThrow(/over the 10-byte limit/)
    expect(await store.exists('big')).toBe(false)
  })

  test('a body inside the bound is stored', async () => {
    const meta = await store.save('small', 'small.bin', 'x'.repeat(5), { maxBytes: 10 })
    expect(meta.size).toBe(5)
  })
})
