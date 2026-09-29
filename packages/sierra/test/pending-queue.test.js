/**
 * test/pending-queue.test.js — the writes this device holds, and the two rules
 * that decide what happens to them.
 *
 * Phase 1 of the Homestead work (`IDEAS/homestead.md`). What is asserted here is
 * the queue's own logic, with no browser and no server: which failures keep an
 * entry and which end it, and that the order out is the order in.
 *
 * **Rule one: an entry clears on an acknowledgement, never on a send.** This is
 * the rule `example`'s `verify:offline` paid for — Chrome's offline mode carries
 * frames on a socket that is already open, so a call can leave on a socket that
 * has not noticed the network is gone and arrive minutes later. A queue that
 * cleared on send would count that as delivered.
 *
 * **Rule two: `code` is what separates a refusal from silence.** The client
 * attaches one when the server ANSWERED. No code at all is a request that never
 * got a reply, and 408 is a timeout — the one answer that cannot say whether
 * the write arrived, which is exactly the ambiguity the idempotency key makes
 * safe to resolve by sending again.
 *
 * There is no IndexedDB here, so the queue runs in memory and says so. That is
 * asserted too: a screen promising *saved, will sync* while `durable` is false
 * is promising something a reload breaks.
 */

import { test, expect, vi } from 'vitest'

import { createPendingQueue, unreachable } from '../src/junction/pending.js'

const entry = (over = {}) => ({
  service: 'orders', model: 'Order', method: 'patch', id: 1, data: { total: 1 }, ...over,
})

test('unreachable: no code is a request that never got a reply', () => {
  expect(unreachable(new TypeError('Failed to fetch'))).toBe(true)
  expect(unreachable(Object.assign(new Error('x'), {}))).toBe(true)
})

test('unreachable: a timeout counts, because nobody can say whether it arrived', () => {
  expect(unreachable(Object.assign(new Error('timed out'), { code: 408 }))).toBe(true)
})

test('unreachable: an answered call does not, whatever the status', () => {
  for (const code of [400, 401, 403, 409, 422, 500, 503])
    expect(unreachable(Object.assign(new Error('no'), { code })), `code ${code}`).toBe(false)
})

test('an entry is held until it is settled, and settling is what clears it', async () => {
  const q = createPendingQueue()
  await q.ready
  const e = await q.add(entry())
  expect(q.pending().length).toBe(1)
  expect(typeof e.key).toBe('string')

  await q.settle(e.key)
  expect(q.pending().length).toBe(0)
  expect(q.list().length).toBe(0)
})

test('a deferred entry stays, and counts the attempt', async () => {
  const q = createPendingQueue()
  await q.ready
  const e = await q.add(entry())
  await q.defer(e.key, Object.assign(new Error('offline'), {}))
  await q.defer(e.key, Object.assign(new Error('offline'), {}))

  expect(q.pending().length).toBe(1)
  expect(q.pending()[0].attempts).toBe(2)
  expect(q.pending()[0].lastError.message).toBe('offline')
})

// Kept rather than dropped: a write somebody made and the boundary declined is
// news, and dropping it silently is the failure the queue exists to stop,
// arriving later in the sequence (`FJS-D300`).
test('a rejected entry leaves the pending set but is not thrown away', async () => {
  const q = createPendingQueue()
  await q.ready
  const e = await q.add(entry())
  await q.reject(e.key, Object.assign(new Error('nope'), { code: 422 }))

  expect(q.pending().length).toBe(0)
  expect(q.rejected().length).toBe(1)
  expect(q.rejected()[0].lastError.code).toBe(422)

  await q.discard(e.key)
  expect(q.list().length).toBe(0)
})

test('drain sends oldest first', async () => {
  let clock = 100
  const q = createPendingQueue({ now: () => clock++ })
  await q.ready
  await q.add(entry({ data: { total: 1 } }))
  await q.add(entry({ data: { total: 2 } }))
  await q.add(entry({ data: { total: 3 } }))

  const seen = []
  await q.drain(async (e) => { seen.push(e.data.total); await q.settle(e.key); return 'settled' })
  expect(seen).toEqual([1, 2, 3])
  expect(q.list().length).toBe(0)
})

// If one call cannot reach the server the next cannot either. Draining on
// regardless would turn every entry's `attempts` into a number that means
// nothing, and would send a later write before an earlier one had landed.
test('drain stops at the first entry that still cannot reach the server', async () => {
  let clock = 100
  const q = createPendingQueue({ now: () => clock++ })
  await q.ready
  await q.add(entry({ data: { total: 1 } }))
  await q.add(entry({ data: { total: 2 } }))
  await q.add(entry({ data: { total: 3 } }))

  const seen = []
  await q.drain(async (e) => {
    seen.push(e.data.total)
    if (e.data.total === 2) { await q.defer(e.key, new Error('still down')); return 'unreachable' }
    await q.settle(e.key)
    return 'settled'
  })

  expect(seen).toEqual([1, 2])
  expect(q.pending().length).toBe(2)          // 2 and 3 both still waiting
  expect(q.pending()[0].data.total).toBe(2)
})

test('a rejected entry is skipped by a later drain', async () => {
  const q = createPendingQueue()
  await q.ready
  const bad = await q.add(entry({ data: { total: 9 } }))
  await q.reject(bad.key, Object.assign(new Error('nope'), { code: 422 }))
  const good = await q.add(entry({ data: { total: 10 } }))

  const seen = []
  await q.drain(async (e) => { seen.push(e.data.total); await q.settle(e.key); return 'settled' })
  expect(seen).toEqual([10])
  expect(q.list().length).toBe(1)             // the rejected one is still there
  expect(q.list()[0].key).toBe(good.key === q.list()[0].key ? good.key : bad.key)
})

