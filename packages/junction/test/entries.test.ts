/**
 * test/entries.test.ts — one entry per row, and a list is a VIEW over it
 *
 * `FJS-D138`. Before this a tether was per-`resource()` call and held whole
 * rows, so two `createResource('orders')` in two route files were two copies,
 * and a row read with `service.get(id)` was a plain object no announcement
 * could reach (`FJS-518`).
 *
 * What is asserted here is the part that is easy to get subtly wrong:
 *
 *   • an entry is keyed by the MODEL, so two services over one model are one row
 *   • a push updates a row nobody's list holds, because somebody else may be
 *     looking at it
 *   • the list's own membership and placement rules are UNCHANGED — they run
 *     on materialized rows, so `live-order.test.ts` is the negative control
 *   • an unbound Tether is what it always was, which is what the fifteen Tether
 *     cases in `client.test.ts` are the negative control for
 *   • a released entry lingers for the TTL and then goes
 */

import { describe, it, expect } from 'bun:test'
import { createJunctionClient, Tether } from '../src/client/index.ts'
import { EntryRegistry } from '../src/client/entries.ts'

function mockList(rows: unknown[], meta: Record<string, unknown> = {}) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ kind: 'list', object: 'items', data: rows, errors: [], total: rows.length, ...meta }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

// A SINGLE is unwrapped by the server — `toResponse` sends the row itself and
// keeps the envelope only for a list. Mocking the envelope here would be
// mocking a response the server does not send.
function mockRow(row: unknown, status = 200) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify(row), {
      status, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original }, calls: () => calls }
}

const client = (opts = {}) => createJunctionClient({ url: 'http://localhost:3000', ...opts })

// ─── the registry on its own ──────────────────────────────────────────────────

describe('EntryRegistry', () => {
  it('answers the same entry for the same model and id', () => {
    const r = new EntryRegistry()
    expect(r.entry('Order', 1)).toBe(r.entry('Order', 1))
    expect(r.entry('Order', 1)).not.toBe(r.entry('Order', 2))
    expect(r.entry('Order', 1)).not.toBe(r.entry('Invoice', 1))
  })

  it('files a numeric id and its string spelling as ONE row — a URL carries a string', () => {
    const r = new EntryRegistry()
    expect(r.entry('Order', 5)).toBe(r.entry('Order', '5'))
    r.write('Order', { id: 5, n: 1 })
    expect(r.peek('Order', '5')?.get()).toEqual({ id: 5, n: 1 })
    expect(r.size).toBe(1)
  })

  it('refuses a record with no id — it cannot be matched to a row', () => {
    const r = new EntryRegistry()
    expect(r.write('Order', { ok: true })).toBeNull()
    expect(r.size).toBe(0)
  })

  it('a held entry does not expire; a released one does', () => {
    const r = new EntryRegistry({ ttlMs: 1 })
    const held = r.entry('Order', 1).hold()
    r.write('Order', { id: 1 })
    r.write('Order', { id: 2 })
    const release = r.entry('Order', 2).hold()

    release()
    expect(r.sweep(Date.now() + 5)).toBe(1)
    expect(r.size).toBe(1)

    held()
    expect(r.sweep(Date.now() + 5)).toBe(1)
    expect(r.size).toBe(0)
  })

  it('a TTL of 0 drops an entry the moment nothing holds it', () => {
    const r = new EntryRegistry({ ttlMs: 0 })
    const release = r.entry('Order', 1).hold()
    r.write('Order', { id: 1 })
    expect(r.size).toBe(1)
    release()
    expect(r.size).toBe(0)
  })

  it('an entry hold is idempotent — releasing twice does not drop somebody else\'s', () => {
    const r = new EntryRegistry({ ttlMs: 0 })
    const n = r.entry('Order', 1)
    const a = n.hold()
    const b = n.hold()
    a(); a(); a()
    expect(r.size).toBe(1)
    b()
    expect(r.size).toBe(0)
  })
})

// ─── an unbound Tether is what it always was ──────────────────────────────────

