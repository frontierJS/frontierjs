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
import { createSQLiteStore } from './src/stores/sqlite.ts'
import { Database } from 'bun:sqlite'
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

const inBody: Signer = ({ secret, body }) => ({ body: `${body ?? ''}&secret=${secret}` })

describe('a signed target', () => {
  it('sends Basic through the built-in signer, with the secret resolved at send time', async () => {
    seen.length = 0
    const c = createConduit({ credentials: createStaticResolver({ SID: 'AC1:tok' }) })
    await c.register(target({ type: 'signed', ref: 'SID', signer: 'basic' }))
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    expect(r.error).toBeNull()
    expect(seen[0].authorization).toBe(`Basic ${btoa('AC1:tok')}`)
  })

  // Two copies written in connectors disagreed on both of these (`FJS-2233`).
  it('sends a key-only Basic credential with its colon, and a non-ASCII password as UTF-8', async () => {
    seen.length = 0
    const c = createConduit({ credentials: createStaticResolver({ KEY: 'shippo_live', LOGIN: 'me@x.io:pässw%rd:2' }) })
    await c.register(target({ type: 'signed', ref: 'KEY', signer: 'basic' }))
    await c.register(target({ type: 'signed', ref: 'LOGIN', signer: 'basic' }, { id: 'provider:login' }))
    await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    await c.send({ target: 'provider:login', method: 'GET', path: '/x' })
    const decoded = seen.map(r => Buffer.from(r.authorization!.replace(/^Basic /, ''), 'base64').toString('utf8'))
    expect(decoded).toEqual(['shippo_live:', 'me@x.io:pässw%rd:2'])
  })

  it('refuses a connector signer that takes a built-in name', () => {
    expect(() => createConduit({ signers: { basic: () => ({}) } })).toThrow(/built-in 'basic'/)
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
    const c = createConduit({ credentials: createStaticResolver({ SID: 'a:b' }) })
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

  // Nothing left the process, so the answer is neither a network fault nor
  // indeterminate — a GET was retried three times and a POST claimed it may
  // have landed (`FJS-2726`). And the credential was never refused, so a
  // minted one is not forgotten either.
  it('a signer that throws is auth_failed: not retried, not indeterminate, nothing sent, nothing reminted', async () => {
    seen.length = 0
    let calls = 0, mints = 0
    const mint: CredentialResolver = { async get() { return `k-${++mints}` }, invalidate() {} }
    const c = createConduit({
      credentials: mint,
      signers:     { boom: () => { calls++; throw new Error('needs encoding form') } },
    })
    await c.register(target({ type: 'signed', ref: 'K', signer: 'boom' }))
    for (const method of ['GET', 'POST'] as const) {
      const r = await c.send({ target: 'provider:vendor', method, path: '/x', body: method === 'POST' ? { a: 1 } : undefined })
      expect(r.error).toMatchObject({ kind: 'auth_failed', retryable: false })
      expect(r.error!.indeterminate).toBeUndefined()
      expect(r.error!.message).toContain('needs encoding form')
    }
    expect({ calls, mints, sent: seen.length }).toEqual({ calls: 2, mints: 2, sent: 0 })
  })

  // A resolver has no target id to build a CredentialError with, so a mint
  // that fails throws whatever its vendor threw (`FJS-2723`).
  it('a resolver that throws a plain Error is auth_failed with its message, never indeterminate', async () => {
    seen.length = 0
    const failing: CredentialResolver = { async get() { throw new Error('invalid_grant') } }
    const c = createConduit({ credentials: failing, signers: { s: () => ({}) } })
    await c.register(target({ type: 'signed', ref: 'K', signer: 's' }))
    await c.register(target({ type: 'bearer', ref: 'K' }, { id: 'provider:bearer' }))
    for (const id of ['provider:vendor', 'provider:bearer']) {
      const r = await c.send({ target: id, method: 'POST', path: '/send', body: { a: 1 } })
      expect(r.error).toMatchObject({ kind: 'auth_failed', retryable: false })
      expect(r.error!.indeterminate).toBeUndefined()
      expect(r.error!.message).toContain('invalid_grant')
    }
    expect(seen.length).toBe(0)
  })
})

// A scheme with a per-target fact (SigV4's region and service) carries it on
// the descriptor, or the app registers one signer per value under a
// parameterized name the registry cannot read back (`FJS-2725`).
describe('signer params', () => {
  it('hands auth.params to the signer, and {} when the target states none', async () => {
    const got: Array<Parameters<Signer>[0]['params']> = []
    const c = createConduit({
      credentials: createStaticResolver({ K: 'k' }),
      signers:     { spy: (input) => { got.push(input.params); return {} } },
    })
    await c.register(target({ type: 'signed', ref: 'K', signer: 'spy', params: { region: 'auto', service: 's3' } }))
    await c.register(target({ type: 'signed', ref: 'K', signer: 'spy' }, { id: 'provider:bare' }))
    await c.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    await c.send({ target: 'provider:bare', method: 'GET', path: '/x' })
    expect(got).toEqual([{ region: 'auto', service: 's3' }, {}])
  })

  it('survives the SQLite registry, so a conduit rebuilt from the store signs under the same params', async () => {
    const db = new Database(':memory:')
    const a  = createConduit({ store: createSQLiteStore(db), signers: { spy: () => ({}) } })
    await a.init()
    await a.register(target({ type: 'signed', ref: 'K', signer: 'spy', params: { region: 'eu-west-1' } }))
    let got: Record<string, string> | undefined
    const b = createConduit({
      store:       createSQLiteStore(db),
      credentials: createStaticResolver({ K: 'k' }),
      signers:     { spy: (input) => { got = input.params; return {} } },
    })
    await b.init()
    const r = await b.send({ target: 'provider:vendor', method: 'GET', path: '/x' })
    expect(r.error).toBeNull()
    expect(got).toEqual({ region: 'eu-west-1' })
  })

  it('refuses a value that is not a string, naming the key', async () => {
    const c = createConduit({ signers: { spy: () => ({}) } })
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'spy', params: { port: 9000 as unknown as string } })))
      .rejects.toThrow(/auth\.params\.port must be a string/)
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'spy', params: ['a'] as unknown as Record<string, string> })))
      .rejects.toThrow(/auth\.params must be an object/)
  })

  it('refuses params on a type with no signer to read them', async () => {
    const c = createConduit()
    await expect(c.register(target({ type: 'bearer', ref: 'K', params: { region: 'x' } } as unknown as TargetDescriptor['auth'])))
      .rejects.toThrow(/auth\.params.*'bearer' has no signer/)
  })
})

describe('registering a signed target', () => {
  it('refuses a signer that is not installed, naming it', async () => {
    const c = createConduit()
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'nope' })))
      .rejects.toThrow(/signer 'nope'.*installed: basic/)
  })

  it('refuses a prototype name as a signer', async () => {
    const c = createConduit({})
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'toString' }))).rejects.toThrow(/signer 'toString'/)
  })

  it('refuses a followed redirect, which would replay a signature for another request', async () => {
    const c = createConduit()
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'basic' }, { follow_redirects: 'same-origin' })))
      .rejects.toThrow(/same-origin/)
  })

  it('refuses an address per send, where a stored credential would go wherever a row says', async () => {
    const c = createConduit()
    await expect(c.register(target({ type: 'signed', ref: 'K', signer: 'basic' }, { address: '', address_from: 'request' })))
      .rejects.toThrow(/stored credential/)
  })
})