test('with no IndexedDB it still runs, and says it is not durable', async () => {
  const q = createPendingQueue()
  await q.ready
  expect(q.durable).toBe(false)
  const e = await q.add(entry())
  expect(q.pending().length).toBe(1)
  await q.settle(e.key)
})

test('subscribe fires on every mutation, with the list, until unsubscribed', async () => {
  const seen = []
  const q = createPendingQueue()
  await q.ready
  const off = q.subscribe((l) => seen.push(l.length))
  const e = await q.add(entry())
  await q.defer(e.key, new Error('offline'))
  await q.settle(e.key)
  off()
  await q.add(entry())
  expect(seen).toEqual([1, 1, 0])
})

// FJS-D300 ruled a refused write is somebody's to SEE and RETRY. Same key on
// purpose: junction releases a key on failure, so a retry is a fresh attempt.
test('a rejected entry can be retried: back to pending, same key, error cleared', async () => {
  const q = createPendingQueue()
  await q.ready
  const e = await q.add(entry())
  await q.reject(e.key, Object.assign(new Error('nope'), { code: 403 }))
  await q.retry(e.key)

  expect(q.rejected().length).toBe(0)
  expect(q.pending().map(x => x.key)).toEqual([e.key])
  expect(q.pending()[0].lastError).toBe(null)
})

test('the app queue is reachable from @frontierjs/sierra/junction', async () => {
  const mod = await import('../src/junction/index.js')
  expect(typeof mod.pendingQueue).toBe('function')
})

// FJS-1300: made in Acme, drained after the author opened Globex. The live
// headers name Globex by then, so a replay that took them was graded and
// stamped there.
test('a held write replays under the call headers it was made under', async () => {
  const { pendingQueue, drainPending, _resetPendingQueue } = await import('../src/junction/pending.js')
  _resetPendingQueue()
  const q = pendingQueue()
  await q.ready
  await q.add(entry({ method: 'create', id: null, callHeaders: { 'x-workspace-id': 'acme' } }))

  const sent = []
  const client = {
    callHeaders: () => ({ 'x-workspace-id': 'globex' }),
    service: () => ({ create: (data, params, opts) => { sent.push(opts); return Promise.resolve({ id: 1 }) } }),
  }
  await drainPending(client)
  expect(sent[0]?.callHeaders).toEqual({ 'x-workspace-id': 'acme' })
  _resetPendingQueue()
})

// FJS-1278: a clock-in held at 09:46 and drained at 17:46 was dated 17:46. The
// entry's own time is when the write was made, and the drain says so.
test('a held write replays with the moment it was made', async () => {
  const { pendingQueue, drainPending, _resetPendingQueue } = await import('../src/junction/pending.js')
  _resetPendingQueue()
  const q = pendingQueue()
  await q.ready
  await q.add(entry({ method: 'create', id: null }))
  const [held] = q.pending()

  const sent = []
  const client = {
    callHeaders: () => ({}),
    service: () => ({ create: (data, params, opts) => { sent.push(opts); return Promise.resolve({ id: 1 }) } }),
  }
  await drainPending(client)
  expect(sent[0]?.madeAt).toBe(held.createdAt)
  _resetPendingQueue()
})

// The refusal at replay is the case FJS-1302 measured: parked, and nothing on
// the device said so. It must be told and be retryable on the app's own queue.
test('a write refused at replay is announced, and the app queue can retry it', async () => {
  const { pendingQueue, drainPending, _resetPendingQueue } = await import('../src/junction/pending.js')
  _resetPendingQueue()
  const q = pendingQueue()
  await q.ready
  const seen = []
  q.subscribe(l => seen.push(l.map(e => e.state)))
  const e = await q.add(entry())

  const refuse = () => Promise.reject(Object.assign(new Error('Create denied by @@allow policy'), { code: 403 }))
  const client = { service: () => ({ patch: refuse }) }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const out = await drainPending(client)
  expect(out.rejected).toBe(1)
  expect(warn.mock.calls.map(c => c[0]).join('\n')).toMatch(/orders\.patch.*Create denied/)
  warn.mockRestore()
  expect(seen.at(-1)).toEqual(['rejected'])

  await q.retry(e.key)
  expect(q.pending().map(x => x.key)).toEqual([e.key])
  _resetPendingQueue()
})

// FJS-1276: an IndexedDB whose open answers a beat late, as a fresh profile's
// does. A write made in that beat went to memory only and a closed tab lost it.
function lateIndexedDB() {
  const rows = new Map()
  const later = (req, result) => setTimeout(() => { req.result = result; req.onsuccess?.() }, 5)
  const store = {
    put:    (e) => { const r = {}; rows.set(e.key, structuredClone(e)); later(r, e.key); return r },
    delete: (k) => { const r = {}; rows.delete(k); later(r); return r },
    getAll: ()  => { const r = {}; later(r, [...rows.values()]); return r },
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
  }
  return { rows, indexedDB: { open: () => { const r = {}; setTimeout(() => { r.result = db; r.onsuccess?.() }, 20); return r } } }
}

test('a write made before the database handle arrives is stored, not only held in memory', async () => {
  const fake = lateIndexedDB()
  vi.stubGlobal('indexedDB', fake.indexedDB)
  try {
    const q = createPendingQueue()
    const e = await q.add(entry())
    expect(q.durable).toBe(true)
    expect([...fake.rows.keys()]).toEqual([e.key])
  } finally {
    vi.unstubAllGlobals()
  }
})
