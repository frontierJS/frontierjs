// ============================================================
// Conduit — the receiving end (FJS-D899, FJS-1804, FJS-1805)
//
// The dialect here is FrontierJS's own scheme over toolbelt/signature, which
// is the one every sender in this repo can produce. What is under test is the
// ORDER conduit owns — credential → verify → parse → owner → receipt → apply →
// mark — and what a duplicate means: applied, never merely seen. An apply that
// throws must leave the sender's retry a clean run, and only an applied receipt
// may answer a redelivery as a duplicate.
// ============================================================

import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { signRequest, verifyRequest } from '@frontierjs/toolbelt/signature'
import { createTestApp } from '@frontierjs/junction'
import { createConduit } from './src/conduit.ts'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createStaticResolver } from './src/credentials.ts'
import { createMemoryStore } from './src/stores/memory.ts'
import { createSQLiteStore } from './src/stores/sqlite.ts'
import type { Dialect, Delivery, Receiver, ReceivedEvent, Outcome, ReceiveResult } from './src/receive.ts'
import type { ConduitStore, IConduit } from './src/types.ts'

const NOW    = 1_700_000_000
const SECRET = 'hook-secret'
const PATH   = '/webhooks/acme'
const TOL    = 300

interface AcmeEvent extends ReceivedEvent { payload: { ref: string } }

// ─── A dialect — our own scheme, as a connector would export it ─────────────

const acme: Dialect<string, AcmeEvent> = {
  verify: (d, secret, { now, seenNonce }) => verifyRequest({
    secret, method: d.method, path: d.path, query: d.query, body: d.rawBody, headers: d.headers,
    prefix: 'X-Hook', toleranceSeconds: TOL, now,
    seenNonce: nonce => seenNonce(nonce, 2 * TOL),
  }),
  parse: (d) => {
    const b = d.body as { id?: string; type?: string; ref?: string } | null
    return b?.id && b.type ? { id: b.id, type: b.type, payload: { ref: b.ref ?? '' } } : null
  },
  dedupeKey: (_d, ev) => ev.id,
}

let nonces = 0
async function delivery(body: Record<string, unknown>, opts: { secret?: string; timestamp?: number; nonce?: string; path?: string; route?: Record<string, string> } = {}): Promise<Delivery> {
  const raw     = JSON.stringify(body)
  const path    = opts.path ?? PATH
  const headers = await signRequest({
    secret: opts.secret ?? SECRET, method: 'POST', path, body: raw, prefix: 'X-Hook',
    timestamp: opts.timestamp ?? NOW, nonce: opts.nonce ?? `n-${++nonces}`,
  })
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return { method: 'POST', path, query: '', route: opts.route ?? {}, headers: lower, rawBody: raw, body }
}

function harness(store: ConduitStore = createMemoryStore()) {
  const applied: AcmeEvent[] = []
  let outcome: Outcome | (() => never) = 'applied'
  const c = createConduit({ store, credentials: createStaticResolver({ HOOK: SECRET }) })
  const receiver: Receiver<string, AcmeEvent, string> = {
    provider:   'acme',
    path:       PATH,
    dialect:    acme,
    credential: 'HOOK',
    owner:      ev => ev.payload.ref ? `shop-${ev.payload.ref}` : null,
    apply:      ev => { applied.push(ev); return typeof outcome === 'function' ? outcome() : outcome },
  }
  c.receive(receiver)
  // init() is what creates the receipts table, as boot() does under the plugin.
  const ready = c.init()
  return {
    c, store, applied,
    setOutcome: (o: typeof outcome) => { outcome = o },
    accept: async (d: Delivery, now = NOW) => { await ready; return c.accept(PATH, d, now) },
  }
}

// ─── Declaring one ──────────────────────────────────────────────────────────

