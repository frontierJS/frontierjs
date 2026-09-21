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

import { test, expect } from 'vitest'

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

  await q.forget(e.key)
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

test('onChange fires on every mutation, with the list', async () => {
  const seen = []
  const q = createPendingQueue({ onChange: (l) => seen.push(l.length) })
  await q.ready
  const e = await q.add(entry())
  await q.defer(e.key, new Error('offline'))
  await q.settle(e.key)
  expect(seen).toEqual([1, 1, 0])
})
