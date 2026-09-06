// tests/client-presence.test.ts
//
// The browser client's half of the presence protocol — asserted with the REAL
// client against a REAL app, two sockets on one channel.
//
// It exists because there was no client half at all (`FJS-811`).
// `@frontierjs/sierra/presence` is a published subpath and it called
// `client.send({type:'subscribe',…})` and read `client.connectionId`; the
// client has never had either, so the documented usage threw
// `TypeError: client.send is not a function` during component init. It survived
// because sierra's own test invented a client carrying both.
//
// What is asserted here is the three things that seam needs and nothing else
// can supply:
//
//   1. `client.presence.announce()` reaches the server and comes back as a
//      roster, and `release()` stops it.
//   2. `presence:sync` names WHICH member the recipient is (`you`) — the only
//      way a browser can split a roster into self and others, because nothing
//      else ever tells it its connection id.
//   3. An announcement made while the socket is DOWN is sent on connect, and
//      re-sent on every RE-connect — a reconnect is a new connection with no
//      meta and no roster, and nothing above this layer sees one happen.
//
// Every acceptance is paired with the refusal of a call one argument different
// (`FJS-351`): a client that sent every frame regardless, or a server that
// answered every channel, would satisfy an assertion that only checked the
// success.

import { afterEach, describe, expect, it } from 'bun:test'
import { createApp, channels, defaultConfig } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'

const USERS: Record<string, { userId: string; userType: string; authMethod: 'session' }> = {
  'tok-alice': { userId: 'alice', userType: 'user', authMethod: 'session' },
  'tok-bob':   { userId: 'bob',   userType: 'user', authMethod: 'session' },
}

const ROOM  = 'room:a'
const OTHER = 'room:nobody-joins-this'

let running: any[] = []
let clients: any[] = []

afterEach(async () => {
  clients.forEach(c => { try { c.disconnect() } catch {} })
  clients = []
  await Promise.all(running.map(a => a.stop()))
  running = []
})

async function serve(port: number) {
  const app: any = createApp({
    config: {
      port, database: { url: '', log: false }, services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 250 },
    },
    logLevel: 'silent',
    auth: {
      async verifySession(t: string) { return USERS[t] ?? null },
      async login()      { return { token: '', user: null as never } },
      async logout()     {},
      async createUser() { return {} as never },
      async deleteUser() {},
      async createApiKey(id: string) { return { key: `k-${id}`, id: `k-${id}` } },
      async revokeApiKey() {},
      async verifyApiKey() { return null },
    },
  })
  // Membership is the APP's — a browser cannot join itself, which is the whole
  // reason `announce` is not called `subscribe`. Only ROOM is ever joined, so
  // OTHER is the negative control for every roster assertion below.
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel(ROOM).join(conn) })
  }, { presence: true, presenceFlushMs: 0 }))
  await app.start()
  running.push(app)
  return app
}

/** A real client, connected, recording every presence frame it was sent. */
async function connect(port: number, token: string | null) {
  const client: any = createJunctionClient({ url: `http://localhost:${port}` })
  const seen: Array<{ name: string; data: any }> = []
  client.on('event', (name: string, data: any) => {
    if (String(name).startsWith('presence:')) seen.push({ name, data })
  })
  if (token) client.setToken(token)
  else client.connect()
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('never connected')), 5000)
    client.once('connect', () => { clearTimeout(t); resolve() })
  })
  clients.push(client)
  return {
    client,
    seen,
    of:   (name: string) => seen.filter(f => f.name === name),
    last: (name: string) => seen.filter(f => f.name === name).at(-1),
  }
}

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms))