describe('receive(): a receiver is refused by name', () => {
  const base = (): Receiver<string, AcmeEvent, string> =>
    ({ provider: 'acme', path: PATH, dialect: acme, credential: 'HOOK', apply: () => 'applied' })

  it('an unknown field, a path without a slash, a dialect missing a function, a credential of neither shape', () => {
    const c = createConduit()
    expect(() => c.receive({ ...base(), window: 300 } as never)).toThrow(/unknown field 'window'/)
    expect(() => c.receive({ ...base(), path: 'webhooks' })).toThrow(/must start with/)
    expect(() => c.receive({ ...base(), dialect: { verify: acme.verify, parse: acme.parse } as never })).toThrow(/dialect.dedupeKey must be a function/)
    expect(() => c.receive({ ...base(), dialect: { ...acme, window: 300 } as never })).toThrow(/unknown field 'window'/)
    expect(() => c.receive({ ...base(), credential: 5 as never })).toThrow(/credential is a ref/)
    expect(() => c.receive({ ...base(), provider: '' })).toThrow(/provider must name/)
  })

  it('a second receiver on one path', () => {
    const c = createConduit()
    c.receive(base())
    expect(() => c.receive({ ...base(), provider: 'other' })).toThrow(/already declared \(provider 'acme'\)/)
  })

  it('accept() of an undeclared path throws, a delivery never reaches a dialect that was not named', async () => {
    const c = createConduit()
    await expect(c.accept('/nowhere', await delivery({ id: 'e1', type: 't' }), NOW)).rejects.toThrow(/No receiver declared/)
  })
})

// ─── The refusals ───────────────────────────────────────────────────────────

describe('accept(): what is refused, and that every refusal is one sentence', () => {
  it('a forged signature, a stale clock, and a tampered body', async () => {
    const h = harness()
    const forged   = await h.accept(await delivery({ id: 'e1', type: 't' }, { secret: 'wrong' }))
    const stale    = await h.accept(await delivery({ id: 'e2', type: 't' }, { timestamp: NOW - 600 }))
    const signed   = await delivery({ id: 'e3', type: 't' })
    const tampered = await h.accept({ ...signed, rawBody: JSON.stringify({ id: 'e3', type: 'other' }) })
    for (const r of [forged, stale, tampered]) {
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ error: 'not verified' })
      expect(r.result).toBe('refused')
    }
    // The reason is for the log and names the check, where the body does not.
    expect(forged.reason).toBe('signature does not match')
    expect(stale.reason).toMatch(/600s out/)
    expect(h.applied).toHaveLength(0)
  })

  it('the same request twice, byte for byte, is refused on the nonce before the receipt is consulted', async () => {
    const h = harness()
    const d = await delivery({ id: 'e1', type: 't' }, { nonce: 'once' })
    expect((await h.accept(d)).status).toBe(200)
    const again = await h.accept(d)
    expect(again.status).toBe(401)
    expect(again.reason).toBe('nonce has already been used')
    // The memory is this receiver's: it reads the clock accept() was handed, so
    // twice the tolerance later the nonce is forgotten and the window alone refuses.
    const later = await h.accept(d, NOW + 2 * TOL + 1)
    expect(later.reason).toMatch(/out, tolerance/)
  })

  it('a credential ref the resolver cannot answer refuses every delivery and names the ref in the log', async () => {
    const c = createConduit({ credentials: createStaticResolver({}) })
    c.receive({ provider: 'acme', path: PATH, dialect: acme, credential: 'MISSING', apply: () => 'applied' })
    const r = await c.accept(PATH, await delivery({ id: 'e1', type: 't' }), NOW)
    expect(r.status).toBe(401)
    expect(r.reason).toBe("credential 'MISSING' did not resolve")
  })

  it('a credential chosen per delivery — the key is a row the path names — and null refuses', async () => {
    const keys: Record<string, string> = { sub_1: 'key-one', sub_2: 'key-two' }
    const c = createConduit()
    const seen: string[] = []
    c.receive<string, AcmeEvent, string>({
      provider: 'acme', path: '/hooks/{sub}', dialect: acme,
      credential: d => keys[d.route.sub] ?? null,
      apply: ev => { seen.push(ev.id); return 'applied' },
    })
    const ok = await c.accept('/hooks/{sub}', await delivery({ id: 'e1', type: 't' }, { secret: 'key-two', path: '/hooks/sub_2', route: { sub: 'sub_2' } }), NOW)
    expect(ok.status).toBe(200)
    // Signed under the other subscription's key: the path chose which key, before the body was believed.
    const cross = await c.accept('/hooks/{sub}', await delivery({ id: 'e2', type: 't' }, { secret: 'key-one', path: '/hooks/sub_2', route: { sub: 'sub_2' } }), NOW)
    expect(cross.status).toBe(401)
    const none = await c.accept('/hooks/{sub}', await delivery({ id: 'e3', type: 't' }, { secret: 'x', path: '/hooks/sub_9', route: { sub: 'sub_9' } }), NOW)
    expect(none.status).toBe(401)
    expect(none.reason).toBe('no credential for this delivery')
    expect(seen).toEqual(['e1'])
  })
})

