// api/test/hearing.test.ts
// A line is heard within earshot of its speaker, a `!` line by the whole room,
// and a whisper by the member it names. Real sockets on a real app: every
// refusal sits beside a delivery to a member the line did reach, since a
// broadcast graded to nobody reads exactly like one never sent.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { EARSHOT, hears, withinEarshot } from '../src/hearing.ts'
import { roomChannelName } from '../src/rooms.ts'
import { signIn } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Sock { ws: WebSocket, frames: any[], callId: number }

let env: any, sys: any, square: any, sam: any, ana: any, bob: any, cy: any, mod: any
const open: Sock[] = []

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, mods: ['mod'] }),
  })
  sys    = env.system
  square = await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  sam = await signIn(env.port, 'sam')
  ana = await signIn(env.port, 'ana')
  bob = await signIn(env.port, 'bob')
  cy  = await signIn(env.port, 'cy')
  mod = await signIn(env.port, 'mod')
})

afterEach(async () => {
  for (const s of open.splice(0)) s.ws.close()
  await env?.close?.()
})

async function enter (member: any, at?: [number, number]): Promise<Sock> {
  const ws = new WebSocket(`ws://localhost:${env.port}/ws?room=square`, ['fjs', `fjs.bearer.${member.token}`])
  const s: Sock = { ws, frames: [], callId: 0 }
  ws.onmessage = (e: any) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  open.push(s)
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connection'); i++) await sleep(5)
  await sleep(50)
  if (at) stand(s, ...at)
  return s
}

const stand = (s: Sock, x: number, y: number) =>
  s.ws.send(JSON.stringify({ type: 'subscribe', channel: roomChannelName(square.id), meta: { x, y } }))

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

const say = (s: Sock, body: string, extra: Record<string, unknown> = {}) =>
  call(s, 'messages', 'create', { data: { roomId: square.id, body, ...extra } })

const heard = (s: Sock) => s.frames.filter(f => f.type === 'event' && f.event === 'messages created').map(f => f.data.body)

const NEAR = EARSHOT.x
const FAR  = EARSHOT.x + 1

describe('earshot', () => {
  test('is a box about the speaker, edge included', () => {
    expect(withinEarshot({ x: 50, y: 10 }, { x: 50 + EARSHOT.x, y: 10 + EARSHOT.y })).toBe(true)
    expect(withinEarshot({ x: 50, y: 10 }, { x: 50 + EARSHOT.x + 1, y: 10 })).toBe(false)
    expect(withinEarshot({ x: 50, y: 10 }, { x: 50, y: 10 - EARSHOT.y - 1 })).toBe(false)
  })

  test('is nowhere for a listener with no cell, and the whole room for a speaker with none', () => {
    expect(withinEarshot({ x: 1, y: 1 }, {})).toBe(false)
    expect(hears({ body: 'hi' }, [{ x: 1, y: 1 }], {})).toBe(false)
    expect(hears({ body: 'hi' }, [{}], {})).toBe(true)
    expect(hears({ body: 'hi' }, [], { x: 9, y: 9 })).toBe(true)
  })

  test('is any of a speaker\'s cells: two terminals are heard from either', () => {
    expect(hears({ body: 'hi' }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 100 + NEAR, y: 0 })).toBe(true)
    expect(hears({ body: 'hi' }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 50, y: 0 })).toBe(false)
  })
})

describe('a line said aloud', () => {
  test('reaches the figures within earshot and not the ones beyond it', async () => {
    const s = await enter(sam, [40, 12])
    const a = await enter(ana, [40 + NEAR, 11])
    const b = await enter(bob, [40 + FAR, 11])
    await sleep(100)

    expect((await say(s, 'hello')).type).toBe('service_result')
    await sleep(150)

    expect(heard(a)).toEqual(['hello'])
    expect(heard(s)).toEqual(['hello'])
    expect(heard(b)).toEqual([])
  })

  test('is heard where the listener walks to, and not where the speaker stood', async () => {
    const s = await enter(sam, [40, 12])
    const a = await enter(ana, [40 + FAR, 11])
    await sleep(100)

    await say(s, 'first')
    stand(a, 40 + NEAR, 11)
    await sleep(100)
    await say(s, 'second')
    await sleep(150)

    expect(heard(a)).toEqual(['second'])
  })

  test('reaches a figure beside the speaker and not one who sent no cell', async () => {
    const s = await enter(sam, [40, 12])
    const a = await enter(ana)
    const b = await enter(bob, [41, 11])
    await sleep(100)

    await say(s, 'hello')
    await sleep(150)

    expect(heard(b)).toEqual(['hello'])
    expect(heard(a)).toEqual([])
  })

  test('is still in the room\'s history for a member who did not hear it', async () => {
    const s = await enter(sam, [40, 12])
    const b = await enter(bob, [40 + FAR, 11])
    await sleep(100)
    await say(s, 'hello')
    await sleep(100)

    expect(heard(b)).toEqual([])
    const history = await call(b, 'messages', 'find', { query: { roomId: square.id } })
    expect(history.result.data.map((m: any) => m.body)).toEqual(['hello'])
  })
})

describe('a shout', () => {
  test('is heard by the whole room', async () => {
    const s = await enter(sam, [2, 2])
    const a = await enter(ana, [150, 20])
    await sleep(100)

    await say(s, '!over here')
    await sleep(150)

    expect(heard(a)).toEqual(['!over here'])
  })
})

describe('a whisper', () => {
  test('reaches the member it names across the room, and its speaker, and nobody beside them', async () => {
    const s = await enter(sam, [40, 12])
    const a = await enter(ana, [150, 20])
    const b = await enter(bob, [41, 11])
    const m = await enter(mod, [40, 12])
    await sleep(100)

    const sent = await say(s, 'psst', { toId: ana.id })
    expect(sent).toMatchObject({ type: 'service_result', result: { toId: ana.id } })
    await say(s, 'hello')
    await sleep(150)

    expect(heard(a)).toEqual(['psst'])
    expect(heard(s)).toEqual(['psst', 'hello'])
    // Within earshot of both lines, and given the aloud one only.
    expect(heard(b)).toEqual(['hello'])
    expect(heard(m)).toEqual(['hello'])
  })

  test('is read through find by its two members alone', async () => {
    const s = await enter(sam, [40, 12])
    const a = await enter(ana, [41, 11])
    const b = await enter(bob, [42, 11])
    const m = await enter(mod, [43, 11])
    await say(s, 'psst', { toId: ana.id })
    await say(s, 'hello')
    await sleep(100)

    const bodies = async (who: Sock) =>
      (await call(who, 'messages', 'find', { query: { roomId: square.id } })).result.data.map((r: any) => r.body).sort()
    expect(await bodies(s)).toEqual(['hello', 'psst'])
    expect(await bodies(a)).toEqual(['hello', 'psst'])
    expect(await bodies(b)).toEqual(['hello'])
    expect(await bodies(m)).toEqual(['hello'])
  })
})
