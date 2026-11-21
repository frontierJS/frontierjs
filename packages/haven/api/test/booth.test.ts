// api/test/booth.test.ts
// Two members who sit across a table get a room of their own, and nobody else
// gets in it. Real sockets on a real app: the pair hears each other, a third
// member who asks for the same slug is joined to nothing, reads no line and
// can say none — and every refusal sits beside the delivery that proves the
// refusal is not a broadcast that never went out.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { boothSlug } from '../src/booth.ts'
import { START } from '../../shared/checkers.ts'
import { POST_KEY, signIn } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Sock { ws: WebSocket, frames: any[], callId: number }

let env: any, sys: any, sam: any, ana: any, rex: any, bob: any
const open: Sock[] = []

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, postKey: POST_KEY }),
  })
  sys = env.system
  await sys.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
  sam = await signIn(env.port, 'sam')
  ana = await signIn(env.port, 'ana')
  bob = await signIn(env.port, 'bob')
  rex = await signIn(env.port, 'rex')
  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: new Date().toISOString() } })
})

afterEach(async () => {
  for (const s of open.splice(0)) s.ws.close()
  await env?.close?.()
})

async function enter (member: any, room: string): Promise<Sock> {
  const ws = new WebSocket(`ws://localhost:${env.port}/ws?room=${room}`, ['fjs', `fjs.bearer.${member.token}`])
  const s: Sock = { ws, frames: [], callId: 0 }
  ws.onmessage = (e: any) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  open.push(s)
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connection'); i++) await sleep(5)
  await sleep(50)
  return s
}

async function call (s: Sock, service: string, method: string, frame: Record<string, unknown>): Promise<any> {
  const id = String(++s.callId)
  s.ws.send(JSON.stringify({ type: 'service_call', id, service, method, ...frame }))
  for (let i = 0; i < 200; i++) {
    const answer = s.frames.find(f => f.id === id && (f.type === 'service_result' || f.type === 'service_error'))
    if (answer) return answer
    await sleep(5)
  }
  throw new Error(`no answer to call ${id}`)
}

const events = (s: Sock, name: string) => s.frames.filter(f => f.type === 'event' && f.event === name)

/** What the client does on sitting across from someone: ask for the booth, then walk in. */
async function sit (member: any, withId: number) {
  const asker = await enter(member, 'tavern')
  const answer = await call(asker, 'rooms', 'booth', { data: { withId } })
  asker.ws.close()
  return answer
}

describe('a booth', () => {
  test('is the same room whichever of the pair asks first', async () => {
    const first  = await sit(sam, ana.id)
    const second = await sit(ana, sam.id)
    expect(first).toMatchObject({ type: 'service_result', result: { slug: boothSlug(sam.id, ana.id) } })
    expect(second.result.id).toBe(first.result.id)
    expect(await sys.room.count({ where: { slug: boothSlug(sam.id, ana.id) } })).toBe(1)
    expect(await sys.room.findFirst({ where: { id: first.result.id } })).toMatchObject({
      pairLoId: Math.min(sam.id, ana.id), pairHiId: Math.max(sam.id, ana.id),
    })
  })

  test('carries a line to the pair and to nobody else', async () => {
    const { result: booth } = await sit(sam, ana.id)
    const s = await enter(sam, booth.slug)
    const a = await enter(ana, booth.slug)
    const b = await enter(bob, booth.slug)

    expect(await call(s, 'messages', 'create', { data: { roomId: booth.id, body: 'psst' } })).toMatchObject({ type: 'service_result' })
    await sleep(150)

    expect(events(a, 'messages created').map(f => f.data.body)).toEqual(['psst'])
    expect(events(b, 'messages created')).toEqual([])
  })

  test('is no row to a third member, who reads and says nothing in it', async () => {
    const { result: booth } = await sit(sam, ana.id)
    const s = await enter(sam, booth.slug)
    await call(s, 'messages', 'create', { data: { roomId: booth.id, body: 'psst' } })

    const a = await enter(ana, 'tavern')
    const b = await enter(bob, 'tavern')
    const heard = await call(a, 'messages', 'find', { query: { roomId: booth.id } })
    expect(heard.result.data.map((m: any) => m.body)).toEqual(['psst'])

    const stranger = await call(b, 'messages', 'find', { query: { roomId: booth.id } })
    expect(stranger.result.data).toEqual([])
    const rooms = await call(b, 'rooms', 'find', {})
    expect(rooms.result.data.map((r: any) => r.slug)).toEqual(['tavern'])
    expect((await call(a, 'rooms', 'find', {})).result.data.map((r: any) => r.slug)).toEqual(['tavern', booth.slug])

    await call(b, 'messages', 'create', { data: { roomId: booth.id, body: 'hello' } })
    expect(await sys.message.count({ where: { roomId: booth.id } })).toBe(1)
  })

  test('is refused for oneself, for nobody, and for a banned member', async () => {
    const asker = await enter(sam, 'tavern')
    for (const withId of [sam.id, 99999, rex.id, 'ana', null]) {
      const answer = await call(asker, 'rooms', 'booth', { data: { withId } })
      expect(answer.type).toBe('service_error')
    }
    expect(await sys.room.count({ where: { slug: { startsWith: 'booth-' } } })).toBe(0)
  })
})