describe('Tether, unbound', () => {
  it('holds its own rows and never reaches a registry', () => {
    const s = new Tether([{ id: '1', name: 'Alice' }])
    s.upsert({ id: '1', name: 'Alicia' })
    s.upsert({ id: '2', name: 'Bob' })
    expect(s.get()).toEqual([{ id: '1', name: 'Alicia' }, { id: '2', name: 'Bob' }])
    s.remove('1')
    expect(s.get()).toEqual([{ id: '2', name: 'Bob' }])
  })

  it('binding after the fact keeps what it already held', () => {
    const r = new EntryRegistry()
    const s = new Tether([{ id: 1, n: 1 }])
    s.bind({ registry: r, model: 'Item', idField: 'id' })
    expect(s.get()).toEqual([{ id: 1, n: 1 }])
    expect(r.peek('Item', 1)?.get()).toEqual({ id: 1, n: 1 })
  })
})

// ─── one row, many views ──────────────────────────────────────────────────────

describe('two resources over one model are one row', () => {
  it('a push through one list reaches the other list', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }], { limit: 20, offset: 0, total: 1 })
    const a = c.resource('items', { model: 'Item' })
    const b = c.resource('items', { model: 'Item' })
    await a.load()
    await b.load()
    restore()

    a.service._receive('patched', { id: 1, n: 9 })
    expect(a.tether.get()[0].n).toBe(9)
    expect(b.tether.get()[0].n).toBe(9)
  })

  it('two DIFFERENT services naming one model share the row', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }], { limit: 20, offset: 0, total: 1 })
    const own   = c.resource('orders', { model: 'Order' })
    const admin = c.resource('all-orders', { model: 'Order' })
    await own.load()
    await admin.load()
    restore()

    // The admin service announces; the row is the same row.
    admin.service._receive('patched', { id: 1, n: 7 })
    expect(own.tether.get()[0].n).toBe(7)
  })

  it('with no model stated the service name is the key, so two services do NOT share', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }], { limit: 20, offset: 0, total: 1 })
    const own   = c.resource('orders')
    const admin = c.resource('all-orders')
    await own.load()
    await admin.load()
    restore()

    admin.service._receive('patched', { id: 1, n: 7 })
    expect(own.tether.get()[0].n).toBe(1)
  })

  it('a push about a row no list holds still updates the entry', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1 }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('items', { model: 'Item' })
    await r.load()
    restore()

    r.service._receive('patched', { id: 99, n: 5 })
    expect(c.entries.peek('Item', 99)?.get()).toEqual({ id: 99, n: 5 })
  })
})

// ─── a view of one ────────────────────────────────────────────────────────────

describe('resource().record(id)', () => {
  it('fetches the row when nothing has read it, and answers it', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    expect(await row.ready).toEqual({ id: 1, status: 'pending' })
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
    m.restore()
  })

  it('two cold views of one row in one tick send one request (FJS-3389)', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', { model: 'Order' })
    const [a, b] = [r.record(1), r.record('1')]
    expect(await Promise.all([a.ready, b.ready])).toEqual([
      { id: 1, status: 'pending' }, { id: 1, status: 'pending' },
    ])
    expect(m.calls()).toBe(1)
    expect(b.get()).toEqual({ id: 1, status: 'pending' })
    m.restore()
  })

  it('a refused shared read is every waiting view\'s own failure (FJS-3389)', async () => {
    const c = client()
    const m = mockRow({ message: 'no' }, 403)
    const r = c.resource('orders', { model: 'Order' })
    const [a, b] = [r.record(1), r.record(1)]
    expect(await Promise.all([a.ready, b.ready])).toEqual([null, null])
    expect(m.calls()).toBe(1)
    expect(a.error()?.status).toBe(403)
    expect(b.error()?.status).toBe(403)
    m.restore()
  })

  it('does NOT fetch when a list has already read the row', async () => {
    const c = client()
    const list = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    list.restore()

    const m = mockRow({ id: 1, status: 'never asked' })
    const row = r.record(1)
    expect(await row.ready).toEqual({ id: 1, status: 'pending' })
    expect(m.calls()).toBe(0)
    m.restore()
  })

  it('moves when the row is announced — which is the whole of FJS-518', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    const seen: unknown[] = []
    row.subscribe(v => seen.push(v))
    r.service._receive('patched', { id: 1, status: 'paid' })

    expect(row.get()).toEqual({ id: 1, status: 'paid' })
    expect(seen).toEqual([{ id: 1, status: 'pending' }, { id: 1, status: 'paid' }])
  })

  it('ignores an announcement about another row', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    r.service._receive('patched', { id: 2, status: 'paid' })
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
  })

  it('a record view reached by a URL string tracks the row a list holds as a number', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const row = r.record('1')            // as it arrives from page.params
    expect(await row.ready).toEqual({ id: 1, status: 'pending' })
    r.service._receive('patched', { id: 1, status: 'paid' })
    expect(row.get()).toEqual({ id: 1, status: 'paid' })

    r.service._receive('removed', { id: 1 })
    expect(row.get()).toBeNull()
  })

  it('answers null once the row is removed, and says so to a subscriber', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    const seen: unknown[] = []
    row.subscribe(v => seen.push(v))
    r.service._receive('removed', { id: 1 })
    expect(row.get()).toBeNull()
    expect(seen).toEqual([{ id: 1, status: 'pending' }, null])
  })

  it('a record view does not shorten a list before that list has accounted for the removal', async () => {
    // Two resources over one service share a ServiceProxy, so their handlers
    // run in registration order. A record view clearing the shared entry would
    // take the row out from under whichever list ran second.
    const c = client()
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 2, offset: 0, total: 7 })
    const a = c.resource('items', { model: 'Item' })
    const b = c.resource('items', { model: 'Item' })
    await a.load()
    await b.load()
    const watching = a.record(1)
    restore()

    a.service._receive('removed', { id: 1 })
    expect(a.tether.get().map(r => r.id)).toEqual([2])
    expect(b.tether.get().map(r => r.id)).toEqual([2])
    expect(a.stale.get()).toBe(1)
    expect(b.stale.get()).toBe(1)
    expect(watching.get()).toBeNull()
  })

  it('release lets the entry expire; holding one keeps it', async () => {
    const c = client({ entryTtlMs: 1 })
    const m = mockRow({ id: 1 })
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    expect(c.entries.sweep(Date.now() + 5)).toBe(0)   // held
    row.release()
    expect(c.entries.sweep(Date.now() + 5)).toBe(1)
    expect(c.entries.peek('Order', 1)).toBeUndefined()
  })
})

