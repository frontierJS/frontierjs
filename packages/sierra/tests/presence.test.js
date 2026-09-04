/**
 * tests/presence.test.js — presence() store behaviour
 */
import { describe, test, it, expect, vi, beforeEach } from 'vitest'
import { presence } from '../src/presence/index.js'

// ── Mock junction client ──────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  const handlers = {}
  const sent = []
  return {
    connectionId: 'conn-self',
    connected: true,
    token: 'tok',
    sent,
    on(event, fn)  { handlers[event] = fn },
    off(event, fn) { if (handlers[event] === fn) delete handlers[event] },
    send(msg)      { sent.push(msg) },
    emit(event, payload) { handlers[event]?.(payload) },
    ...overrides,
  }
}

// ── Inject mock client ────────────────────────────────────────────────────────

let _mockClient = null

vi.mock('../src/junction/index.js', () => ({
  getClient: () => _mockClient,
}))

beforeEach(() => {
  _mockClient = makeClient()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('presence()', () => {
  it('sends subscribe message on init when authenticated', () => {
    presence('workspace:1', { meta: { name: 'Alice' } })
    expect(_mockClient.sent).toContainEqual({
      type: 'subscribe', channel: 'workspace:1', meta: { name: 'Alice' }
    })
  })

  it('does NOT send subscribe when client has no token and is not connected', () => {
    _mockClient = makeClient({ token: null, connected: false })
    presence('workspace:1')
    expect(_mockClient.sent).toHaveLength(0)
  })

  it('initialises with empty members', () => {
    const store = presence('workspace:1')
    expect(store.get().members).toEqual([])
    expect(store.get().count).toBe(0)
  })

  it('populates from presence:sync', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: { name: 'Alice' } },
        { connectionId: 'conn-b',    userId: 2, joinedAt: new Date(), meta: { name: 'Bob' } },
      ]
    })
    expect(store.get().count).toBe(2)
    expect(store.get().members[0].meta.name).toBe('Alice')
  })

  it('presence:join appends member', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} }]
    })
    _mockClient.emit('presence:join:workspace:1', {
      member: { connectionId: 'conn-b', userId: 2, joinedAt: new Date(), meta: { name: 'Bob' } }
    })
    expect(store.get().count).toBe(2)
  })

  // Junction batches join and leave into one frame per channel per window,
  // because a join used to send a frame to every existing member and N
  // connections cost N x (N-1) frames (`FJS-703`). A client that only knows
  // the unbatched events sees presence silently stop updating.
  it('presence:diff applies several joins and leaves in one frame', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} },
        { connectionId: 'conn-b',    userId: 2, joinedAt: new Date(), meta: {} },
      ]
    })
    _mockClient.emit('presence:diff:workspace:1', {
      joined: [
        { connectionId: 'conn-c', userId: 3, joinedAt: new Date(), meta: {} },
        { connectionId: 'conn-d', userId: 4, joinedAt: new Date(), meta: {} },
      ],
      left: [{ connectionId: 'conn-b' }],
    })
    expect(store.get().count).toBe(3)
    expect(store.get().members.map(m => m.connectionId).sort())
      .toEqual(['conn-c', 'conn-d', 'conn-self'])
  })

  it('presence:diff applies leaves BEFORE joins', () => {
    // A connection that left and rejoined inside one window is in both lists,
    // and the other order removes the row it had just added.
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} }]
    })
    _mockClient.emit('presence:diff:workspace:1', {
      joined: [{ connectionId: 'conn-b', userId: 2, joinedAt: new Date(), meta: { name: 'back' } }],
      left:   [{ connectionId: 'conn-b' }],
    })
    expect(store.get().count).toBe(2)
    expect(store.get().members.find(m => m.connectionId === 'conn-b').meta.name).toBe('back')
  })

  it('presence:diff does not duplicate a member a sync already reported', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-b', userId: 2, joinedAt: new Date(), meta: {} }]
    })
    _mockClient.emit('presence:diff:workspace:1', {
      joined: [{ connectionId: 'conn-b', userId: 2, joinedAt: new Date(), meta: {} }],
    })
    expect(store.get().count).toBe(1)
  })

  it('presence:leave removes member by connectionId', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} },
        { connectionId: 'conn-b',    userId: 2, joinedAt: new Date(), meta: {} },
      ]
    })
    _mockClient.emit('presence:leave:workspace:1', {
      member: { connectionId: 'conn-b' }
    })
    expect(store.get().count).toBe(1)
    expect(store.get().members[0].connectionId).toBe('conn-self')
  })

  it('presence:update replaces meta on matching member', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-b', userId: 2, joinedAt: new Date(), meta: { typing: false } }
      ]
    })
    _mockClient.emit('presence:update:workspace:1', {
      connectionId: 'conn-b', meta: { typing: true }
    })
    expect(store.get().members[0].meta.typing).toBe(true)
  })

  it('normalises absent meta to {}', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-b', userId: 2, joinedAt: new Date() }]
    })
    expect(store.get().members[0].meta).toEqual({})
  })

  it('self is own connection entry', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} },
        { connectionId: 'conn-b',    userId: 2, joinedAt: new Date(), meta: {} },
      ]
    })
    expect(store.get().self?.connectionId).toBe('conn-self')
  })

  it('self is null before first sync', () => {
    const store = presence('workspace:1')
    expect(store.get().self).toBeNull()
  })

  it('others excludes self', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [
        { connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} },
        { connectionId: 'conn-b',    userId: 2, joinedAt: new Date(), meta: {} },
      ]
    })
    expect(store.get().others).toHaveLength(1)
    expect(store.get().others[0].connectionId).toBe('conn-b')
  })

  it('updateMeta sends subscribe with new meta immediately', () => {
    const store = presence('workspace:1')
    _mockClient.sent.length = 0  // clear init subscribe
    store.updateMeta({ typing: true })
    expect(_mockClient.sent).toContainEqual({
      type: 'subscribe', channel: 'workspace:1', meta: { typing: true }
    })
  })

  it('debounced updateMeta sends only one message per window', async () => {
    const store = presence('workspace:1')
    _mockClient.sent.length = 0
    store.updateMeta({ typing: true },  { debounce: 50 })
    store.updateMeta({ typing: true },  { debounce: 50 })
    store.updateMeta({ typing: false }, { debounce: 50 })
    // Not sent yet
    expect(_mockClient.sent).toHaveLength(0)
    await new Promise(r => setTimeout(r, 80))
    // Only one message — the last value
    expect(_mockClient.sent).toHaveLength(1)
    expect(_mockClient.sent[0].meta).toEqual({ typing: false })
  })

  it('leave() sends unsubscribe and clears store', () => {
    const store = presence('workspace:1')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-self', userId: 1, joinedAt: new Date(), meta: {} }]
    })
    store.leave()
    expect(_mockClient.sent).toContainEqual({ type: 'unsubscribe', channel: 'workspace:1' })
    expect(store.get().count).toBe(0)
  })

  it('leave() flushes pending debounced meta', async () => {
    const store = presence('workspace:1')
    _mockClient.sent.length = 0
    store.updateMeta({ typing: true }, { debounce: 500 })
    store.leave()
    // Flushed immediately on leave
    expect(_mockClient.sent.some(m => m.type === 'subscribe' && m.meta?.typing === true)).toBe(true)
  })

  it('multiple presence() calls are independent', () => {
    const a = presence('workspace:1')
    const b = presence('workspace:2')
    _mockClient.emit('presence:sync:workspace:1', {
      members: [{ connectionId: 'conn-x', userId: 1, joinedAt: new Date(), meta: {} }]
    })
    expect(a.get().count).toBe(1)
    expect(b.get().count).toBe(0)
  })

  it('events after leave() are ignored', () => {
    const store = presence('workspace:1')
    store.leave()
    _mockClient.emit('presence:join:workspace:1', {
      member: { connectionId: 'conn-x', userId: 1, joinedAt: new Date(), meta: {} }
    })
    expect(store.get().count).toBe(0)
  })
})
