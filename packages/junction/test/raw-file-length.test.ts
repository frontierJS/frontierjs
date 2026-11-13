// test/raw-file-length.test.ts
//
// FJS-4187: Bun.serve sends a ReadableStream body chunked and drops a
// Content-Length the route set, while `app.http.fetch` hands the test the
// header. A player cannot seek a download with no length, so the length is
// asked over a socket here, and the shape that keeps it is the one the guide
// names: `Bun.file(fd)` of the open handle.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { openSync, closeSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../index.ts'

const BYTES = new Uint8Array(4096).fill(7)

describe('a raw route answering a file it holds open', () => {
  let app: any
  let dir: string
  let fd: number

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'junction-raw-file-'))
    writeFileSync(join(dir, 'a.bin'), BYTES)
    fd = openSync(join(dir, 'a.bin'), 'r')
    app = createApp({ config: { port: 0 } })
    app.get('/as-stream', () => new Response(
      new ReadableStream({ start(c) { c.enqueue(BYTES); c.close() } }),
      { headers: { 'content-type': 'application/octet-stream', 'content-length': String(BYTES.length) } },
    ))
    app.get('/as-handle', () => new Response(Bun.file(fd), {
      headers: { 'content-type': 'application/octet-stream' },
    }))
    await app.start()
  })
  afterAll(async () => {
    await app.stop?.()
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  })

  const ask = (path: string) => fetch(`http://localhost:${app.http.port}${path}`)

  test('a handle answered as Bun.file(fd) carries its length over the socket', async () => {
    const res = await ask('/as-handle')
    expect(res.headers.get('content-length')).toBe(String(BYTES.length))
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect((await res.arrayBuffer()).byteLength).toBe(BYTES.length)
  })

  test('a ReadableStream with Content-Length set goes out chunked, whatever the route said', async () => {
    const res = await ask('/as-stream')
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBe('chunked')
    expect((await res.arrayBuffer()).byteLength).toBe(BYTES.length)
  })
})
