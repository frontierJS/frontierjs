// ============================================================
// Conduit — a minted credential, sent through conduit (FJS-2722, FJS-2724)
//
// A resolver that buys its credential from a token endpoint sends that
// exchange through a second, `auth: none` target (`FJS-D933`), so the
// endpoint gets a breaker, an observer and a timeout of its own. Two real
// Bun.serve peers: a token endpoint that can be told to fail, and an API
// that accepts only the token it minted last.
// ============================================================

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createConduit } from './src/conduit.ts'
import { byRef, createStaticResolver, withCache } from './src/credentials.ts'
import { MintError, type ConduitError, type CredentialResolver, type TargetDescriptor } from './src/types.ts'

let minted    = 0
let tokenFail = 0            // the next N exchanges answer this status
let failWith  = 503
let current   = ''
const tokenEndpoint = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = new URLSearchParams(await req.text())
    if (tokenFail > 0) {
      tokenFail--
      return Response.json({ error: failWith === 400 ? 'invalid_grant' : 'unavailable' }, {
        status:  failWith,
        headers: failWith === 429 ? { 'retry-after': '3' } : {},
      })
    }
    minted++
    current = `tok-${minted}-${form.get('assertion')}`
    return Response.json({ access_token: current, expires_in: 3600 })
  },
})

const apiSeen: string[] = []
const api = Bun.serve({
  port: 0,
  fetch(req) {
    const auth = req.headers.get('authorization') ?? ''
    apiSeen.push(auth)
    return auth === `Bearer ${current}` ? Response.json({ ok: true }) : new Response('expired', { status: 401 })
  },
})
afterAll(() => { tokenEndpoint.stop(true); api.stop(true) })

const descriptor = (id: string, address: string, auth: TargetDescriptor['auth'], extra: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  id, kind: 'provider', protocol: 'http', address, auth, registered_at: 1_000, last_seen_at: null, ...extra,
})

const TOKEN = 'provider:token'
const API   = 'provider:api'

async function build() {
  const errors: ConduitError[] = []
  // Bound late: the resolver is handed to the conduit it sends through.
  let send: (req: { method: 'POST'; path: string; body: Record<string, string> }) => ReturnType<typeof conduit.send>
  const mint: CredentialResolver = {
    async get(ref) {
      const r = await send({ method: 'POST', path: '/token', body: { grant_type: 'jwt-bearer', assertion: ref } })
      if (r.error) throw new MintError(r.error)
      return (r.data as { access_token: string }).access_token
    },
  }
  const conduit = createConduit({
    credentials: byRef({
      MINTED: withCache(mint, { ttl_ms: 60_000 }),
      STATIC: createStaticResolver({ STATIC: 'static-secret' }),
    }),
    targets: [
      descriptor(TOKEN, `http://127.0.0.1:${tokenEndpoint.port}`, { type: 'none' }, { encoding: 'form', resilience: { retry_limit: 1 } }),
      descriptor(API,   `http://127.0.0.1:${api.port}`, { type: 'bearer', ref: 'MINTED' }),
    ],
    observers: { onError: (_req, err) => { errors.push(err) } },
  })
  send = req => conduit.send({ target: TOKEN, replayable: true, ...req })
  await conduit.init()
  return { conduit, errors }
}

beforeEach(() => {
  minted = 0; tokenFail = 0; failWith = 503; current = ''
  apiSeen.length = 0
})

