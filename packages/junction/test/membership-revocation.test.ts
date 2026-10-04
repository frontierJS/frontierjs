// test/membership-revocation.test.ts
//
// A chat app's private channel: a message is readable by whoever is a member of
// its channel, and membership is a row. Remove a member while their socket is
// open and the next message must not reach it. Each half is pinned alone —
// junction re-asks per frame against a STUBBED boundary (`FJS-1316`,
// `channel-claims.test.ts`), litestone's `check(channel)` drops access on a
// revoke with no socket (`policy-some.test.ts`) — and a cache between them
// would pass both. This is the two together, over a real port.
//
// The membership lives in the POLICY, not in a channel claims resolver, which
// is the shape an app reaches for first: no resolver is configured here.

import { describe, test, expect, afterEach } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createApp }      from '../src/core/app.ts'
import { createService }  from '../src/core/service.ts'
import { channels }       from '../src/transport/channels.ts'

const SCHEMA = `
  model User {
    id String @id
    @@auth
  }
  model Room {
    id       String       @id
    members  RoomMember[]
    messages Message[]
    @@allow('read', members.some(userId == auth().id))
  }
  model RoomMember {
    id     String @id
    roomId String
    room   Room   @relation(fields: [roomId], references: [id])
    userId String
    @@allow('read', true)
  }
  model Message {
    id     Int    @id @default(autoincrement())
    roomId String
    room   Room   @relation(fields: [roomId], references: [id])
    body   String
    @@allow('read', check(room))
  }
`

// The write tap defers a tick and the frame then crosses a real socket.
const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = () => sleep(120)

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  for (const id of ['ana', 'bob']) await sys.user.create({ data: { id } })
  await sys.room.create({ data: { id: 'secret' } })
  await sys.roomMember.create({ data: { id: 'm-ana', roomId: 'secret', userId: 'ana' } })

  const app: any = createApp({
    db,
    logLevel: 'silent',
    config: { port: 0, services: { dir: '/nonexistent' } },
    auth: {
      // The token IS the user id — the session shape, not its verification, is
      // what this file is about.
      verifySession: async (token: string) => {
        if (!['ana', 'bob'].includes(token)) throw new Error('bad token')
        return { userId: token, userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
      },
    },
  })
  app.services.register(createService({ name: 'messages', model: 'Message', channel: 'messages' }))
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel('messages').join(conn) })
  }))
  await app.start()
  running.push(app)
  return { db, sys, port: app.http.port as number }
}

interface Sock { frames: any[]; bodies: () => string[] }

async function open(port: number, token: string): Promise<Sock> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, ['fjs', `fjs.bearer.${token}`])
  const frames: any[] = []
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
  for (let i = 0; i < 200 && !frames.some(f => f.type === 'connected'); i++) await sleep(5)
  expect(frames.some(f => f.type === 'connected')).toBe(true)
  const bodies = () => frames
    .filter(f => f.type === 'event' && String(f.event ?? '').startsWith('messages '))
    .map(f => f.data.body)
  return { frames, bodies }
}

const get = (port: number, token: string, id: number) =>
  fetch(`http://localhost:${port}/messages/${id}`, { headers: { authorization: `Bearer ${token}` } })

describe('a member removed from a private channel, socket still open', () => {
  test('the message before the removal reaches the member and not the stranger', async () => {
    const { sys, port } = await mkApp()
    const ana = await open(port, 'ana')
    const bob = await open(port, 'bob')

    await sys.message.create({ data: { roomId: 'secret', body: 'before' } })
    await settle()

    // The control: without the member receiving, every refusal below would
    // equally be *broadcast nothing at all*.
    expect(ana.bodies()).toEqual(['before'])
    expect(bob.bodies()).toEqual([])
  })

  test('the message after the removal reaches nobody, and HTTP agrees', async () => {
    const { sys, port } = await mkApp()
    const ana = await open(port, 'ana')

    await sys.message.create({ data: { roomId: 'secret', body: 'before' } })
    await settle()
    await sys.roomMember.delete({ where: { id: 'm-ana' } })
    const after = await sys.message.create({ data: { roomId: 'secret', body: 'after' } })
    await settle()

    expect(ana.bodies()).toEqual(['before'])
    expect((await get(port, 'ana', after.id)).status).toBe(404)
  })

  test('an edit to a message she already saw stops reaching her too', async () => {
    const { sys, port } = await mkApp()
    const ana = await open(port, 'ana')

    const m = await sys.message.create({ data: { roomId: 'secret', body: 'before' } })
    await settle()
    await sys.roomMember.delete({ where: { id: 'm-ana' } })
    await sys.message.update({ where: { id: m.id }, data: { body: 'edited' } })
    await settle()

    expect(ana.bodies()).toEqual(['before'])
  })

  test('and the other way — a person added mid-session starts receiving', async () => {
    const { sys, port } = await mkApp()
    const bob = await open(port, 'bob')

    await sys.message.create({ data: { roomId: 'secret', body: 'before' } })
    await settle()
    await sys.roomMember.create({ data: { id: 'm-bob', roomId: 'secret', userId: 'bob' } })
    await sys.message.create({ data: { roomId: 'secret', body: 'after' } })
    await settle()

    expect(bob.bodies()).toEqual(['after'])
  })
})