describe('checkers across a booth', () => {
  async function table () {
    const { result: booth } = await sit(sam, ana.id)
    const s = await enter(sam, booth.slug)
    const a = await enter(ana, booth.slug)
    return { booth, s, a }
  }

  test('begins red for the one who asks, moves in turn, and tells the pair each move', async () => {
    const { booth, s, a } = await table()
    const started = await call(s, 'games', 'start', { data: { roomId: booth.id } })
    expect(started.result).toMatchObject({ redId: sam.id, blackId: ana.id, board: START, turn: 'r', winnerId: null })

    expect((await call(a, 'games', 'move', { data: { roomId: booth.id, path: ['b6', 'a5'] } })).error?.message ?? '').toContain('Not your move')
    const first = await call(s, 'games', 'move', { data: { roomId: booth.id, path: ['a3', 'b4'] } })
    expect(first.result).toMatchObject({ turn: 'b', last: 'a3-b4' })
    expect(first.result.board[(8 - 4) * 8 + 1]).toBe('r')
    expect((await call(a, 'games', 'move', { data: { roomId: booth.id, path: ['b6', 'a5'] } })).type).toBe('service_result')
    await sleep(150)

    expect(events(a, 'checkers').length).toBe(3)
    expect(events(s, 'checkers').length).toBe(3)
    const read = await call(a, 'games', 'get', { data: { roomId: booth.id } })
    expect(read.result).toMatchObject({ turn: 'r', last: 'b6-a5' })
  })

  test('refuses an illegal move, a second game while one is on, and any write that is not a path', async () => {
    const { booth, s } = await table()
    await call(s, 'games', 'start', { data: { roomId: booth.id } })
    const sideways = await call(s, 'games', 'move', { data: { roomId: booth.id, path: ['a3', 'a4'] } })
    expect(sideways.type).toBe('service_error')
    expect((await call(s, 'games', 'start', { data: { roomId: booth.id } })).type).toBe('service_error')
    // A client says squares, never the board: nothing but the four methods is a way in.
    for (const method of ['create', 'update', 'patch']) {
      const forged = await call(s, 'games', method, { data: { roomId: booth.id, board: 'r'.repeat(64) }, query: { roomId: booth.id } })
      expect(forged.type).toBe('service_error')
    }
    expect((await sys.game.findFirst({ where: { roomId: booth.id } })).board).toBe(START)
  })

  test('is no game to a third member, who can neither read, begin nor move in it', async () => {
    const { booth, s } = await table()
    await call(s, 'games', 'start', { data: { roomId: booth.id } })
    const b = await enter(bob, 'tavern')
    for (const [method, data] of [['get', { roomId: booth.id }], ['start', { roomId: booth.id }], ['move', { roomId: booth.id, path: ['a3', 'b4'] }], ['resign', { roomId: booth.id }]] as const) {
      expect((await call(b, 'games', method, { data })).type).toBe('service_error')
    }
    expect((await sys.game.findFirst({ where: { roomId: booth.id } })).board).toBe(START)
  })

  test('resigning gives the game to the other, ends it, and lets either begin another', async () => {
    const { booth, s, a } = await table()
    await call(s, 'games', 'start', { data: { roomId: booth.id } })
    expect((await call(a, 'games', 'resign', { data: { roomId: booth.id } })).result).toMatchObject({ winnerId: sam.id, last: 'resigned' })
    expect((await call(s, 'games', 'move', { data: { roomId: booth.id, path: ['a3', 'b4'] } })).type).toBe('service_error')
    const again = await call(a, 'games', 'start', { data: { roomId: booth.id } })
    expect(again.result).toMatchObject({ redId: ana.id, blackId: sam.id, board: START, winnerId: null })
    expect(await sys.game.count({ where: { roomId: booth.id } })).toBe(1)
  })
})

describe('the dice', () => {
  test('are said by a member nobody can be, with a throw the roller did not choose', async () => {
    const s = await enter(sam, 'tavern')
    const a = await enter(ana, 'tavern')
    const rolled = await call(s, 'dice', 'roll', { data: { roomId: (await sys.room.findFirst({ where: { slug: 'tavern' } })).id, dice: '2d6' } })
    expect(rolled.type).toBe('service_result')
    expect(rolled.result.dice.length).toBe(2)
    expect(rolled.result.dice.every((d: number) => d >= 1 && d <= 6)).toBe(true)
    expect(rolled.result.total).toBe(rolled.result.dice[0] + rolled.result.dice[1])
    await sleep(150)

    const said = events(a, 'messages created').map(f => f.data)
    expect(said.map((m: any) => m.body)).toEqual([`sam rolls 2d6: ${rolled.result.dice.join(' + ')} = ${rolled.result.total}`])
    const diceId = (await sys.member.findFirst({ where: { nick: 'dice' } })).id
    expect(said[0].memberId).toBe(diceId)
    expect(diceId).not.toBe(sam.id)
  })

  test('refuse a spec past the limits and a roller who is not in the room', async () => {
    const tavern = (await sys.room.findFirst({ where: { slug: 'tavern' } })).id
    const s = await enter(sam, 'tavern')
    expect((await call(s, 'dice', 'roll', { data: { roomId: tavern, dice: '99d6' } })).type).toBe('service_error')
    expect((await call(s, 'dice', 'roll', { data: { roomId: tavern, dice: 'say 12' } })).type).toBe('service_error')
    const elsewhere = await enter(bob, 'tavern')
    elsewhere.ws.close()
    await sleep(100)
    const gone = await enter(ana, 'tavern')
    const { result: booth } = await sit(sam, bob.id)
    expect((await call(gone, 'dice', 'roll', { data: { roomId: booth.id, dice: 'd6' } })).type).toBe('service_error')
    expect(await sys.message.count({ where: { body: { startsWith: 'sam rolls' } } })).toBe(0)
  })
})