// ─── The order, and what a duplicate means ──────────────────────────────────

function orderCases(name: string, makeStore: () => ConduitStore) {
  describe(`accept() over the ${name} store`, () => {
    it('a verified event is applied once; a redelivery under a fresh nonce is a duplicate and apply does not run again', async () => {
      const h = harness(makeStore())
      const first = await h.accept(await delivery({ id: 'evt_1', type: 'paid', ref: '42' }))
      expect(first).toMatchObject({ status: 200, body: { received: true, outcome: 'applied' }, result: 'applied' })
      const receipt = await h.store.receipt('acme', 'evt_1')
      expect(receipt).toMatchObject({ provider: 'acme', key: 'evt_1', event_type: 'paid', owner: 'shop-42', received_at: NOW * 1000, applied_at: NOW * 1000 })

      const again = await h.accept(await delivery({ id: 'evt_1', type: 'paid', ref: '42' }))
      expect(again).toMatchObject({ status: 200, body: { received: true, outcome: 'duplicate' }, result: 'duplicate' })
      expect(h.applied).toHaveLength(1)
    })

    it('dedupe means APPLIED: an apply that throws answers 500, leaves the receipt unapplied, and the retry applies it', async () => {
      const h = harness(makeStore())
      h.setOutcome(() => { throw new Error('ledger locked') })
      const failed = await h.accept(await delivery({ id: 'evt_2', type: 'paid', ref: '7' }))
      expect(failed).toMatchObject({ status: 500, body: { error: 'not applied' }, result: 'failed' })
      expect(failed.reason).toMatch(/paid evt_2 failed to apply, the sender will retry — ledger locked/)
      expect((await h.store.receipt('acme', 'evt_2'))?.applied_at).toBeNull()

      h.setOutcome('applied')
      const retried = await h.accept(await delivery({ id: 'evt_2', type: 'paid', ref: '7' }))
      expect(retried.result).toBe('applied')
      expect((await h.store.receipt('acme', 'evt_2'))?.applied_at).toBe(NOW * 1000)
      // Only now is a third delivery a duplicate.
      expect((await h.accept(await delivery({ id: 'evt_2', type: 'paid', ref: '7' }))).result).toBe('duplicate')
      expect(h.applied).toHaveLength(2)
    })

    it('parked leaves the receipt unapplied, so the next delivery of the same key applies again', async () => {
      const h = harness(makeStore())
      h.setOutcome('parked')
      expect((await h.accept(await delivery({ id: 'evt_3', type: 'receipt' }))).result).toBe('parked')
      expect((await h.store.receipt('acme', 'evt_3'))?.applied_at).toBeNull()
      h.setOutcome('applied')
      expect((await h.accept(await delivery({ id: 'evt_3', type: 'receipt' }))).result).toBe('applied')
      expect(h.applied).toHaveLength(2)
    })

    it('ignored is recorded and marks the receipt, so it is not re-applied either', async () => {
      const h = harness(makeStore())
      h.setOutcome('ignored')
      expect((await h.accept(await delivery({ id: 'evt_4', type: 'unhandled' }))).result).toBe('ignored')
      expect((await h.store.receipt('acme', 'evt_4'))?.applied_at).toBe(NOW * 1000)
      expect((await h.accept(await delivery({ id: 'evt_4', type: 'unhandled' }))).result).toBe('duplicate')
    })

    it('record() of a key that exists is a no-op, so two racing deliveries both apply and neither throws', async () => {
      const store = makeStore()
      await store.init()
      await store.record({ provider: 'p', key: 'k', event_type: 'a', owner: null, received_at: 1, applied_at: null })
      await store.record({ provider: 'p', key: 'k', event_type: 'b', owner: 'x', received_at: 2, applied_at: 2 })
      expect(await store.receipt('p', 'k')).toMatchObject({ event_type: 'a', owner: null, received_at: 1, applied_at: null })
      await store.markApplied('p', 'k', 3)
      expect((await store.receipt('p', 'k'))?.applied_at).toBe(3)
      expect(await store.receipt('p', 'other')).toBeNull()
    })
  })
}

orderCases('memory', () => createMemoryStore())
orderCases('sqlite', () => createSQLiteStore(new Database(':memory:')))

