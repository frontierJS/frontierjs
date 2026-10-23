// api/test/room.test.ts
// Two members in one room see each other's moves and lines; a banned member
// sees nothing and is seen by nobody; a mod bans over the socket and a member
// cannot. Real sockets on a real app over the env's own Litestone client — a
// broadcast graded to nobody reads exactly like one that was never sent, so
// every refusal sits beside a delivery.
//
// Every member walks in through the signed login, so the token on each socket
// is a minted session and not a stub.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { roomChannelName } from '../src/rooms.ts'
import { POST_KEY, signIn } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')

const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Sock { ws: WebSocket, frames: any[], callId: number }

let env: any, sys: any, square: any, tavern: any, sam: any, ana: any, rex: any, mod: any
const open: Sock[] = []

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, postKey: POST_KEY, mods: ['mod'] }),
  })
  sys    = env.system
  square = await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  tavern = await sys.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
  sam    = await signIn(env.port, 'sam')
  ana    = await signIn(env.port, 'ana')
  rex    = await signIn(env.port, 'rex')
  mod    = await signIn(env.port, 'mod')
  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: new Date().toISOString() } })
})

afterEach(async () => {
  for (const s of open.splice(0)) s.ws.close()
  await env?.close?.()
})

async function enter (member: any, room = ''): Promise<Sock> {
  const q  = room ? `?room=${room}` : ''
  const ws = new WebSocket(`ws://localhost:${env.port}/ws${q}`, ['fjs', `fjs.bearer.${member.token}`])
  const s: Sock = { ws, frames: [], callId: 0 }
  ws.onmessage = (e: any) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  open.push(s)
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connection'); i++) await sleep(5)
  await sleep(50)
  return s
}

const send   = (s: Sock, frame: unknown) => s.ws.send(JSON.stringify(frame))
const events = (s: Sock, name: string) => s.frames.filter(f => f.type === 'event' && f.event === name)
const move   = (s: Sock, roomId: number, x: number, y: number) =>
  send(s, { type: 'subscribe', channel: roomChannelName(roomId), meta: { x, y } })

async function call (s: Sock, service: string, method: string, frame: Record<string, unknown>): Promise<any> {
  const id = String(++s.callId)
  send(s, { type: 'service_call', id, service, method, ...frame })
  for (let i = 0; i < 200; i++) {
    const answer = s.frames.find(f => f.id === id && (f.type === 'service_result' || f.type === 'service_error'))
    if (answer) return answer
    await sleep(5)
  }
  throw new Error(`no answer to call ${id}`)
}

const say = (s: Sock, roomId: number, body: string, extra: Record<string, unknown> = {}) =>
  call(s, 'messages', 'create', { data: { roomId, body, ...extra } })

/** What the client's `/ban` and `/unban` send: an ordinary patch of the column. */
const ban = (s: Sock, memberId: number, bannedAt: string | null) =>
  call(s, 'members', 'patch', { meta: { id: memberId }, data: { bannedAt } })

