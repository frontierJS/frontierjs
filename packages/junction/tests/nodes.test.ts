/**
 * tests/nodes.test.ts — one node per row, and a list is a VIEW over it
 *
 * `FJS-D138`. Before this a store was per-`resource()` call and held whole
 * rows, so two `createResource('orders')` in two route files were two copies,
 * and a row read with `service.get(id)` was a plain object no announcement
 * could reach (`FJS-518`).
 *
 * What is asserted here is the part that is easy to get subtly wrong:
 *
 *   • a node is keyed by the MODEL, so two services over one model are one row
 *   • a push updates a row nobody's list holds, because somebody else may be
 *     looking at it
 *   • the list's own membership and placement rules are UNCHANGED — they run
 *     on materialised rows, so `live-order.test.ts` is the negative control
 *   • an unbound Store is what it always was, which is what the fifteen Store
 *     cases in `client.test.ts` are the negative control for
 *   • a released node lingers for the TTL and then goes
 */

import { describe, it, expect } from 'bun:test'
import { createJunctionClient, Store } from '../src/client/index.ts'
import { NodeRegistry } from '../src/client/nodes.ts'

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

describe('NodeRegistry', () => {
  it('answers the same node for the same model and id', () => {
    const r = new NodeRegistry()
    expect(r.node('Order', 1)).toBe(r.node('Order', 1))
    expect(r.node('Order', 1)).not.toBe(r.node('Order', 2))
    expect(r.node('Order', 1)).not.toBe(r.node('Invoice', 1))
  })

  it('files a numeric id and its string spelling as ONE row — a URL carries a string', () => {
    const r = new NodeRegistry()
    expect(r.node('Order', 5)).toBe(r.node('Order', '5'))
    r.write('Order', { id: 5, n: 1 })
    expect(r.peek('Order', '5')?.get()).toEqual({ id: 5, n: 1 })
    expect(r.size).toBe(1)
  })

  it('refuses a record with no id — it cannot be matched to a row', () => {
    const r = new NodeRegistry()
    expect(r.write('Order', { ok: true })).toBeNull()
    expect(r.size).toBe(0)
  })

  it('a held node does not expire; a released one does', () => {
    const r = new NodeRegistry({ ttlMs: 1 })
    const held = r.node('Order', 1).hold()
    r.write('Order', { id: 1 })
    r.write('Order', { id: 2 })
    const release = r.node('Order', 2).hold()

    release()
    expect(r.sweep(Date.now() + 5)).toBe(1)
    expect(r.size).toBe(1)

    held()
    expect(r.sweep(Date.now() + 5)).toBe(1)
    expect(r.size).toBe(0)
  })

  it('a TTL of 0 drops a node the moment nothing holds it', () => {
    const r = new NodeRegistry({ ttlMs: 0 })
    const release = r.node('Order', 1).hold()
    r.write('Order', { id: 1 })
    expect(r.size).toBe(1)
    release()
    expect(r.size).toBe(0)
  })

  it('a node hold is idempotent — releasing twice does not drop somebody else\'s', () => {
    const r = new NodeRegistry({ ttlMs: 0 })
    const n = r.node('Order', 1)
    const a = n.hold()
    const b = n.hold()
    a(); a(); a()
    expect(r.size).toBe(1)
    b()
    expect(r.size).toBe(0)
  })
})

// ─── an unbound Store is what it always was ───────────────────────────────────