// A refusal and a missing row are different answers to a person, and `ready`
// resolving `null` for both left a detail screen one vague sentence (`FJS-1063`,
// `FJS-D695`). The reason rides the view beside `get()`; `ready` keeps resolving.
describe('resource().record(id).error()', () => {
  const refuse = (status: number, name: string) => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name, message: name, code: status }), {
        status, headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    return { restore: () => { globalThis.fetch = original } }
  }

  it('tells a refusal from a row that is not there', async () => {
    const c = client()
    const r = c.resource('orders', { model: 'Order' })

    let m = refuse(403, 'Forbidden')
    const denied = r.record(1)
    expect(await denied.ready).toBeNull()
    expect(denied.error()).toEqual({ status: 403, code: 'Forbidden' })
    m.restore()

    m = refuse(404, 'NotFound')
    const missing = r.record(2)
    expect(await missing.ready).toBeNull()
    expect(missing.error()).toEqual({ status: 404, code: 'NotFound' })
    m.restore()
  })

  it('says status 0 when nothing answered at all', async () => {
    const c = client()
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r = c.resource('orders', { model: 'Order' })
    const row = r.record(1)
    expect(await row.ready).toBeNull()
    expect(row.error()?.status).toBe(0)
    globalThis.fetch = original
  })

  it('is null when the row was read, and clears when a later read succeeds', async () => {
    const c = client()
    const r = c.resource('orders', { model: 'Order' })
    let m = refuse(500, 'InternalServerError')
    const row = r.record(1)
    await row.ready
    expect(row.error()?.status).toBe(500)
    m.restore()

    const ok = mockRow({ id: 1, status: 'pending' })
    await row.refresh()
    ok.restore()
    expect(row.error()).toBeNull()
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
  })

  it('reaches a subscriber when a later read is refused, and keeps the row it knew', async () => {
    const c = client()
    const r = c.resource('orders', { model: 'Order' })
    const ok = mockRow({ id: 1, status: 'pending' })
    const row = r.record(1)
    await row.ready
    ok.restore()

    const seen: unknown[] = []
    row.subscribe(() => seen.push(row.error()?.status ?? null))
    const m = refuse(403, 'Forbidden')
    await row.refresh()
    m.restore()
    expect(seen).toEqual([null, 403])
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
  })

  it('a removed row is not found', async () => {
    const c = client()
    const r = c.resource('orders', { model: 'Order' })
    const ok = mockRow({ id: 1 })
    const row = r.record(1)
    await row.ready
    ok.restore()
    r.service._receive('removed', { id: 1 })
    expect(row.error()).toEqual({ status: 404, code: 'NotFound' })
  })

  it('reports the reason on a composed view too', async () => {
    const c = client()
    const r = c.resource('apps', { model: 'App' })
    const m = refuse(403, 'Forbidden')
    const row = r.record(1, { composed: true })
    expect(await row.ready).toBeNull()
    expect(row.error()).toEqual({ status: 403, code: 'Forbidden' })
    m.restore()
  })
})