describe('two members in the square', () => {
  test('each sees the other move and speak', async () => {
    const s = await enter(sam)
    const a = await enter(ana)

    // A client sends its cell at the join; a listener with none hears nothing.
    move(a, square.id, 3, 7)
    move(s, square.id, 4, 7)
    const line = await say(s, square.id, 'hi all')
    expect(line).toMatchObject({ type: 'service_result' })
    await sleep(150)

    const moved = events(a, 'presence:update').map(f => f.data)
    expect(moved).toContainEqual(expect.objectContaining({ channelId: roomChannelName(square.id), meta: { x: 4, y: 7 } }))

    const heard = events(a, 'messages created').map(f => f.data)
    expect(heard).toEqual([expect.objectContaining({ body: 'hi all', memberId: sam.id, roomId: square.id })])
  })

  test('a line naming somebody else is said as the caller', async () => {
    const s = await enter(sam)
    const line = await say(s, square.id, 'it was ana', { memberId: ana.id })
    expect(line).toMatchObject({ type: 'service_result', result: { memberId: sam.id } })
  })

  test('a late joiner is handed every figure where it stands', async () => {
    const s = await enter(sam)
    move(s, square.id, 10, 11)
    await sleep(100)

    const a = await enter(ana)
    move(a, square.id, 2, 2)
    await sleep(100)

    const sync = events(a, 'presence:sync').at(-1)?.data
    const figures = sync.members.map((m: any) => ({ userId: String(m.userId), meta: m.meta }))
    expect(figures).toContainEqual({ userId: String(sam.id), meta: { x: 10, y: 11 } })
  })

  test('a move that is not a cell is refused and reaches nobody', async () => {
    const s = await enter(sam)
    const a = await enter(ana)

    send(s, { type: 'subscribe', channel: roomChannelName(square.id), meta: { x: 4, y: 7, hat: 'red' } })
    send(s, { type: 'subscribe', channel: roomChannelName(square.id), meta: { x: -1, y: 2 } })
    send(s, { type: 'subscribe', channel: roomChannelName(square.id), meta: { x: 1, y: 1, pad: 'x'.repeat(140) } })
    await sleep(150)

    expect(events(s, 'error').map(f => f.data.code)).toEqual(['presence_meta_refused', 'presence_meta_too_large'])
    // The first is cut to { x, y } rather than carried whole.
    expect(events(a, 'presence:update').map(f => f.data.meta)).toEqual([{ x: 4, y: 7 }])
  })

  test('a move onto a wall, a door or off the stage is refused by name and reaches nobody; floor beside it lands', async () => {
    const s = await enter(sam)
    const a = await enter(ana)

    move(s, square.id, 2, 2)
    move(s, square.id, 1, 1)
    move(s, square.id, 159, 25)
    await sleep(150)
    move(s, square.id, 3, 2)
    await sleep(150)

    const errors = events(s, 'error')
    expect(errors.map(f => f.data.code)).toEqual(['presence_meta_refused', 'presence_meta_refused'])
    expect(errors[0].data.message).toBe('Cell 1,1 of square is not floor')
    expect(events(a, 'presence:update').map(f => f.data.meta)).toEqual([{ x: 2, y: 2 }, { x: 3, y: 2 }])
  })

  test('typing reaches the others as true and as nothing else', async () => {
    const s = await enter(sam)
    const a = await enter(ana)

    send(s, { type: 'subscribe', channel: roomChannelName(square.id), meta: { x: 4, y: 7, typing: true } })
    await sleep(150)
    send(s, { type: 'subscribe', channel: roomChannelName(square.id), meta: { x: 4, y: 7, typing: 'yes' } })
    await sleep(150)

    expect(events(a, 'presence:update').map(f => f.data.meta)).toEqual([{ x: 4, y: 7, typing: true }, { x: 4, y: 7 }])
  })
})

describe('rooms', () => {
  test('a line said in the tavern is not heard in the square', async () => {
    const s = await enter(sam, 'tavern')
    const a = await enter(ana)

    expect((await say(s, tavern.id, 'anyone?')).type).toBe('service_result')
    const b = await enter(ana, 'tavern')
    expect((await say(s, tavern.id, 'ana!')).type).toBe('service_result')
    await sleep(150)

    expect(events(a, 'messages created')).toEqual([])
    expect(events(b, 'messages created').map(f => f.data.body)).toEqual(['ana!'])
  })

  test('a door is a reconnect: the square sees the figure leave, the tavern hands it the tavern', async () => {
    const s = await enter(sam)
    const a = await enter(ana)
    move(s, square.id, 4, 4)
    move(a, square.id, 6, 6)
    await sleep(100)

    // What setSocketQuery({ room: 'tavern' }) does on the client.
    a.ws.close()
    const b = await enter(ana, 'tavern')
    move(b, tavern.id, 2, 2)
    await sleep(150)

    const left = s.frames.filter(f => f.type === 'event' && /^presence:(leave|diff)$/.test(f.event))
    expect(JSON.stringify(left)).toContain(String(ana.id))
    expect(events(b, 'presence:sync').at(-1)?.data.channelId).toBe(roomChannelName(tavern.id))
    expect(events(b, 'presence:sync').at(-1)?.data.members.map((m: any) => String(m.userId))).toEqual([String(ana.id)])
    // A move sent toward the room just left is not in it, so it answers nothing.
    const before = b.frames.length
    move(b, square.id, 1, 1)
    await sleep(100)
    expect(b.frames.slice(before)).toEqual([])
  })

  test('a room the server has not laid out joins nothing', async () => {
    const s = await enter(sam, 'cellar')
    move(s, square.id, 1, 1)
    move(s, tavern.id, 1, 1)
    await sleep(100)
    expect(events(s, 'presence:sync')).toEqual([])
  })
})