describe('Store, unbound', () => {
  it('holds its own rows and never reaches a registry', () => {
    const s = new Store([{ id: '1', name: 'Alice' }])
    s.upsert({ id: '1', name: 'Alicia' })
    s.upsert({ id: '2', name: 'Bob' })
    expect(s.get()).toEqual([{ id: '1', name: 'Alicia' }, { id: '2', name: 'Bob' }])
    s.remove('1')
    expect(s.get()).toEqual([{ id: '2', name: 'Bob' }])
  })

  it('binding after the fact keeps what it already held', () => {
    const r = new NodeRegistry()
    const s = new Store([{ id: 1, n: 1 }])
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
    const a = c.resource('items', 'id', { model: 'Item' })
    const b = c.resource('items', 'id', { model: 'Item' })
    await a.load()
    await b.load()
    restore()

    a.service._receive('patched', { id: 1, n: 9 })
    expect(a.store.get()[0].n).toBe(9)
    expect(b.store.get()[0].n).toBe(9)
  })

  it('two DIFFERENT services naming one model share the row', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }], { limit: 20, offset: 0, total: 1 })
    const own   = c.resource('orders',     'id', { model: 'Order' })
    const admin = c.resource('all-orders', 'id', { model: 'Order' })
    await own.load()
    await admin.load()
    restore()

    // The admin service announces; the row is the same row.
    admin.service._receive('patched', { id: 1, n: 7 })
    expect(own.store.get()[0].n).toBe(7)
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
    expect(own.store.get()[0].n).toBe(1)
  })

  it('a push about a row no list holds still updates the node', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1 }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('items', 'id', { model: 'Item' })
    await r.load()
    restore()

    r.service._receive('patched', { id: 99, n: 5 })
    expect(c.nodes.peek('Item', 99)?.get()).toEqual({ id: 99, n: 5 })
  })
})

// ─── a view of one ────────────────────────────────────────────────────────────

describe('resource().record(id)', () => {
  it('fetches the row when nothing has read it, and answers it', async () => {
    const c = client()
    const m = mockRow({ id: 1, status: 'pending' })
    const r = c.resource('orders', 'id', { model: 'Order' })
    const row = r.record(1)
    expect(await row.ready).toEqual({ id: 1, status: 'pending' })
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
    m.restore()
  })

  it('does NOT fetch when a list has already read the row', async () => {
    const c = client()
    const list = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
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
    const r = c.resource('orders', 'id', { model: 'Order' })
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
    const r = c.resource('orders', 'id', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    r.service._receive('patched', { id: 2, status: 'paid' })
    expect(row.get()).toEqual({ id: 1, status: 'pending' })
  })

  it('a record view reached by a URL string tracks the row a list holds as a number', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
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
    const r = c.resource('orders', 'id', { model: 'Order' })
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
    // run in registration order. A record view clearing the shared node would
    // take the row out from under whichever list ran second.
    const c = client()
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 2, offset: 0, total: 7 })
    const a = c.resource('items', 'id', { model: 'Item' })
    const b = c.resource('items', 'id', { model: 'Item' })
    await a.load()
    await b.load()
    const watching = a.record(1)
    restore()

    a.service._receive('removed', { id: 1 })
    expect(a.store.get().map(r => r.id)).toEqual([2])
    expect(b.store.get().map(r => r.id)).toEqual([2])
    expect(a.stale.get()).toBe(1)
    expect(b.stale.get()).toBe(1)
    expect(watching.get()).toBeNull()
  })

  it('release lets the node expire; holding one keeps it', async () => {
    const c = client({ nodeTtlMs: 1 })
    const m = mockRow({ id: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
    const row = r.record(1)
    await row.ready
    m.restore()

    expect(c.nodes.sweep(Date.now() + 5)).toBe(0)   // held
    row.release()
    expect(c.nodes.sweep(Date.now() + 5)).toBe(1)
    expect(c.nodes.peek('Order', 1)).toBeUndefined()
  })
})

