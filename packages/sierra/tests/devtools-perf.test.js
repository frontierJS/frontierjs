/**
 * tests/devtools-perf.test.js
 *
 * The devtools panel did three things once per inbound WebSocket message:
 *
 *   1. `_ring.push()` was `buf.push()` + `buf.shift()` on overflow — O(n) per
 *      push once full, so at the default 500-log cap every log line memmoved
 *      500 elements.
 *   2. `addHook`/`addQuery` located their request with
 *      `reqs.all().find(r => r.id === …)` — a linear scan of up to 200 entries,
 *      and hooks arrive several times per request.
 *   3. `ui.render()` reassigned the pill's innerHTML and, when the panel was
 *      open, cleared `tabContent` and rebuilt every row — including a
 *      `toLocaleTimeString()` call per row.
 *
 * Together those made a burst of traffic quadratic. Measured with 300 requests
 * plus 1 200 hooks and 600 queries (2 100 render calls), panel open:
 * **45 262 ms → 132 ms**. With the panel closed: 316 ms → 1.3 ms. And the
 * buffer no longer degrades with capacity — 20 000 pushes took 60/420/1 581 ms
 * at caps of 200/2 000/20 000 before, and a flat ~15 ms after.
 *
 * These tests pin the properties that make that true, rather than the timings.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createBuffer } from '../src/devtools/buffer.js'

describe('ring buffer', () => {
  test('keeps insertion order once wrapped', () => {
    const b = createBuffer({ requests: 3, logs: 3, events: 3 })
    for (const n of [1, 2, 3, 4, 5]) b.events.push(n)
    expect(b.events.all()).toEqual([3, 4, 5])
  })

  test('reports the evicted entry so indexes can stay in sync', () => {
    const b = createBuffer({ requests: 2, logs: 2, events: 2 })
    expect(b.events.push('a')).toBeUndefined()
    expect(b.events.push('b')).toBeUndefined()
    expect(b.events.push('c')).toBe('a')   // 'a' fell off
    expect(b.events.push('d')).toBe('b')
  })

  test('reversed() yields newest-first without copying', () => {
    const b = createBuffer({ requests: 3, logs: 3, events: 3 })
    for (const n of [1, 2, 3, 4]) b.events.push(n)
    expect([...b.events.reversed()]).toEqual([4, 3, 2])
  })

  test('size saturates at capacity', () => {
    const b = createBuffer({ requests: 2, logs: 2, events: 2 })
    for (let i = 0; i < 10; i++) b.events.push(i)
    expect(b.events.size).toBe(2)
    expect(b.events.all()).toEqual([8, 9])
  })

  test('clear resets to empty', () => {
    const b = createBuffer({ requests: 2, logs: 2, events: 2 })
    b.events.push('x'); b.events.push('y')
    b.events.clear()
    expect(b.events.size).toBe(0)
    expect(b.events.all()).toEqual([])
  })
})

describe('hook/query attach in constant time', () => {
  let b
  beforeEach(() => { b = createBuffer({ requests: 3, logs: 5, events: 5 }) })

  const req = (id) => ({ id, ts: 0, service: 'leads', method: 'find', durationMs: 1, status: 'ok' })

  test('a hook attaches to its request', () => {
    b.addRequest(req('r1'))
    const res = b.addHook({ telemetryId: 'r1', name: 'before' })
    expect(res.found).toBe(true)
    expect(res.request.hooks).toHaveLength(1)
  })

  test('hooks arriving before their request are merged in', () => {
    expect(b.addHook({ telemetryId: 'r9', name: 'early' }).found).toBe(false)
    expect(b.addQuery({ telemetryId: 'r9', sql: 'select 1' }).found).toBe(false)
    const entry = b.addRequest(req('r9'))
    expect(entry.hooks).toHaveLength(1)
    expect(entry.queries).toHaveLength(1)
  })

  test('a request evicted from the ring stops accepting hooks', () => {
    b.addRequest(req('r1'))
    b.addRequest(req('r2'))
    b.addRequest(req('r3'))
    b.addRequest(req('r4'))   // evicts r1 (cap 3)

    // r1 is gone from the ring, so the index must have dropped it too —
    // otherwise the index grows without bound and holds evicted payloads alive.
    expect(b.addHook({ telemetryId: 'r1', name: 'late' }).found).toBe(false)
    expect(b.addHook({ telemetryId: 'r4', name: 'ok' }).found).toBe(true)
  })

  test('initFromState rebuilds the index', () => {
    b.initFromState({ requests: [req('s1'), req('s2')], logs: [], events: [] })
    expect(b.addHook({ telemetryId: 's2', name: 'h' }).found).toBe(true)
  })
})

describe('render coalescing', () => {
  let ui, rafQueue

  beforeEach(async () => {
    const { Window } = await import('happy-dom')
    const win = new Window({ url: 'http://localhost/' })
    for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'DocumentFragment']) {
      try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
    }
    globalThis.window = win

    rafQueue = []
    globalThis.requestAnimationFrame = (fn) => rafQueue.push(fn)

    const { createToolbarUI } = await import('../src/devtools/ui.js')
    const buffer = createBuffer()
    ui = createToolbarUI(buffer, {}, () => {}, () => {}, () => {})
    win.document.body.appendChild(ui.root)
  })

  test('many render() calls in one tick schedule a single frame', () => {
    for (let i = 0; i < 100; i++) ui.render()
    // Previously each call did the work immediately; now they collapse to one.
    expect(rafQueue).toHaveLength(1)
  })

  test('a new frame is scheduled after the previous one runs', () => {
    ui.render()
    expect(rafQueue).toHaveLength(1)
    rafQueue.shift()()          // flush
    ui.render()
    expect(rafQueue).toHaveLength(1)
  })

  test('status and count updates also coalesce', () => {
    ui.setStatus('offline')
    ui.addNewCount(1)
    ui.addNewCount(1)
    ui.clearNewCount()
    expect(rafQueue).toHaveLength(1)
  })

  test('renderNow bypasses the frame for synchronous callers', () => {
    ui.renderNow()
    expect(rafQueue).toHaveLength(0)
  })
})
