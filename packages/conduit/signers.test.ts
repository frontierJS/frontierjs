// ============================================================
// Conduit — the signer seam (FJS-D891, FJS-2542)
//
// A vendor's scheme reaches the wire through ONE `signed` auth type, whose
// function the connector supplies. Each case leaves the process for a real
// Bun.serve vendor that reads what the scheme put on the request: Basic,
// a secret inside the body, and a minted JWT whose lifetime is the resolver's.
// ============================================================

import { afterAll, describe, expect, it } from 'bun:test'
import { createConduit } from './src/conduit.ts'
import { createStaticResolver, withCache } from './src/credentials.ts'
import type { CredentialResolver, Signer, TargetDescriptor } from './src/types.ts'

const seen: Array<{ authorization: string | null; type: string | null; body: string; query: string }> = []
let   refuse = ''
const vendor = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    seen.push({
      authorization: req.headers.get('authorization'),
      type:          req.headers.get('content-type'),
      body,
      query:         new URL(req.url).search,
    })
    if (refuse && req.headers.get('authorization') === `Bearer ${refuse}`) return new Response('expired', { status: 401 })
    return Response.json({ ok: true })
  },
})
afterAll(() => vendor.stop(true))

const target = (auth: TargetDescriptor['auth'], extra: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  id:            'provider:vendor',
  kind:          'provider',
  protocol:      'http',
  address:       `http://127.0.0.1:${vendor.port}`,
  auth,
  registered_at: 1_000,
  last_seen_at:  null,
  ...extra,
})

const basic: Signer = ({ secret }) => ({ headers: { authorization: `Basic ${btoa(secret)}` } })
const inBody: Signer = ({ secret, body }) => ({ body: `${body ?? ''}&secret=${secret}` })

describe('a signed target', () => {
  it('sends what the signer returns: Basic, with the secret resolved at send time', async () => {
    seen.length = 0
    const c = createConduit({ credentials: createStaticResolver({ SID: 'AC1:tok' }), signers: { basic } })
    await c.register(target({ type: 'signed', ref: 'SID', signer: 'basic' }))
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    expect(r.error).toBeNull()
    expect(seen[0].authorization).toBe(`Basic ${btoa('AC1:tok')}`)
  })

  it('sends a body the signer rewrote, and the signer saw the serialized one', async () => {
    seen.length = 0
    const c = createConduit({ credentials: createStaticResolver({ TS: 's3cret' }), signers: { inBody } })
    await c.register(target({ type: 'signed', ref: 'TS', signer: 'inBody' }, { encoding: 'form' }))
    const r = await c.send({ target: 'provider:vendor', method: 'POST', path: '/verify', body: { response: 'abc' } })
    expect(r.error).toBeNull()
    expect(seen[0].body).toBe('response=abc&secret=s3cret')
    expect(seen[0].type).toContain('x-www-form-urlencoded')
  })

  it('hands the signer the method, path, query and the headers already set', async () => {
    let got: Parameters<Signer>[0] | undefined
    const c = createConduit({
      credentials: createStaticResolver({ K: 'k' }),
      signers:     { spy: (input) => { got = input; return {} } },
    })
    await c.register(target({ type: 'signed', ref: 'K', signer: 'spy' }, { headers: { 'X-Version': '2' } }))
    await c.send({ target: 'provider:vendor', method: 'POST', path: '/p?a=1', body: { n: 1 }, headers: { 'X-Call': 'y' } })
    expect(got).toMatchObject({ secret: 'k', method: 'POST', path: '/p', query: '?a=1', body: '{"n":1}' })
    expect(got!.url).toBe(`http://127.0.0.1:${vendor.port}/p?a=1`)
    expect(got!.headers).toMatchObject({ 'x-version': '2', 'x-call': 'y', 'content-type': 'application/json' })
  })

  it('cannot be displaced by a caller header of the same name', async () => {
    seen.length = 0
    const c = createConduit({ credentials: createStaticResolver({ SID: 'a:b' }), signers: { basic } })
    await c.register(target({ type: 'signed', ref: 'SID', signer: 'basic' }))
    await c.send({ target: 'provider:vendor', method: 'GET', path: '/x', headers: { Authorization: 'Bearer FORGED' } })
    expect(seen[0].authorization).toBe(`Basic ${btoa('a:b')}`)
  })

  it('a minted JWT lives as long as the resolver says, and a 401 mints a fresh one', async () => {
    seen.length = 0
    let n = 0
    const mint: CredentialResolver = { async get() { return `jwt-${++n}` } }
    const c = createConduit({
      credentials: withCache(mint, { ttl_ms: Infinity }),
      signers:     { jwt: ({ secret }) => ({ headers: { authorization: `Bearer ${secret}` } }) },
    })
    await c.register(target({ type: 'signed', ref: 'KEY', signer: 'jwt' }))
    await c.send({ target: 'provider:vendor', method: 'GET', path: '/a' })
    await c.send({ target: 'provider:vendor', method: 'GET', path: '/b' })
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-1'])

    refuse = 'jwt-1'
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/c' })
    refuse = ''
    expect(r.error).toBeNull()
    expect(seen.at(-1)!.authorization).toBe('Bearer jwt-2')
  })

  it('an unresolved secret fails closed as auth_failed, signer never called', async () => {
    let called = false
    const c = createConduit({
      credentials: createStaticResolver({}),
      signers:     { s: () => { called = true; return {} } },
    })
    await c.register(target({ type: 'signed', ref: 'NOPE', signer: 's' }))
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    expect(r.error?.kind).toBe('auth_failed')
    expect(called).toBe(false)
  })

  it('a signer that throws is an auth_failed, not a thrown send', async () => {
    const c = createConduit({
      credentials: createStaticResolver({ K: 'k' }),
      signers:     { boom: () => { throw new Error('bad key') } },
    })
    await c.register(target({ type: 'signed', ref: 'K', signer: 'boom' }))
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    expect(r.error).not.toBeNull()
  })
})

describe('registering a signed target', () => {
  it('refuses a signer that is not installed, naming it', async () => {
    const c = createConduit({ signers: { basic } })
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'nope' })))
      .rejects.toThrow(/signer 'nope'.*installed: basic/)
  })

  it('refuses a prototype name as a signer', async () => {
    const c = createConduit({})
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'toString' }))).rejects.toThrow(/signer 'toString'/)
  })

  it('refuses a followed redirect, which would replay a signature for another request', async () => {
    const c = createConduit({ signers: { basic } })
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'basic' }, { follow_redirects: 'same-origin' })))
      .rejects.toThrow(/same-origin/)
  })

  it('refuses an address per send, where a stored credential would go wherever a row says', async () => {
    const c = createConduit({ signers: { basic } })
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'basic' }, { address: '', address_from: 'request' })))
      .rejects.toThrow(/stored credential/)
  })
})