// ─── a record across a revoke ─────────────────────────────────────────────────
// A revoke sends no frame about the row (`FJS-1738`), so the only things a
// held record can learn it from are a reconnect and a refused re-read
// (`FJS-1740`).

describe('resource().record(id) after the row stops being readable', () => {
  const answer = (status: number, body: unknown) => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    return { restore: () => { globalThis.fetch = original } }
  }
  const notFound = () => answer(404, { name: 'NotFound', message: 'NotFound', code: 404 })

  for (const composed of [false, true]) {
    it(`a re-read the server answers 404 empties the view (composed: ${composed})`, async () => {
      const c = client()
      const r = c.resource('pages', { model: 'Page' })
      const ok = answer(200, { id: 1, title: 'D' })
      const row = r.record(1, { composed })
      await row.ready
      ok.restore()
      expect(row.get()).toEqual({ id: 1, title: 'D' })

      const seen: unknown[] = []
      row.subscribe((v) => seen.push(v))
      const m = notFound()
      await row.refresh()
      m.restore()

      expect(row.get()).toBeNull()
      expect(row.error()).toEqual({ status: 404, code: 'NotFound' })
      expect(seen.at(-1)).toBeNull()
    })
  }

  it('a reconnect re-reads the view, and a 404 then empties it', async () => {
    const c: any = client()
    const r = c.resource('pages', { model: 'Page' })
    const ok = answer(200, { id: 1, title: 'D' })
    const row = r.record(1)
    await row.ready
    ok.restore()

    const realRandom = Math.random
    Math.random = () => 0
    const m = notFound()
    try {
      c._noteConnected({})
      c._noteDisconnected()
      c._noteConnected({})
      c._wsReady = false   // no socket exists; the re-read goes over HTTP
      for (let i = 0; i < 100 && row.get() != null; i++) await new Promise(res => setTimeout(res, 10))
    } finally {
      Math.random = realRandom
      m.restore()
    }
    expect(row.get()).toBeNull()
    expect(row.error()).toEqual({ status: 404, code: 'NotFound' })
  })

  it('a released view does not re-read on a reconnect', async () => {
    const c: any = client()
    const r = c.resource('pages', { model: 'Page' })
    const ok = mockRow({ id: 1, title: 'D' })
    const row = r.record(1)
    await row.ready
    row.release()
    const before = ok.calls()

    const realRandom = Math.random
    Math.random = () => 0
    try {
      c._noteConnected({})
      c._noteDisconnected()
      c._noteConnected({})
      c._wsReady = false   // no socket exists; the re-read goes over HTTP
      await new Promise(res => setTimeout(res, 30))
    } finally {
      Math.random = realRandom
      ok.restore()
    }
    expect(ok.calls()).toBe(before)
  })
})

// ─── optimism ─────────────────────────────────────────────────────────────────
// The overlay is the fourth thing `FJS-D138` names: a submitted mutation that
// has not come back. It sits on the entry, so every view of the row moves at
// once; it carries the INTENT rather than the value, which is what a rebase
// would replay; and it is settled against the MUTATION, so a second writer
// cannot clear it.

