// tests/disconnect-session.test.ts
//
// A session is resolved ONCE, at upgrade, and the principal it produced is
// handed to every frame after that. So a change to what a session MEANS reaches
// HTTP on the next request and reaches an open socket never.
//
// Support mode is the case it was written for: an operator who ends an episode
// stops acting as the subject over HTTP and, without this, keeps acting as them
// down a connection nobody re-asked. django-hijack flushes the session on both
// edges for the same reason, one transport along.
//
// Every row is a PAIR — the session asked for, and another session beside it
// that must survive. A close that took every socket down would satisfy a test
// that only counted the ones that went.

import { describe, test, expect } from 'bun:test'
import { createChannelManager } from '../src/transport/channels.ts'

type Manager = ReturnType<typeof createChannelManager>

function live() {
  let readyState = 1
  const closed: Array<{ code: number; reason: string }> = []
  const s = {
    send:  () => 1,
    close: (code: number, reason: string) => { closed.push({ code, reason }); readyState = 3 },
    get readyState() { return readyState },
  }
  return { s, closed }
}

async function connect(manager: Manager, sessionId: string | undefined, userId = 'u') {
  const { s, closed } = live()
  const conn = await manager.handleConnection(
    s as never,
    (sessionId ? { userId, sessionId, userType: 'user', authMethod: 'session' } : null) as never,
  )
  return { conn, closed }
}

describe('closing every socket a session holds', () => {

  test('the named session goes and every other one stays', async () => {
    const manager = createChannelManager()
    const a1 = await connect(manager, 'sess-a')       // two tabs, one session
    const a2 = await connect(manager, 'sess-a')
    const b  = await connect(manager, 'sess-b')       // somebody else
    const anon = await connect(manager, undefined)    // no session at all

    const closed = manager.disconnectSession('sess-a', 'support session ended')
    expect(closed).toBe(2)

    expect(a1.closed[0]?.reason).toBe('support session ended')
    expect(a2.closed).toHaveLength(1)
    // The pair. A close that took the whole map down would pass every
    // assertion above it.
    expect(b.closed).toHaveLength(0)
    expect(anon.closed).toHaveLength(0)
  })

  test('the manager stops holding the connections it closed', async () => {
    // Through the ordinary disconnect path rather than a raw socket close: a
    // manager still holding a connection whose socket is gone goes on selecting
    // it as a broadcast recipient.
    const manager = createChannelManager()
    await connect(manager, 'sess-a')
    await connect(manager, 'sess-b')
    expect(manager.connections.size).toBe(2)

    manager.disconnectSession('sess-a')
    await new Promise((r) => setImmediate(r))
    expect(manager.connections.size).toBe(1)
    expect([...manager.connections.values()][0].user?.sessionId).toBe('sess-b')
  })

  test('a session with no sockets answers 0 rather than nothing', async () => {
    // *Nothing to close* and *nothing happened* are the same silence otherwise.
    const manager = createChannelManager()
    await connect(manager, 'sess-a')
    expect(manager.disconnectSession('sess-nobody')).toBe(0)
    expect(manager.connections.size).toBe(1)
  })
})