describe('client.presence — the verb sierra could not call (FJS-811)', () => {

  it('announce() reaches the server and comes back as a roster', async () => {
    const port = 3510
    await serve(port)
    const alice = await connect(port, 'tok-alice')
    await settle()
    alice.seen.length = 0

    alice.client.presence.announce(ROOM, { name: 'Alice' })
    await settle()

    const sync = alice.last('presence:sync')
    expect(sync).toBeTruthy()
    expect(sync!.data.channelId).toBe(ROOM)
    expect(sync!.data.members.map((m: any) => m.userId)).toEqual(['alice'])
    expect(sync!.data.members[0].meta).toEqual({ name: 'Alice' })
  })

  it('and a channel this connection was never joined to answers NOTHING', async () => {
    // The pair for the row above. A client that sent the frame regardless and a
    // server that answered any channel look identical from the accepting side.
    const port = 3511
    await serve(port)
    const alice = await connect(port, 'tok-alice')
    await settle()
    alice.seen.length = 0

    alice.client.presence.announce(OTHER, { name: 'Alice' })
    await settle()

    expect(alice.of('presence:sync')).toEqual([])
  })

  it('presence:sync names WHICH member the recipient is', async () => {
    // Nothing else tells a browser its connection id, so without `you` a roster
    // cannot be split into self and others at all.
    const port = 3512
    await serve(port)
    const alice = await connect(port, 'tok-alice')
    const bob   = await connect(port, 'tok-bob')
    await settle()

    const aSync = alice.last('presence:sync')!
    const bSync = bob.last('presence:sync')!

    expect(typeof aSync.data.you).toBe('string')
    expect(typeof bSync.data.you).toBe('string')
    // Each is one of the members it was sent, and it is not the other one's.
    expect(aSync.data.members.some((m: any) => m.connectionId === aSync.data.you)).toBe(true)
    expect(aSync.data.you).not.toBe(bSync.data.you)
    // And it is the member carrying the recipient's own user.
    const self = bSync.data.members.find((m: any) => m.connectionId === bSync.data.you)
    expect(self.userId).toBe('bob')
  })

  it('two sockets see each other, and a release by one does not blind the other', async () => {
    const port = 3513
    await serve(port)
    const alice = await connect(port, 'tok-alice')
    alice.client.presence.announce(ROOM, { name: 'Alice' })
    const bob = await connect(port, 'tok-bob')
    bob.client.presence.announce(ROOM, { name: 'Bob' })
    await settle()

    expect(bob.last('presence:sync')!.data.members.map((m: any) => m.userId).sort())
      .toEqual(['alice', 'bob'])

    // Bob's tab closes its avatar strip. Alice is still rendering hers.
    bob.client.presence.release(ROOM)
    await settle()
    alice.seen.length = 0
    alice.client.presence.announce(ROOM, { name: 'Alice' })
    await settle()

    expect(alice.last('presence:sync')!.data.members.map((m: any) => m.userId).sort())
      .toEqual(['alice', 'bob'])
  })

  it('an announcement made before the socket is up is sent on connect', async () => {
    // The ordinary case: a component mounts at boot, long before the socket.
    // The old sierra module gated its send on `client.token || client.connected`
    // and therefore sent nothing at all in cookie mode.
    const port = 3514
    await serve(port)
    const client: any = createJunctionClient({ url: `http://localhost:${port}` })
    clients.push(client)
    const seen: any[] = []
    client.on('event', (name: string, data: any) => {
      if (name === 'presence:sync') seen.push(data)
    })

    client.presence.announce(ROOM, { name: 'Early' })   // socket is not open
    expect(seen).toEqual([])

    client.setToken('tok-alice')
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('never connected')), 5000)
      client.once('connect', () => { clearTimeout(t); resolve() })
    })
    await settle()

    expect(seen.at(-1).members[0].meta).toEqual({ name: 'Early' })
  })

  it('and it is announced AGAIN on a reconnect, where a released one is not', async () => {
    // A reconnect is a new connection: the server keys presence by connection
    // id, so nothing carries over and the announcement has to be re-made. The
    // released channel is the pair — a client that replayed everything it had
    // ever been handed would pass the first half alone.
    const port = 3515
    await serve(port)
    const client: any = createJunctionClient({ url: `http://localhost:${port}` })
    clients.push(client)
    const seen: any[] = []
    client.on('event', (name: string, data: any) => {
      if (name === 'presence:sync') seen.push(data)
    })
    client.setToken('tok-alice')
    await new Promise<void>(r => client.once('connect', () => r()))

    client.presence.announce(ROOM,  { name: 'Alice' })
    client.presence.announce(OTHER, { name: 'Alice' })
    client.presence.release(OTHER)
    await settle()

    // Drop the socket the way a deploy does, and let the client reconnect.
    seen.length = 0
    ;(client as any)._ws.close()
    await new Promise<void>(r => client.once('connect', () => r()))
    await settle(400)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(s => s.channelId === ROOM)).toBe(true)
    expect(seen.at(-1).members[0].meta).toEqual({ name: 'Alice' })
  })

  it('an ANONYMOUS socket is told nothing, where a member on the same channel is told everything', async () => {
    // Presence is a disclosure — a roster names every member's user id and
    // whatever meta the app publishes about them. The tracker records nobody
    // with no `userId`, so an anonymous connection is invisible in every
    // roster; it was still receiving `presence:join` and `presence:update`
    // through the plain channel fan-out, which it could never assemble into a
    // roster because no sync ever reaches it. Disclosure with no feature on the
    // other side.
    //
    // Asserted as a PAIR on one run. A fix that stopped sending presence to
    // anybody satisfies the refusal on its own (`FJS-351`), and *nobody
    // received it* is exactly what a broken fan-out looks like.
    const port = 3516
    await serve(port)
    const anon  = await connect(port, null)
    const alice = await connect(port, 'tok-alice')
    alice.client.presence.announce(ROOM, { name: 'Alice' })
    await settle()
    anon.seen.length = 0
    alice.seen.length = 0

    // Somebody arrives, and then says something about themselves.
    const bob = await connect(port, 'tok-bob')
    bob.client.presence.announce(ROOM, { status: 'typing' })
    await settle()

    expect(alice.of('presence:join').length).toBeGreaterThan(0)
    expect(alice.last('presence:update')!.data.meta).toEqual({ status: 'typing' })

    expect(anon.seen).toEqual([])

    // And asking for the roster itself gets an anonymous caller nothing either.
    anon.client.presence.announce(ROOM, { name: 'Nobody' })
    await settle()
    expect(anon.seen).toEqual([])
  })
})