describe('resource().mutate()', () => {
  const held = () => {
    let release!: (v: unknown) => void
    let refuse!: (e: unknown) => void
    const promise = new Promise<never>((res, rej) => {
      release = res as (v: unknown) => void
      refuse  = rej
    })
    return { promise, release, refuse }
  }

  it('shows the intent at once and keeps the server row when it lands', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)

    expect(r.tether.get()[0].status).toBe('paid')          // before the call answers
    expect(c.entries.peek('Order', 1)!.committed()!.status).toBe('pending')
    expect(c.entries.peek('Order', 1)!.pending).toBe(true)

    gate.release({ id: 1, status: 'paid', paidAt: 'now' })
    await done

    expect(r.tether.get()[0]).toEqual({ id: 1, status: 'paid', paidAt: 'now' })
    expect(c.entries.peek('Order', 1)!.pending).toBe(false)
  })

  it('puts it back when the call throws, and rethrows', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)
    expect(r.tether.get()[0].status).toBe('paid')

    gate.refuse(new Error('403'))
    await expect(done).rejects.toThrow('403')

    expect(r.tether.get()[0].status).toBe('pending')
    expect(c.entries.peek('Order', 1)!.pending).toBe(false)
  })

  it('reaches every view of the row, not just the list it was called on', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const a = c.resource('orders', { model: 'Order' })
    const b = c.resource('orders', { model: 'Order' })
    await a.load()
    await b.load()
    const detail = a.record(1)
    await detail.ready
    restore()

    const gate = held()
    const done = a.mutate(1, { status: 'paid' }, () => gate.promise)

    expect(b.tether.get()[0].status).toBe('paid')
    expect(detail.get()!.status).toBe('paid')

    gate.release({ id: 1, status: 'paid' })
    await done
  })

  it('a second writer moves the truth underneath and does NOT clear the intent', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending', note: '' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)

    // Somebody else edits the note while our own write is in flight.
    r.service._receive('patched', { id: 1, status: 'pending', note: 'hello' })

    // Their change is visible; ours is still on top of it.
    expect(r.tether.get()[0]).toEqual({ id: 1, status: 'paid', note: 'hello' })
    expect(c.entries.peek('Order', 1)!.pending).toBe(true)

    gate.release({ id: 1, status: 'paid', note: 'hello' })
    await done
    expect(r.tether.get()[0]).toEqual({ id: 1, status: 'paid', note: 'hello' })
  })

  it('rolling back reveals what the second writer did — not what was there before', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending', note: '' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)
    r.service._receive('patched', { id: 1, status: 'pending', note: 'hello' })

    gate.refuse(new Error('nope'))
    await expect(done).rejects.toThrow('nope')

    expect(r.tether.get()[0]).toEqual({ id: 1, status: 'pending', note: 'hello' })
  })

  it('two mutations of one row fold in the order they were submitted', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, a: 0, b: 0 }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', { model: 'Order' })
    await r.load()
    restore()

    const first  = held()
    const second = held()
    const p1 = r.mutate(1, { a: 1 }, () => first.promise)
    const p2 = r.mutate(1, { a: 2, b: 9 }, () => second.promise)
    expect(r.tether.get()[0]).toEqual({ id: 1, a: 2, b: 9 })

    // The FIRST settles; the second is still in flight and still on top.
    first.release({ id: 1, a: 1, b: 0 })
    await p1
    expect(r.tether.get()[0]).toEqual({ id: 1, a: 2, b: 9 })

    second.release({ id: 1, a: 2, b: 9 })
    await p2
    expect(r.tether.get()[0]).toEqual({ id: 1, a: 2, b: 9 })
  })

  it('an intent that moves a sort key re-places the row in an ordered list', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }, { id: 2, n: 2 }], { limit: 20, offset: 0, total: 2 })
    const r = c.resource('items', { model: 'Item' })
    await r.load({}, { orderBy: 'n' })
    restore()

    const gate = held()
    const done = r.mutate(1, { n: 9 }, () => gate.promise)
    // The list materializes through the entry, so the optimistic value is what
    // any consumer sorts and renders.
    expect(r.tether.get().map(x => x.n)).toEqual([9, 2])

    gate.refuse(new Error('no'))
    await expect(done).rejects.toThrow('no')
    expect(r.tether.get().map(x => x.n)).toEqual([1, 2])
  })

  it('a null intent is a removal, and it comes back if the call fails', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 20, offset: 0, total: 2 })
    const r = c.resource('items', { model: 'Item' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, null, () => gate.promise)
    expect(r.tether.get().map(x => x.id)).toEqual([2])

    gate.refuse(new Error('403'))
    await expect(done).rejects.toThrow('403')
    expect(r.tether.get().map(x => x.id)).toEqual([1, 2])
  })
})