describe('a mint sent through a second target', () => {
  it('spends the token the mint bought, and mints once for a burst', async () => {
    const { conduit } = await build()
    const got = await Promise.all(Array.from({ length: 5 }, () => conduit.send({ target: API, method: 'GET', path: '/x' })))
    expect(got.every(r => r.error === null)).toBe(true)
    expect(minted).toBe(1)
    expect(apiSeen.every(a => a === `Bearer ${current}`)).toBe(true)
  })

  it('a token endpoint outage is a retryable auth_failed naming the endpoint, and the API is never reached', async () => {
    const { conduit, errors } = await build()
    tokenFail = 10
    const r = await conduit.send({ target: API, method: 'POST', path: '/send', body: { a: 1 } })
    expect(r.error?.kind).toBe('auth_failed')
    expect(r.error?.retryable).toBe(true)
    expect(r.error?.indeterminate).toBeUndefined()
    expect(r.error?.message).toContain(`mint through '${TOKEN}' failed: server_error`)
    expect((r.error?.raw as ConduitError | undefined)?.target).toBe(TOKEN)
    expect(apiSeen).toHaveLength(0)
    // The endpoint's own failure reached the observer under its own name.
    expect(errors.some(e => e.target === TOKEN && e.kind === 'server_error')).toBe(true)
  })

  it('the API target does not replay a failed mint: the endpoint sees its own ladder and no more', async () => {
    const { conduit } = await build()
    tokenFail = 10
    const before = tokenFail
    // GET is replayable on the API target, so a ladder there would multiply.
    await conduit.send({ target: API, method: 'GET', path: '/x' })
    expect(before - tokenFail).toBe(2)   // the token target's retry_limit: 1
  })

  it('carries a rate-limited mint’s Retry-After', async () => {
    const { conduit } = await build()
    tokenFail = 10; failWith = 429
    const r = await conduit.send({ target: API, method: 'GET', path: '/x' })
    expect(r.error?.kind).toBe('auth_failed')
    expect(r.error?.retryable).toBe(true)
    expect(r.error?.retry_after_ms).toBe(3000)
  })

  it('a refused grant stays permanent', async () => {
    const { conduit } = await build()
    tokenFail = 10; failWith = 400
    const r = await conduit.send({ target: API, method: 'GET', path: '/x' })
    expect(r.error?.kind).toBe('auth_failed')
    expect(r.error?.retryable).toBe(false)
    expect((r.error?.raw as ConduitError | undefined)?.kind).toBe('client_error')
  })

  it('a resolver that throws anything else is still a permanent auth_failed', async () => {
    const conduit = createConduit({
      credentials: { async get() { throw new Error('vault sealed') } },
      targets:     [descriptor(API, `http://127.0.0.1:${api.port}`, { type: 'bearer', ref: 'X' })],
    })
    await conduit.init()
    const r = await conduit.send({ target: API, method: 'GET', path: '/x' })
    expect(r.error?.kind).toBe('auth_failed')
    expect(r.error?.retryable).toBe(false)
    expect(r.error?.raw).toBeUndefined()
  })

  it('a 401 forgets the minted token through byRef, and the replay spends a fresh one', async () => {
    const { conduit } = await build()
    expect((await conduit.send({ target: API, method: 'GET', path: '/x' })).error).toBeNull()
    current = 'rotated-elsewhere'
    const r = await conduit.send({ target: API, method: 'GET', path: '/x' })
    expect(r.error).toBeNull()
    expect(minted).toBe(2)
    expect(apiSeen.at(-1)).toBe(`Bearer ${current}`)
  })
})

describe('byRef', () => {
  it('routes each ref to its own resolver, and a ref it does not name fails closed', async () => {
    const r = byRef({
      A: createStaticResolver({ A: 'a-secret' }),
      B: createStaticResolver({ B: 'b-secret', A: 'leaked' }),
    })
    expect(await r.get('A')).toBe('a-secret')
    expect(await r.get('B')).toBe('b-secret')
    expect(await r.get('C')).toBeNull()
  })

  it('forwards invalidate to the entry that answered, and no other', async () => {
    const forgot: string[] = []
    const r = byRef({
      A: { async get() { return 'a' }, invalidate: (ref, v) => forgot.push(`A:${ref}:${v}`) },
      B: { async get() { return 'b' }, invalidate: (ref, v) => forgot.push(`B:${ref}:${v}`) },
    })
    r.invalidate!('A', 'a')
    r.invalidate!('C', 'c')
    expect(forgot).toEqual(['A:A:a'])
  })

  it('offers getFor only when an entry has one, so put() still refuses a per-caller target against none', async () => {
    expect(byRef({ A: createStaticResolver({ A: 'a' }) }).getFor).toBeUndefined()

    const who = { tenant: 't1', principal: 'u1', grant: null }
    const r = byRef({
      PER:  { async get() { return null }, async getFor(_ref, w) { return `for-${w.tenant}` } },
      FLAT: createStaticResolver({ FLAT: 'flat' }),
    })
    expect(await r.getFor!('PER', who)).toBe('for-t1')
    expect(await r.getFor!('NONE', who)).toBeNull()
    await expect(r.getFor!('FLAT', who)).rejects.toThrow("the resolver for 'FLAT' has no getFor")
  })

  it('copies the table on construction', async () => {
    const table: Record<string, CredentialResolver> = { A: createStaticResolver({ A: 'a' }) }
    const r = byRef(table)
    table.A = createStaticResolver({ A: 'swapped' })
    expect(await r.get('A')).toBe('a')
  })
})