describe('accept(): the rest of the order', () => {
  it('a body that is not an event envelope is 200 and ignored, with no receipt — a 4xx would retry forever', async () => {
    const h = harness()
    const r = await h.accept(await delivery({ hello: 'world' }))
    expect(r).toMatchObject({ status: 200, body: { received: true, outcome: 'ignored' }, result: 'ignored', reason: 'not an event envelope' })
    expect(h.applied).toHaveLength(0)
  })

  it('apply is handed the owner, the credential and the delivery', async () => {
    const c = createConduit({ credentials: createStaticResolver({ HOOK: SECRET }) })
    let got: unknown
    c.receive<string, AcmeEvent, string>({
      provider: 'acme', path: PATH, dialect: acme, credential: 'HOOK',
      owner: () => 'tenant-1',
      apply: (ev, ctx) => { got = { ev, ctx }; return 'applied' },
    })
    const d = await delivery({ id: 'e1', type: 't', ref: 'r' })
    await c.accept(PATH, d, NOW)
    expect(got).toMatchObject({ ev: { id: 'e1', type: 't' }, ctx: { owner: 'tenant-1', cred: SECRET, delivery: { rawBody: d.rawBody } } })
  })

  it('stats().received counts every result per path, and an observer sees each one with its reason', async () => {
    const seen: Array<[string, ReceiveResult, string | undefined]> = []
    const c = createConduit({
      credentials: createStaticResolver({ HOOK: SECRET }),
      observers:   { onReceived: (path, r) => { seen.push([path, r.result, r.reason]) } },
    })
    c.receive({ provider: 'acme', path: PATH, dialect: acme, credential: 'HOOK', apply: () => 'applied' })
    expect(c.stats().received[PATH]).toEqual({ applied: 0, ignored: 0, parked: 0, duplicate: 0, refused: 0, failed: 0 })
    await c.accept(PATH, await delivery({ id: 'e1', type: 't' }), NOW)
    await c.accept(PATH, await delivery({ id: 'e1', type: 't' }), NOW)
    await c.accept(PATH, await delivery({ id: 'e2', type: 't' }, { secret: 'wrong' }), NOW)
    expect(c.stats().received[PATH]).toEqual({ applied: 1, ignored: 0, parked: 0, duplicate: 1, refused: 1, failed: 0 })
    expect(seen).toEqual([[PATH, 'applied', undefined], [PATH, 'duplicate', undefined], [PATH, 'refused', 'signature does not match']])
  })

  it('a destroyed conduit stops accepting', async () => {
    const h = harness()
    await h.c.destroy()
    expect((await h.accept(await delivery({ id: 'e1', type: 't' }))).status).toBe(503)
  })
})

// ─── Through junction ───────────────────────────────────────────────────────

describe('the plugin mounts the route', () => {
  const conduitOf = (app: { conduit?: IConduit }) => app.conduit!

  it('a signed POST at the path is verified over the bytes that arrived, and a redelivery is a duplicate', async () => {
    const app = await createTestApp()
    const warned: string[] = []
    app.logger.warn = ((msg: string) => { warned.push(String(msg)) }) as typeof app.logger.warn
    app.configure(conduitPlugin({ credentials: createStaticResolver({ HOOK: SECRET }) }))
    const applied: string[] = []
    conduitOf(app).receive<string, AcmeEvent, string>({
      provider: 'acme', path: PATH, dialect: acme, credential: 'HOOK',
      apply: ev => { applied.push(ev.id); return 'applied' },
    })
    await app._startForTest()
    app.http.router.build()

    const post = async (d: Delivery) => app.http.fetch(new Request(`http://localhost${d.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...d.headers }, body: d.rawBody,
    }))
    const now = Math.floor(Date.now() / 1000)

    const first = await post(await delivery({ id: 'evt_9', type: 'paid' }, { timestamp: now }))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ received: true, outcome: 'applied' })

    const again = await post(await delivery({ id: 'evt_9', type: 'paid' }, { timestamp: now }))
    expect(await again.json()).toEqual({ received: true, outcome: 'duplicate' })

    const forged = await post(await delivery({ id: 'evt_10', type: 'paid' }, { timestamp: now, secret: 'wrong' }))
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({ error: 'not verified' })
    expect(warned.some(w => w.includes(`acme ${PATH} refused — signature does not match`))).toBe(true)

    expect(applied).toEqual(['evt_9'])
    expect(conduitOf(app).stats().received[PATH]).toMatchObject({ applied: 1, duplicate: 1, refused: 1 })
  })
})