// ─── a view of one that is more than one ──────────────────────────────────────
//
// `FJS-533`. An entry holds ONE shape and `_write` REPLACES it, so a screen whose
// `get()` composes children — an `include:`, a `withWidgets()`, a count built
// per call — cannot read the entry: the first push carries the row alone and the
// children vanish with nothing said. Four of basecamp's five composed reads did
// exactly that when `record()` was first adopted. `composed: true` makes the
// entry the TRIGGER instead.
//
// The negative control is the block above: every case there is the same view
// with the entry AS the value, and none of them re-reads.

/** A row whose composed shape is whatever `answer()` says at the time. */
function mockComposed(answer: () => unknown) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify(answer()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original }, calls: () => calls }
}

describe('resource().record(id, { composed: true })', () => {
  it('keeps the children a push does not carry, by reading again', async () => {
    const c = client()
    let status = 'pending'
    const m = mockComposed(() => ({ id: 1, status, domains: [{ id: 9, host: 'a.test' }] }))
    const r = c.resource('apps', { model: 'App' })
    const row = r.record(1, { composed: true })
    await row.ready
    expect(row.get()).toEqual({ id: 1, status: 'pending', domains: [{ id: 9, host: 'a.test' }] })

    // The announcement carries the ROW — no domains, because a list never
    // asked for them. This is the shape that used to empty the screen.
    status = 'live'
    r.service._receive('patched', { id: 1, status: 'live' })
    await Promise.resolve(); await Promise.resolve(); await new Promise(r => setTimeout(r, 0))

    expect(row.get()).toEqual({ id: 1, status: 'live', domains: [{ id: 9, host: 'a.test' }] })
    expect(m.calls()).toBe(2)
    m.restore()
  })

  it('does not write its composed row into the entry, so a list keeps the list shape', async () => {
    const c = client()
    const list = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('apps', { model: 'App' })
    await r.load()
    list.restore()

    const m = mockComposed(() => ({ id: 1, status: 'pending', domains: [{ id: 9 }] }))
    const row = r.record(1, { composed: true })
    await row.ready
    expect(row.get()).toHaveProperty('domains')
    // The list is a view of the entry, and the entry was never handed children.
    expect(r.tether.get()).toEqual([{ id: 1, status: 'pending' }])
    m.restore()
  })

  it('reads even when a list has already filled the entry — the entry is not this value', async () => {
    const c = client()
    const list = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('apps', { model: 'App' })
    await r.load()
    list.restore()

    const m = mockComposed(() => ({ id: 1, status: 'pending', domains: [] }))
    const row = r.record(1, { composed: true })
    expect(await row.ready).toHaveProperty('domains')
    expect(m.calls()).toBe(1)
    m.restore()
  })

  it('coalesces a burst — three announcements are not three reads', async () => {
    const c = client()
    const m = mockComposed(() => ({ id: 1, domains: [] }))
    const r = c.resource('apps', { model: 'App' })
    const row = r.record(1, { composed: true })
    await row.ready
    expect(m.calls()).toBe(1)

    r.service._receive('patched', { id: 1, n: 1 })
    r.service._receive('patched', { id: 1, n: 2 })
    r.service._receive('patched', { id: 1, n: 3 })
    await new Promise(res => setTimeout(res, 5))

    // One read in flight, one more for everything that arrived while it was.
    expect(m.calls()).toBe(3)
    m.restore()
  })

  it("re-reads on `changed`, the announcement that names no row", async () => {
    // A bulk write or a `select: false` write carries a count and nothing else,
    // so no view can tell whether this row was in it. The list re-reads; so
    // does this, or a watched row goes stale under the writes that say least.
    const c = client()
    let n = 1
    const m = mockComposed(() => ({ id: 1, n, domains: [] }))
    const r = c.resource('apps', { model: 'App' })
    const row = r.record(1, { composed: true })
    await row.ready
    expect(row.get()).toMatchObject({ n: 1 })

    n = 2
    r.service._receive('changed', { model: 'App', operation: 'update', count: 12 })
    await new Promise(res => setTimeout(res, 5))
    expect(row.get()).toMatchObject({ n: 2 })
    m.restore()
  })

  it('still answers null once the row is removed', async () => {
    const c = client()
    const m = mockComposed(() => ({ id: 1, domains: [{ id: 9 }] }))
    const r = c.resource('apps', { model: 'App' })
    const row = r.record(1, { composed: true })
    await row.ready

    const seen: unknown[] = []
    row.subscribe(v => seen.push(v))
    r.service._receive('removed', { id: 1 })
    expect(row.get()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    m.restore()
  })
})
