// FJS-3994 -- a stored File is read back as a stream or, on the local provider,
// as a path, so a 1 GiB video reaches ffmpeg without a Buffer or the provider's layout.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { useStorage } from '../src/storage/index.js'

describe('useStorage read half (FJS-3994)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ls-read-'))
  mkdirSync(join(root, 'Clip/1'), { recursive: true })
  writeFileSync(join(root, 'Clip/1/a.bin'), 'hello stream')
  const storage = useStorage({ provider: 'local', localPath: root }) as any
  const ref = { key: 'Clip/1/a.bin', provider: 'local' }

  test('stream() answers the bytes as a ReadableStream', async () => {
    const body = await storage.stream(ref)
    expect(body).toBeInstanceOf(ReadableStream)
    expect(await new Response(body).text()).toBe('hello stream')
  })

  test('stream() of a missing key refuses', async () => {
    await expect(storage.stream({ key: 'Clip/1/none.bin' })).rejects.toThrow(/not found/i)
  })

  test('path() answers the local file, and refuses a traversal', () => {
    const p = storage.path(ref)
    expect(readFileSync(p, 'utf8')).toBe('hello stream')
    expect(() => storage.path({ key: '../x' })).toThrow(/Invalid key/)
  })

  test('path() is null for a remote provider; stream() fetches without buffering', async () => {
    const r2 = useStorage({ provider: 'r2', bucket: 'b', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'a', secretAccessKey: 's' }) as any
    expect(r2.path({ key: 'k' })).toBeNull()
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('remote bytes')) as any
    try { expect(await new Response(await r2.stream({ key: 'k' })).text()).toBe('remote bytes') }
    finally { globalThis.fetch = real }
  })
  // FJS-3997 -- delete() takes the ref the typings declare; a bare key is not one.
  test('delete() removes the object a ref or its JSON text names, and refuses a bare key', async () => {
    writeFileSync(join(root, 'Clip/1/b.bin'), 'b')
    writeFileSync(join(root, 'Clip/1/c.bin'), 'c')
    await expect(storage.delete('Clip/1/b.bin')).rejects.toThrow(/invalid file reference/)
    expect(existsSync(join(root, 'Clip/1/b.bin'))).toBe(true)
    await storage.delete({ key: 'Clip/1/b.bin', provider: 'local' })
    await storage.delete(JSON.stringify({ key: 'Clip/1/c.bin', provider: 'local' }))
    expect(existsSync(join(root, 'Clip/1/b.bin'))).toBe(false)
    expect(existsSync(join(root, 'Clip/1/c.bin'))).toBe(false)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
