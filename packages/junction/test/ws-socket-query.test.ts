// test/ws-socket-query.test.ts
//
// The client's `socketQuery` is what the upgrade asks for, for an app that
// joins rooms in `channels.on('connection')` — Haven's `/ws?room=`. It is
// state of the CONNECTION: a reconnect after a drop must ask for the same room,
// or the server puts the person back wherever no query lands them while their
// screen still shows the room they walked into. `setSocketQuery` is a door: it
// cycles an open socket, the way `setToken` does.
//
// Visibility is the connection's too: the tab reports it on every `connected`
// and on each `visibilitychange`, and a push driver skips a user with a tab on
// screen (`FJS-D1627`). A reconnect that did not resend it would read hidden.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, channels, defaultConfig }                from '../index.ts'
import { createJunctionClient }                              from '../src/client/index.ts'
import type { SessionContext }                               from '../src/auth/types.ts'

const ALICE = { id: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext

// What each connection's upgrade asked for, as the connection hook read it.
const joined: string[] = []
let app: any
let URL_: string

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.setAuth({
    async verifySession(token: string) {
      if (token === 'alice') return ALICE
      throw new Error('bad token')
    },
  })
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: any) => {
      joined.push(String(conn.data.query?.room ?? '(none)'))
    })
  }))
  await app.start()
  URL_ = `http://localhost:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

/** Every URL a client opened a socket on, in order. */
function recordOpens(): { urls: string[], restore: () => void } {
  const Real = globalThis.WebSocket
  const urls: string[] = []
  ;(globalThis as any).WebSocket = class extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      urls.push(String(url))
    }
  }
  return { urls, restore: () => { (globalThis as any).WebSocket = Real } }
}

const nextConnect = (client: any) => new Promise<void>(r => client.once('connect', () => r()))

describe('the socket query', () => {

  test('rides the upgrade, and the token still does not', async () => {
    const { urls, restore } = recordOpens()
    try {
      const client = createJunctionClient({ url: URL_, socketQuery: { room: 'square' } })
      const up = nextConnect(client)
      client.setToken('alice')
      await up
      expect(urls).toEqual([`${URL_.replace('http', 'ws')}/ws?room=square`])
      expect(urls[0]).not.toContain('alice')
      client.disconnect()
    } finally { restore() }
  })

  test('a change cycles an open socket, and the server reads the new one', async () => {
    const { urls, restore } = recordOpens()
    try {
      const client = createJunctionClient({ url: URL_, token: 'alice', socketQuery: { room: 'square' } })
      let up = nextConnect(client)
      client.connect()
      await up
      up = nextConnect(client)
      client.setSocketQuery({ room: 'tavern' })
      await up
      expect(urls.map(u => u.split('?')[1])).toEqual(['room=square', 'room=tavern'])
      // `connected` is sent after the connection hooks ran, so this is settled.
      expect(joined.at(-1)).toBe('tavern')
      client.disconnect()
    } finally { restore() }
  })

  test('the same query again opens nothing', async () => {
    const { urls, restore } = recordOpens()
    try {
      const client = createJunctionClient({ url: URL_, token: 'alice', socketQuery: { room: 'square' } })
      const up = nextConnect(client)
      client.connect()
      await up
      client.setSocketQuery({ room: 'square' })
      await new Promise(r => setTimeout(r, 50))
      expect(urls).toHaveLength(1)
      client.disconnect()
    } finally { restore() }
  })

  test('a socket not open yet stays closed, and opens with the query it was given', async () => {
    const { urls, restore } = recordOpens()
    try {
      const client = createJunctionClient({ url: URL_, token: 'alice' })
      client.setSocketQuery({ room: 'tavern' })
      expect(urls).toHaveLength(0)
      const up = nextConnect(client)
      client.connect()
      await up
      expect(urls[0]).toEndWith('/ws?room=tavern')
      client.disconnect()
    } finally { restore() }
  })

  test('a reconnect after a drop asks for the room the client is in', async () => {
    const { urls, restore } = recordOpens()
    try {
      const client = createJunctionClient({ url: URL_, token: 'alice', reconnectDelay: 10 }) as any
      client.setSocketQuery({ room: 'tavern' })
      let up = nextConnect(client)
      client.connect()
      await up
      up = nextConnect(client)
      // Closed from outside, as a network drop is: not the client's own close.
      client._ws.close()
      await up
      expect(urls.map((u: string) => u.split('?')[1])).toEqual(['room=tavern', 'room=tavern'])
      client.disconnect()
    } finally { restore() }
  })

  test('a relayed client has no socket to cycle, and says so', () => {
    const client = createJunctionClient({ url: URL_, relay: async () => null })
    expect(() => client.setSocketQuery({ room: 'tavern' })).toThrow(/relayed client has no socket/)
  })
})

describe('the visibility frame', () => {
  const settle = async (fn: () => boolean) => {
    const deadline = Date.now() + 2000
    while (!fn() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    return fn()
  }

  test('a tab reports on connect and on each change, and a reconnect reports again', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    ;(globalThis as any).document = doc
    try {
      const client = createJunctionClient({ url: URL_, token: 'alice', reconnectDelay: 10 }) as any
      let up = nextConnect(client)
      client.connect()
      await up
      const conn = () => [...app.channels.connections.values()].find((c: any) => c.user?.id === ALICE.id)
      expect(await settle(() => conn()?.visible === false)).toBe(true)
      expect(app.channels.hasVisibleConnection(ALICE.id)).toBe(false)

      doc.visibilityState = 'visible'
      doc.dispatchEvent(new Event('visibilitychange'))
      expect(await settle(() => app.channels.hasVisibleConnection(ALICE.id))).toBe(true)

      const before = conn().id
      up = nextConnect(client)
      client._ws.close()
      await up
      expect(await settle(() => conn()?.id !== before && conn()?.visible === true)).toBe(true)
      client.disconnect()
      expect(await settle(() => !app.channels.hasVisibleConnection(ALICE.id))).toBe(true)
    } finally { delete (globalThis as any).document }
  })

  test('a socket that never reports reads as hidden', async () => {
    const client = createJunctionClient({ url: URL_, token: 'alice' })
    const up = nextConnect(client)
    client.connect()
    await up
    expect(app.channels.hasVisibleConnection(ALICE.id)).toBe(false)
    client.disconnect()
  })
})
