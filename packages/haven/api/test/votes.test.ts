// api/test/votes.test.ts
// The town hall's votes (`IDEAS/haven.md` Phase 15) over real sockets on a real
// app: a vote cast, changed and withdrawn, one per member and idea, the hall
// told an idea's count moved, an idea nobody stands for refused by name, and a
// banned member's votes counted for nobody -- each refusal beside a vote that
// did count.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { HALL, hallIdeas } from '../src/townhall.ts'
import { POST_KEY, signIn } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))
const [ONE, TWO] = [...hallIdeas()]

interface Sock { ws: WebSocket, frames: any[], callId: number }

let env: any, sys: any, sam: any, ana: any, rex: any
const open: Sock[] = []

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, postKey: POST_KEY }),
  })
  sys = env.system
  await sys.room.create({ data: { slug: HALL, name: 'The town hall' } })
  await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  sam = await signIn(env.port, 'sam')
  ana = await signIn(env.port, 'ana')
  rex = await signIn(env.port, 'rex')
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

async function call (s: Sock, method: string, data?: Record<string, unknown>): Promise<any> {
  const id = String(++s.callId)
  s.ws.send(JSON.stringify({ type: 'service_call', id, service: 'votes', method, ...(data && { data }) }))
  for (let i = 0; i < 200; i++) {
    const answer = s.frames.find(f => f.id === id && (f.type === 'service_result' || f.type === 'service_error'))
    if (answer) return answer
    await sleep(5)
  }
  throw new Error(`no answer to call ${id}`)
}

const cast  = (s: Sock, idea: unknown, aye: unknown) => call(s, 'cast', { idea, aye })
const tally = async (s: Sock) => (await call(s, 'tally')).result
const told  = (s: Sock) => s.frames.filter(f => f.type === 'event' && f.event === 'tallied').map(f => f.data.idea)

test('an aye and a nay are counted for the idea, and each member reads their own', async () => {
  const s = await enter(sam, HALL), a = await enter(ana, HALL)
  expect((await cast(s, ONE, true)).result).toEqual({ idea: ONE, aye: true })
  expect((await cast(a, ONE, false)).type).toBe('service_result')

  expect((await tally(s)).ideas[ONE]).toEqual({ aye: 1, nay: 1 })
  expect((await tally(s)).mine).toEqual({ [ONE]: true })
  expect((await tally(a)).mine).toEqual({ [ONE]: false })
})

test('a second vote changes the first, and null withdraws it', async () => {
  const s = await enter(sam, HALL)
  await cast(s, ONE, true)
  await cast(s, ONE, false)
  expect((await tally(s)).ideas[ONE]).toEqual({ aye: 0, nay: 1 })
  expect(await sys.vote.count({ where: { memberId: sam.id } })).toBe(1)

  await cast(s, ONE, null)
  expect((await tally(s)).ideas[ONE]).toBeUndefined()
  expect(await sys.vote.count({ where: { memberId: sam.id } })).toBe(0)
})

test('everyone standing in the hall is told which idea moved, and nobody outside it', async () => {
  const s = await enter(sam, HALL), a = await enter(ana, HALL), r = await enter(rex, 'square')
  await cast(s, TWO, true)
  await sleep(60)
  expect(told(s)).toEqual([TWO])
  expect(told(a)).toEqual([TWO])
  expect(told(r)).toEqual([])
})

test('an idea nobody in the hall stands for is refused by name, and so is a vote that is no vote', async () => {
  const s = await enter(sam, HALL)
  const none = await cast(s, '99.9', true)
  expect(none.type).toBe('service_error')
  expect(JSON.stringify(none)).toContain('Nobody in the hall stands for 99.9')
  expect((await cast(s, ONE, 'yes')).type).toBe('service_error')
  expect((await cast(s, ONE, true)).type).toBe('service_result')
  expect(await sys.vote.count({})).toBe(1)
})

test('a banned member counts for nobody, and lifting the ban counts them again', async () => {
  const s = await enter(sam, HALL), r = await enter(rex, HALL)
  await cast(s, ONE, true)
  await cast(r, ONE, true)
  expect((await tally(s)).ideas[ONE]).toEqual({ aye: 2, nay: 0 })

  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: new Date().toISOString() } })
  expect((await tally(s)).ideas[ONE]).toEqual({ aye: 1, nay: 0 })
  // Their own reads are empty and their cast writes nothing.
  const rexes = await enter(rex, HALL)
  await cast(rexes, TWO, false)
  expect(await sys.vote.count({ where: { memberId: rex.id, idea: TWO } })).toBe(0)

  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: null } })
  expect((await tally(s)).ideas[ONE]).toEqual({ aye: 2, nay: 0 })
})
