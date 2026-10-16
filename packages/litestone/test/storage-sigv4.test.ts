// storage-sigv4.test.ts — what litestone's S3 provider puts on the wire.
//
// The signing scheme is graded by AWS's own suite in toolbelt
// (`test/specs/sigv4.spec.js`, `FJS-D892`). What stays here is what only a real
// S3Provider can show: the URL it BUILDS, because a key carrying `#` or `?` never
// reaches the signer intact if that URL is wrong, and the clock and key cache
// litestone supplies to the pure kit.

import { describe, test, expect, afterAll } from 'bun:test'
import { S3Provider } from '../src/storage/providers/s3.js'
import { presignUrl } from '../src/storage/sigv4.js'

// ─── the provider puts the key on the wire intact ─────────────────────────────

describe('S3Provider against a local server', () => {
  const seen: Array<{ method: string, path: string, auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get('authorization') })
      return new Response(req.method === 'GET' ? 'bytes' : null, { status: req.method === 'PUT' ? 200 : 204 })
    },
  })
  afterAll(() => server.stop(true))

  const provider = () => new S3Provider({
    provider: 'minio', endpoint: `http://localhost:${server.port}`, bucket: 'shop',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret',
  })
  const decoded = (path: string) => path.split('/').map(decodeURIComponent).join('/')

  test('a key carrying `#`, `?`, a space and a non-ASCII letter arrives as that key', async () => {
    seen.length = 0
    const key = 'photos/a b/ü#1?v=2.png'
    await provider().put(key, 'x', { contentType: 'image/png', size: 1 })
    await provider().get(key)
    await provider().delete(key)

    expect(seen.map(s => s.method)).toEqual(['PUT', 'GET', 'DELETE'])
    for (const s of seen) {
      expect(s.path).not.toContain('?')
      expect(decoded(s.path)).toBe(`/shop/${key}`)
      expect(s.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/)
    }
  })

  test('an ordinary key arrives exactly as written', async () => {
    seen.length = 0
    await provider().put('Product/7/photo/0a1b2c.png', 'x', { contentType: 'image/png', size: 1 })
    expect(seen[0].path).toBe('/shop/Product/7/photo/0a1b2c.png')
  })
})

// ─── a Blob upload is not read into the heap (FJS-3115) ───────────────────────

describe('S3Provider.put with a Blob', () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })

  const put = async (endpoint: string, body: unknown) => {
    let sent: { body: unknown, headers: Record<string, string> } | undefined
    globalThis.fetch = (async (_url: string, init: any) => {
      sent = { body: init.body, headers: init.headers }
      return new Response(null, { status: 200 })
    }) as any
    const provider = new S3Provider({
      provider: 'r2', endpoint, bucket: 'shop', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret',
    })
    await provider.put('k.bin', body, { contentType: 'application/octet-stream', size: (body as Blob).size })
    return sent!
  }

  test('over https the Blob itself is sent, under an unsigned payload', async () => {
    const blob = new Blob(['x'.repeat(1000)])
    const sent = await put('https://acct.r2.example.com', blob)
    expect(sent.body).toBe(blob)
    expect(sent.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(sent.headers.Authorization).toContain('x-amz-content-sha256')
  })

  test('over plain http the payload is still hashed, so the signature covers the bytes', async () => {
    const sent = await put('http://localhost:9000', new Blob(['hello']))
    expect(sent.body).toBeInstanceOf(Uint8Array)
    expect(sent.headers['x-amz-content-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})

describe('the caller\'s half of the pure kit', () => {
  test('a presigned URL carries today\'s date and the signature of the cached key', async () => {
    const opts = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' }
    const a = new URL(await presignUrl('GET', 'https://b.s3.amazonaws.com/k', opts, 60))
    const b = new URL(await presignUrl('GET', 'https://b.s3.amazonaws.com/k', opts, 60))
    expect(a.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/)
    expect(a.searchParams.get('X-Amz-Date')!.slice(0, 8)).toBe(new Date().toISOString().slice(0, 10).replaceAll('-', ''))
    expect(a.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(b.searchParams.get('X-Amz-Credential')).toBe(a.searchParams.get('X-Amz-Credential'))
  })
})