describe('footprints (7.4)', () => {
  test('a step is remembered on the cell stepped onto and handed to a later joiner; a jump is not a step', async () => {
    const s = await enter(sam)
    move(s, square.id, 10, 11)    // where sam walks in: no step to it
    await sleep(120)
    move(s, square.id, 11, 11)
    await sleep(120)
    move(s, square.id, 11, 12)
    await sleep(120)
    move(s, square.id, 40, 20)    // a door's arrival, say: not a step
    await sleep(120)

    const a = await enter(ana)
    const steps = (await call(a, 'rooms', 'traces', { meta: { id: square.id } })).result
    expect(steps.map(({ x, y }: any) => ({ x, y }))).toEqual([{ x: 11, y: 11 }, { x: 11, y: 12 }])
    expect(steps.every((t: any) => t.kind === 'step' && t.until > t.at && Object.keys(t).sort().join() === 'at,kind,until,x,y')).toBe(true)
    // The room's memory is per room: the tavern was walked by nobody.
    expect((await call(a, 'rooms', 'traces', { meta: { id: tavern.id } })).result).toEqual([])
  })

  test('a room the caller cannot read hands back no traces', async () => {
    const a = await enter(ana)
    expect(await call(a, 'rooms', 'traces', { meta: { id: 99999 } })).toMatchObject({ type: 'service_error', error: { code: 404 } })
  })
})

describe('a banned member', () => {
  test('is refused the room, receives nothing, and cannot speak', async () => {
    const s = await enter(sam)
    const r = await enter(rex)
    const a = await enter(ana)

    move(a, square.id, 3, 2)
    move(s, square.id, 2, 2)
    expect((await say(s, square.id, 'hello')).type).toBe('service_result')
    move(r, square.id, 5, 5)
    const refused = await say(r, square.id, 'spam')
    await sleep(150)

    // Delivered to the member beside them…
    expect(events(a, 'messages created').map(f => f.data.body)).toEqual(['hello'])
    expect(events(a, 'presence:update').map(f => f.data.meta)).toEqual([{ x: 2, y: 2 }])
    // …and none of it to them, and none of theirs to anyone.
    expect(events(r, 'messages created')).toEqual([])
    expect(events(r, 'presence:update')).toEqual([])
    expect(refused.type).toBe('service_error')
    const roster = events(a, 'presence:sync').at(-1)?.data.members.map((m: any) => String(m.userId))
    expect(roster).not.toContain(String(rex.id))
    expect(roster).toContain(String(sam.id))
  })

  test('banned by a mod while standing in the room is taken out of it on the next write', async () => {
    const s = await enter(sam)
    const a = await enter(ana)
    const m = await enter(mod)

    const banned = await ban(m, ana.id, new Date().toISOString())
    expect(banned).toMatchObject({ type: 'service_result', result: { id: ana.id } })
    expect(banned.result.bannedAt).toBeTruthy()
    await sleep(150)
    const before = a.frames.length

    move(s, square.id, 3, 3)
    expect((await say(s, square.id, 'still here?')).type).toBe('service_result')
    await sleep(150)

    expect(events(a, 'presence:sync').at(-1)?.data.members).toEqual([])
    expect(a.frames.slice(before).filter(f => f.event === 'messages created' || f.event === 'presence:update')).toEqual([])
  })

  test('is back in the room once the mod lifts the ban, and a member can do neither', async () => {
    const s = await enter(sam)
    const m = await enter(mod)

    // A member's patch of another row is filtered to nothing and answers no
    // row; of their own, the column is dropped (`FJS-D22`) and the row comes
    // back unchanged. Neither is an error, so the column is what is asserted,
    // and the client reads the answer the same way (`Scene.mesa`).
    expect((await ban(s, ana.id, new Date().toISOString())).result ?? null).toBeNull()
    expect((await sys.member.findFirst({ where: { id: ana.id } })).bannedAt).toBeNull()
    const r = await enter(rex)
    expect((await ban(r, rex.id, null)).result?.bannedAt).toBeTruthy()
    expect((await sys.member.findFirst({ where: { id: rex.id } })).bannedAt).toBeTruthy()

    expect((await ban(m, rex.id, null)).result.bannedAt).toBeNull()
    const back = await enter(rex)
    move(back, square.id, 2, 2)
    await sleep(150)
    expect(events(back, 'presence:sync').at(-1)?.data.members.map((x: any) => String(x.userId))).toContain(String(rex.id))
    expect(events(s, 'presence:update').map(f => f.data.meta)).toContainEqual({ x: 2, y: 2 })
  })
})

describe('the rate limit', () => {
  test('a member saying a sixth line in ten seconds is refused, and another member is not', async () => {
    const s = await enter(sam)
    const a = await enter(ana)
    const answers: any[] = []
    for (let i = 0; i < 6; i++) answers.push(await say(s, square.id, `line ${i}`))

    expect(answers.slice(0, 5).every(r => r.type === 'service_result')).toBe(true)
    expect(answers[5]).toMatchObject({ type: 'service_error', error: { code: 429 } })
    expect((await say(a, square.id, 'my turn')).type).toBe('service_result')
  })
})