// ─── optimism ─────────────────────────────────────────────────────────────────
// The overlay is the fourth thing `FJS-D138` names: a submitted mutation that
// has not come back. It sits on the node, so every view of the row moves at
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
    const r = c.resource('orders', 'id', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)

    expect(r.store.get()[0].status).toBe('paid')          // before the call answers
    expect(c.nodes.peek('Order', 1)!.committed()!.status).toBe('pending')
    expect(c.nodes.peek('Order', 1)!.pending).toBe(true)

    gate.release({ id: 1, status: 'paid', paidAt: 'now' })
    await done

    expect(r.store.get()[0]).toEqual({ id: 1, status: 'paid', paidAt: 'now' })
    expect(c.nodes.peek('Order', 1)!.pending).toBe(false)
  })

  it('puts it back when the call throws, and rethrows', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)
    expect(r.store.get()[0].status).toBe('paid')

    gate.refuse(new Error('403'))
    await expect(done).rejects.toThrow('403')

    expect(r.store.get()[0].status).toBe('pending')
    expect(c.nodes.peek('Order', 1)!.pending).toBe(false)
  })

  it('reaches every view of the row, not just the list it was called on', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending' }], { limit: 20, offset: 0, total: 1 })
    const a = c.resource('orders', 'id', { model: 'Order' })
    const b = c.resource('orders', 'id', { model: 'Order' })
    await a.load()
    await b.load()
    const detail = a.record(1)
    await detail.ready
    restore()

    const gate = held()
    const done = a.mutate(1, { status: 'paid' }, () => gate.promise)

    expect(b.store.get()[0].status).toBe('paid')
    expect(detail.get()!.status).toBe('paid')

    gate.release({ id: 1, status: 'paid' })
    await done
  })

  it('a second writer moves the truth underneath and does NOT clear the intent', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending', note: '' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)

    // Somebody else edits the note while our own write is in flight.
    r.service._receive('patched', { id: 1, status: 'pending', note: 'hello' })

    // Their change is visible; ours is still on top of it.
    expect(r.store.get()[0]).toEqual({ id: 1, status: 'paid', note: 'hello' })
    expect(c.nodes.peek('Order', 1)!.pending).toBe(true)

    gate.release({ id: 1, status: 'paid', note: 'hello' })
    await done
    expect(r.store.get()[0]).toEqual({ id: 1, status: 'paid', note: 'hello' })
  })

  it('rolling back reveals what the second writer did — not what was there before', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, status: 'pending', note: '' }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, { status: 'paid' }, () => gate.promise)
    r.service._receive('patched', { id: 1, status: 'pending', note: 'hello' })

    gate.refuse(new Error('nope'))
    await expect(done).rejects.toThrow('nope')

    expect(r.store.get()[0]).toEqual({ id: 1, status: 'pending', note: 'hello' })
  })

  it('two mutations of one row fold in the order they were submitted', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, a: 0, b: 0 }], { limit: 20, offset: 0, total: 1 })
    const r = c.resource('orders', 'id', { model: 'Order' })
    await r.load()
    restore()

    const first  = held()
    const second = held()
    const p1 = r.mutate(1, { a: 1 }, () => first.promise)
    const p2 = r.mutate(1, { a: 2, b: 9 }, () => second.promise)
    expect(r.store.get()[0]).toEqual({ id: 1, a: 2, b: 9 })

    // The FIRST settles; the second is still in flight and still on top.
    first.release({ id: 1, a: 1, b: 0 })
    await p1
    expect(r.store.get()[0]).toEqual({ id: 1, a: 2, b: 9 })

    second.release({ id: 1, a: 2, b: 9 })
    await p2
    expect(r.store.get()[0]).toEqual({ id: 1, a: 2, b: 9 })
  })

  it('an intent that moves a sort key re-places the row in an ordered list', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1, n: 1 }, { id: 2, n: 2 }], { limit: 20, offset: 0, total: 2 })
    const r = c.resource('items', 'id', { model: 'Item' })
    await r.load({}, { orderBy: 'n' })
    restore()

    const gate = held()
    const done = r.mutate(1, { n: 9 }, () => gate.promise)
    // The list materialises through the node, so the optimistic value is what
    // any consumer sorts and renders.
    expect(r.store.get().map(x => x.n)).toEqual([9, 2])

    gate.refuse(new Error('no'))
    await expect(done).rejects.toThrow('no')
    expect(r.store.get().map(x => x.n)).toEqual([1, 2])
  })

  it('a null intent is a removal, and it comes back if the call fails', async () => {
    const c = client()
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 20, offset: 0, total: 2 })
    const r = c.resource('items', 'id', { model: 'Item' })
    await r.load()
    restore()

    const gate = held()
    const done = r.mutate(1, null, () => gate.promise)
    expect(r.store.get().map(x => x.id)).toEqual([2])

    gate.refuse(new Error('403'))
    await expect(done).rejects.toThrow('403')
    expect(r.store.get().map(x => x.id)).toEqual([1, 2])
  })
})
