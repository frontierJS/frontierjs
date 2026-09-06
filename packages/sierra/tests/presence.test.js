/**
 * tests/presence.test.js — `@frontierjs/sierra/presence`
 *
 * This file used to invent the junction client it graded. It hand-wrote
 * `send()`, `connectionId`, `connected` and an `emit` that dispatched
 * `presence:sync:workspace:1` — five channel-suffixed names junction has never
 * emitted, and two members it has never had. So every assertion in it was true
 * of a client nobody ships, while the published `@frontierjs/sierra/presence`
 * threw `TypeError: client.send is not a function` on its first line for its
 * whole life and no app could use it (`FJS-811`). That is disease D1 of the
 * 2026-09-04 audit — *the fake client is the specification* — in its purest
 * form, and the fix is this file being rebuilt against the real thing.
 *
 * Two halves, and both use the REAL `createJunctionClient`:
 *
 *   · THE SEAM — a real Junction app in a bun subprocess, two real sockets on
 *     one channel. Nothing else can say whether presence works at all.
 *   · THE REDUCERS — the diff/leave/dedupe/self logic, driven by pushing real
 *     frame SHAPES through the real client's own emitter. Not a stand-in: the
 *     client is real and the shapes are the ones the half above proves the
 *     server sends.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJunctionClient } from '@frontierjs/junction/client'
import { presence, _resetPresenceHolders } from '../src/presence/index.js'

const PKG  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 7924
const API  = `http://127.0.0.1:${PORT}`

const ROOM  = 'room:a'
const OTHER = 'room:nobody-joins-this'   // real channel name, never joined

// ─── The real junction app ───────────────────────────────────────────────────

let server

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`[presence] nothing answered ${url} within ${ms}ms`)
}

beforeAll(async () => {
  server = spawn('bun', ['tests/fixtures/presence-server.ts', String(PORT)], {
    cwd: PKG, stdio: 'ignore',
  })
  await waitFor(`${API}/ping`)
}, 30000)

afterAll(() => { server?.kill() })

// ─── Environment ─────────────────────────────────────────────────────────────

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms))

let _client = null
let _open   = []

// presence() reaches its client through getClient(), and onDestroy() through
// Mesa's component scope — neither of which exists outside a running app. The
// module under test is the whole of what is real here; these two are the seams
// it is reached BY.
vi.mock('../src/junction/index.js', () => ({ getClient: () => _client }))
// Only `onDestroy` is stubbed — it needs a component scope, which no test has.
// `createSignal` is left REAL: `signal()` is what the store is, so mocking it
// would make every assertion below a conversation with the mock.
vi.mock('@frontierjs/mesa/runtime', async (importOriginal) => ({
  ...(await importOriginal()),
  onDestroy: () => {},
}))

async function connect(token) {
  const client = createJunctionClient({ url: API })
  _open.push(client)
  if (token) client.setToken(token)
  else client.connect()
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('never connected')), 8000)
    client.once('connect', () => { clearTimeout(t); res() })
  })
  return client
}

beforeEach(() => { _resetPresenceHolders() })

afterEach(() => {
  _open.forEach(c => { try { c.disconnect() } catch {} })
  _open = []
  _client = null
})

// ─── The seam ────────────────────────────────────────────────────────────────

describe('presence() against a real junction client and a real app', () => {

  test('it runs at all, and the roster comes back', async () => {
    // The whole finding in one line: this threw before there was a verb to call.
    _client = await connect('tok-alice')
    const members = presence(ROOM, { meta: { name: 'Alice' } })
    await settle()

    expect(members.get().count).toBe(1)
    expect(members.get().members[0].userId).toBe('alice')
    expect(members.get().members[0].meta).toEqual({ name: 'Alice' })
  }, 20000)

  test('and a channel the app never joined this connection to stays empty', async () => {
    // The pair. A module that filled its store from any frame that arrived, and
    // a server that answered any channel name, both satisfy the row above.
    _client = await connect('tok-alice')
    const members = presence(OTHER, { meta: { name: 'Alice' } })
    await settle()

    expect(members.get().count).toBe(0)
  }, 20000)

  test('self is this connection, and others is everybody else', async () => {
    // `self` is the one thing a browser cannot work out for itself: it is never
    // told its connection id. The module used to read `client.connectionId`,
    // which is undefined, so every member was an "other" — including you.
    const alice = await connect('tok-alice')
    const bob   = await connect('tok-bob')

    _client = alice
    const aView = presence(ROOM, { meta: { name: 'Alice' } })
    _client = bob
    const bView = presence(ROOM, { meta: { name: 'Bob' } })
    await settle(400)

    expect(aView.get().count).toBe(2)
    expect(aView.get().self?.meta).toEqual({ name: 'Alice' })
    expect(aView.get().others.map(m => m.meta.name)).toEqual(['Bob'])

    expect(bView.get().self?.meta).toEqual({ name: 'Bob' })
    expect(bView.get().others.map(m => m.meta.name)).toEqual(['Alice'])
  }, 20000)

  test('a second connection arriving reaches the first one\'s store', async () => {
    _client = await connect('tok-alice')
    const members = presence(ROOM, { meta: { name: 'Alice' } })
    await settle()
    expect(members.get().count).toBe(1)

    const bob = await connect('tok-bob')
    await settle(400)
    expect(members.get().count).toBe(2)

    bob.disconnect()
    await settle(400)
    expect(members.get().count).toBe(1)
  }, 20000)

  test('updateMeta reaches the other connection', async () => {
    const alice = await connect('tok-alice')
    const bob   = await connect('tok-bob')
    _client = alice
    const aView = presence(ROOM, { meta: { name: 'Alice' } })
    _client = bob
    const bView = presence(ROOM, { meta: { name: 'Bob' } })
    await settle(400)

    bView.updateMeta({ name: 'Bob', typing: true })
    await settle(400)

    expect(aView.get().others[0].meta).toEqual({ name: 'Bob', typing: true })
  }, 20000)

  // ── FJS-824 — two components, one channel ────────────────────────────────

  test('one component leaving does not blind another on the same channel', async () => {
    // An avatar strip in the header and a list in the sidebar. `leave()` used to
    // send `unsubscribe` unconditionally, so the first unmount spoke for both.
    _client = await connect('tok-alice')
    const header  = presence(ROOM, { meta: { name: 'Alice' } })
    const sidebar = presence(ROOM, { meta: { name: 'Alice' } })
    await connect('tok-bob')
    await settle(400)

    expect(sidebar.get().count).toBe(2)

    header.leave()             // the header unmounts; the sidebar is still shown
    await settle(200)

    // The sidebar is still being told about the channel.
    sidebar.updateMeta({ name: 'Alice', still: 'here' })
    await settle(300)
    expect(sidebar.get().count).toBe(2)
    expect(sidebar.get().self?.meta).toEqual({ name: 'Alice', still: 'here' })
  }, 25000)

  test('and the LAST one leaving does release it — the count is not a leak', async () => {
    // The pair for the row above. A refcount that never reaches zero satisfies
    // every assertion that only asks whether the survivor still works.
    _client = await connect('tok-alice')
    const header  = presence(ROOM)
    const sidebar = presence(ROOM)
    const sent = []
    const raw = _client._ws.send.bind(_client._ws)
    _client._ws.send = m => { sent.push(JSON.parse(m)); return raw(m) }

    header.leave()
    expect(sent.filter(m => m.type === 'unsubscribe')).toEqual([])

    sidebar.leave()
    expect(sent.filter(m => m.type === 'unsubscribe'))
      .toEqual([{ type: 'unsubscribe', channel: ROOM }])
  }, 20000)
})

// ─── The reducers ────────────────────────────────────────────────────────────
//
// Driven through the real client's own emitter, with the frame shapes the seam
// above proves the server sends. `presence:diff` is the one that matters most:
// junction batches join and leave per channel per window, because a join used to
// send a frame to every existing member and N connections cost N x (N-1) frames
// (`FJS-703`), and a client that only knows the unbatched events sees presence
// silently stop updating.

describe('the store the frames build', () => {

  let store

  function sync(members, you = 'conn-self') {
    _client.emit('event', 'presence:sync', { channelId: ROOM, you, members })
  }
  const frame = (name, data) => _client.emit('event', name, { channelId: ROOM, ...data })
  const member = (connectionId, meta = {}) =>
    ({ connectionId, userId: connectionId, joinedAt: new Date(), meta })

  beforeEach(async () => {
    _client = await connect('tok-alice')
    store   = presence(ROOM)
    await settle(150)
  })

  test('a frame for another channel is not this store\'s', () => {
    // Asserted as *no change*, not as zero: this connection IS in ROOM, so the
    // server has already answered the subscribe with a real sync. A test that
    // demanded an empty store here would be asserting the server said nothing.
    const before = store.get().count
    _client.emit('event', 'presence:sync', {
      channelId: OTHER, you: 'conn-self', members: [member('conn-b')],
    })
    expect(store.get().count).toBe(before)
    expect(store.get().members.map(m => m.connectionId)).not.toContain('conn-b')
  })

  test('presence:diff applies several joins and leaves in one frame', () => {
    sync([member('conn-self'), member('conn-b')])
    frame('presence:diff', { joined: [member('conn-c'), member('conn-d')], left: [{ connectionId: 'conn-b' }] })
    expect(store.get().members.map(m => m.connectionId).sort())
      .toEqual(['conn-c', 'conn-d', 'conn-self'])
  })

  test('presence:diff applies leaves BEFORE joins', () => {
    // A connection that left and rejoined inside one window is in both lists,
    // and the other order removes the row it had just added.
    sync([member('conn-self')])
    frame('presence:diff', {
      joined: [member('conn-b', { name: 'back' })],
      left:   [{ connectionId: 'conn-b' }],
    })
    expect(store.get().count).toBe(2)
    expect(store.get().members.find(m => m.connectionId === 'conn-b').meta.name).toBe('back')
  })

  test('presence:diff does not duplicate a member a sync already reported', () => {
    sync([member('conn-b')])
    frame('presence:diff', { joined: [member('conn-b')] })
    expect(store.get().count).toBe(1)
  })

  test('presence:join appends, presence:leave removes by connectionId', () => {
    sync([member('conn-self')])
    frame('presence:join', { member: member('conn-b') })
    expect(store.get().count).toBe(2)
    frame('presence:leave', { member: { connectionId: 'conn-b' } })
    expect(store.get().members.map(m => m.connectionId)).toEqual(['conn-self'])
  })

  test('presence:update replaces meta on the matching member', () => {
    sync([member('conn-b', { typing: false })])
    frame('presence:update', { connectionId: 'conn-b', meta: { typing: true } })
    expect(store.get().members[0].meta.typing).toBe(true)
  })

  test('absent meta normalises to {}', () => {
    _client.emit('event', 'presence:sync', {
      channelId: ROOM, you: 'conn-self',
      members: [{ connectionId: 'conn-b', userId: 2, joinedAt: new Date() }],
    })
    expect(store.get().members[0].meta).toEqual({})
  })

  test('self is null before the first sync, and everyone is an other', () => {
    // A channel this connection is not a member of: the server answers nothing,
    // so this is the only store that has genuinely never seen a sync. `self` is
    // stated by the server on sync and by nothing else, and until it arrives an
    // avatar strip must show every member as somebody else rather than guess.
    const cold = presence(OTHER)
    expect(cold.get().self).toBeNull()
    _client.emit('event', 'presence:join', { channelId: OTHER, member: member('conn-b') })
    expect(cold.get().self).toBeNull()
    expect(cold.get().others).toHaveLength(1)
    cold.leave()
  })

  test('two presence() calls on different channels are independent', () => {
    const other = presence(OTHER)
    sync([member('conn-x')])
    expect(store.get().count).toBe(1)
    expect(other.get().count).toBe(0)
  })

  test('frames after leave() are ignored', () => {
    store.leave()
    frame('presence:join', { member: member('conn-x') })
    expect(store.get().count).toBe(0)
  })

  test('debounced updateMeta sends one frame per window, carrying the last value', async () => {
    const sent = []
    const raw  = _client._ws.send.bind(_client._ws)
    _client._ws.send = m => { sent.push(JSON.parse(m)); return raw(m) }

    store.updateMeta({ typing: true },  { debounce: 50 })
    store.updateMeta({ typing: true },  { debounce: 50 })
    store.updateMeta({ typing: false }, { debounce: 50 })
    expect(sent).toHaveLength(0)

    await settle(120)
    expect(sent).toHaveLength(1)
    expect(sent[0].meta).toEqual({ typing: false })
  })

  test('leave() flushes pending debounced meta and clears the store', async () => {
    const sent = []
    const raw  = _client._ws.send.bind(_client._ws)
    _client._ws.send = m => { sent.push(JSON.parse(m)); return raw(m) }

    sync([member('conn-self')])
    store.updateMeta({ typing: true }, { debounce: 500 })
    store.leave()

    expect(sent.some(m => m.type === 'subscribe' && m.meta?.typing === true)).toBe(true)
    expect(store.get().count).toBe(0)
  })
})
