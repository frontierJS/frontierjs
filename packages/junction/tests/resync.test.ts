// tests/resync.test.ts — a reconnect is a gap, and it used to be a silent one
//
// The server queues nothing for an absent socket, so every write between a drop
// and the next `connected` frame reached this client and nobody else's copy of
// it. `resource.stale` exists to count exactly this and read 0, with nothing on
// screen saying anything was missing (`FJS-701`).
//
// There is no sequence number and this deliberately does not add one — see the
// comment at the `resync` emit. A reconnect reloads, which is the same answer
// this store already gives `changed` and an undecidable record: *some unknown
// rows moved*, and nothing in a browser can know which.

import { describe, it, expect } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

/** Answer every fetch with whatever `rows()` says at the time of the call. */
function mockList(rows: () => unknown[]) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const data = rows()
    return new Response(
      JSON.stringify({ kind: 'list', object: 'items', data, errors: [], total: data.length, limit: 20, offset: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original }, get calls() { return calls } }
}

const client = () => createJunctionClient({ url: 'http://localhost:3000' })

/** The frames the socket would have delivered, without a socket. */
const connected = (c: any) => c.emit('connect') // not the real path; see below

describe('the client can tell a first connection from a re-connection', () => {

  it('the first `connected` frame emits no resync — there was nothing to miss', () => {
    const c: any = client()
    const seen: unknown[] = []
    c.on('resync', (p: unknown) => seen.push(p))

    c._noteConnected({})
    expect(seen).toEqual([])
  })

  it('a `connected` frame after a drop emits one, carrying how long it was down', async () => {
    const c: any = client()
    const seen: any[] = []
    c.on('resync', (p: unknown) => seen.push(p))

    c._noteConnected({})
    c._noteDisconnected()
    await new Promise(r => setTimeout(r, 15))
    c._noteConnected({})

    expect(seen.length).toBe(1)
    expect(seen[0].downMs).toBeGreaterThanOrEqual(10)
  })

  it('a second reconnect emits a second one — it is per outage, not once', () => {
    const c: any = client()
    let n = 0
    c.on('resync', () => { n++ })

    c._noteConnected({})
    c._noteDisconnected(); c._noteConnected({})
    c._noteDisconnected(); c._noteConnected({})
    expect(n).toBe(2)
  })
})

describe('a live list reloads across a reconnect', () => {

  it('recovers a row written while the socket was down', async () => {
    // The write happened in the gap: no `created` frame reached this client,
    // and nothing about the list says a row is missing.
    let rows: unknown[] = [{ id: 1, n: 1 }]
    const m = mockList(() => rows)
    const c: any = client()
    const { store, load } = c.resource('items')
    await load({}, {})
    expect(store.get().map((r: any) => r.id)).toEqual([1])

    rows = [{ id: 1, n: 1 }, { id: 2, n: 2 }]
    c._noteConnected({})       // first connection — no resync
    expect(store.get().length).toBe(1)

    c._noteDisconnected()
    c._noteConnected({})       // this one is a resync

    // Jittered up to 2s, so the assertion waits rather than assuming a tick.
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && store.get().length < 2) await new Promise(r => setTimeout(r, 25))
    expect(store.get().map((r: any) => r.id)).toEqual([1, 2])
    m.restore()
  })

  it('a list that never loaded does not fetch on a reconnect — the control', async () => {
    // `refetch` is a re-ask of the last query, and there is no last query. A
    // resource a screen created and never loaded must not start querying
    // because the network blipped.
    const m = mockList(() => [])
    const c: any = client()
    c.resource('items')
    const before = m.calls

    c._noteConnected({})
    c._noteDisconnected()
    c._noteConnected({})
    await new Promise(r => setTimeout(r, 2500))

    expect(m.calls).toBe(before)
    m.restore()
  })

  it('the reload is JITTERED, not in the same tick as every other client', async () => {
    // A deploy drops every socket at once, so this fires on all of them
    // together — an unjittered reload is the whole fleet querying in one tick,
    // which is `FJS-703`'s shape one layer up.
    let rows: unknown[] = [{ id: 1 }]
    const m = mockList(() => rows)
    const c: any = client()
    const { load } = c.resource('items')
    await load({}, {})
    const after = m.calls

    c._noteConnected({})
    c._noteDisconnected()
    c._noteConnected({})

    // Nothing in the same tick: the point is that it is NOT immediate.
    await new Promise(r => setTimeout(r, 0))
    expect(m.calls).toBe(after)
    m.restore()
  })
})

void connected
