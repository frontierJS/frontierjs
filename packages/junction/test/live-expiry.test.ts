/**
 * test/live-expiry.test.ts — a row the clock takes out leaves the list (`FJS-1274`)
 *
 * Expiry's transition is the clock, not a write, so no frame is ever emitted
 * for it: a list holding a `StockReservation` that lapses at 14:05 held it at
 * 15:00. The store holds the rows, so it holds the timer (`FJS-D489`) — one,
 * for the soonest edge — and drops a row whose window has closed.
 */

import { describe, it, expect } from 'bun:test'
import { createJunctionClient, type QueryDirectives } from '../src/client/index.ts'
import { leavesAt } from '@frontierjs/toolbelt/match'

function mockList(rows: unknown[]) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ kind: 'list', object: 'items', data: rows, errors: [], total: rows.length, limit: 20, offset: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

const WINDOW = { from: null, to: 'expiresAt', kind: 'instant' as const, imposed: true }
const until  = (r: Record<string, unknown>, p: QueryDirectives) => leavesAt(WINDOW, r, p)
const wait   = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('a live list drops a row whose window closes', () => {
  it('with no frame, at the edge', async () => {
    const soon  = new Date(Date.now() + 40).toISOString()
    const later = new Date(Date.now() + 60_000).toISOString()
    const { restore } = mockList([{ id: 1, expiresAt: soon }, { id: 2, expiresAt: later }, { id: 3, expiresAt: null }])
    const { store, load } = createJunctionClient({ url: 'http://localhost:3000' }).resource('items', 'id', { until })
    await load()
    restore()

    expect(store.get().map(r => r.id)).toEqual([1, 2, 3])
    await wait(80)
    expect(store.get().map(r => r.id)).toEqual([2, 3])
  })

  it('a pushed row with an edge arms the timer too', async () => {
    const { restore } = mockList([])
    const { service, store, load } = createJunctionClient({ url: 'http://localhost:3000' }).resource('items', 'id', { until })
    await load()
    restore()

    service._receive('created', { id: 9, expiresAt: new Date(Date.now() + 30).toISOString() })
    expect(store.get().map(r => r.id)).toEqual([9])
    await wait(70)
    expect(store.get()).toEqual([])
  })

  it('a read that stepped outside the window keeps what it holds', async () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const { restore } = mockList([{ id: 1, expiresAt: past }])
    const { store, load } = createJunctionClient({ url: 'http://localhost:3000' }).resource('items', 'id', { until })
    await load({}, { withExpired: true } as never)
    restore()
    await wait(20)
    expect(store.get().map(r => r.id)).toEqual([1])
  })
})

describe('leavesAt', () => {
  it('only an imposed window moves with the clock', () => {
    const row = { expiresAt: '2026-09-28T14:05:00.000Z' }
    expect(leavesAt(WINDOW, row)).toBe(Date.parse('2026-09-28T14:05:00.000Z'))
    expect(leavesAt({ ...WINDOW, imposed: false }, row)).toBeNull()
    expect(leavesAt(WINDOW, row, { asOf: '2026-01-01' })).toBeNull()
    expect(leavesAt(WINDOW, { expiresAt: null })).toBeNull()
    expect(leavesAt(null, row)).toBeNull()
  })

  it('a day edge is exclusive, from that day\'s first UTC instant', () => {
    expect(leavesAt({ ...WINDOW, kind: 'day' }, { expiresAt: '2026-09-28' }))
      .toBe(Date.parse('2026-09-28T00:00:00Z'))
  })
})
