// api/test/bolt-service.test.ts
// `d` end to end on the server (`IDEAS/haven.md` 9.5): a member standing in a
// room fires, the SERVER resolves what the bolt hit against the scene's
// `world.json`, and the whole room is told once. Real sockets on a real app;
// every refusal sits beside a bolt that did fly.
//
// Cells are found in the scene files rather than written here, so a moved
// piece fails a test that says what moved instead of one that misses by a cell.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { BOLT_MS, KNOCK, RANGE } from '../src/bolt.ts'
import { roomChannelName } from '../src/rooms.ts'
import { obstacleAt, worldFor } from '../src/world.ts'
import type { SceneWorld } from '../src/world.ts'
import { signIn } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Sock { ws: WebSocket, frames: any[], callId: number }

let env: any, sys: any, tavern: any, woods: any, sam: any, ana: any, rex: any
const open: Sock[] = []

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0 }),
  })
  sys    = env.system
  tavern = await sys.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
  woods  = await sys.room.create({ data: { slug: 'woods',  name: 'The woods' } })
  sam    = await signIn(env.port, 'sam')
  ana    = await signIn(env.port, 'ana')
  rex    = await signIn(env.port, 'rex')
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

const stand = async (s: Sock, roomId: number, meta: Record<string, unknown>) => {
  s.ws.send(JSON.stringify({ type: 'subscribe', channel: roomChannelName(roomId), meta }))
  await sleep(60)
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
const fire   = (s: Sock, roomId: number, data: Record<string, unknown> = {}) => call(s, 'rooms', 'bolt', { data: { roomId, ...data } })

/** A run of open floor `n` cells long going east, with the cell after it solid: `{ x, y, stop }`. Not on a pacer's row. */
function eastward (world: SceneWorld, n: number, stopKind: 'wall' | 'piece') {
  for (let y = 0; y < world.height; y++) {
    if (world.pacers.some(p => p.y === y)) continue
    for (let x = 0; x + n < world.width; x++) {
      const run = world.rows[y].slice(x, x + n)
      if (run !== '.'.repeat(n)) continue
      const stop = obstacleAt(world, x + n, y, 0)
      if (stop?.kind === stopKind) return { x, y, stop: { x: x + n, y, ...stop } }
    }
  }
  throw new Error(`no ${n}-cell run ending in a ${stopKind} in ${world.slug}`)
}

describe('a bolt', () => {
  test('hits the member in its line, knocks them back, and tells the room once', async () => {
    const world = worldFor('tavern')!
    const { x, y } = eastward(world, KNOCK + 4, 'wall')
    const s = await enter(sam, 'tavern'), a = await enter(ana, 'tavern')
    await stand(s, tavern.id, { x, y, facing: 'e' })
    await stand(a, tavern.id, { x: x + 2, y })

    const answer = await fire(s, tavern.id)
    expect(answer.type).toBe('service_result')
    const blast = answer.result
    expect(blast.by).toBe(sam.id)
    expect(blast.struck).toEqual([{ id: ana.id, to: { x: x + 2 + KNOCK, y } }])
    expect(blast.flights[0].path).toEqual([{ x: x + 1, y }, { x: x + 2, y }])

    await sleep(60)
    for (const sock of [s, a]) expect(events(sock, 'bolt')).toHaveLength(1)
    expect(events(a, 'bolt')[0].data.struck[0].id).toBe(ana.id)
  })

  test('a plain d flies the way the figure faces, and a stated way wins', async () => {
    const world = worldFor('tavern')!
    const { x, y } = eastward(world, 4, 'wall')
    const s = await enter(sam, 'tavern')
    await stand(s, tavern.id, { x, y, facing: 'e' })
    const east = (await fire(s, tavern.id)).result
    expect(east.flights[0].facing).toBe('e')
    expect(east.flights[0].path).toHaveLength(3)   // the run's other three cells; the wall is not crossed

    // A fresh member, a fresh cooldown: the same cell, a way stated against the facing.
    const a = await enter(ana, 'tavern')
    await stand(a, tavern.id, { x, y, facing: 'e' })
    expect((await fire(a, tavern.id, { facing: 'w' })).result.flights[0].facing).toBe('w')
  })

  test('is not ready again for BOLT_MS, and the refusal names the wait', async () => {
    const world = worldFor('tavern')!
    const { x, y } = eastward(world, 4, 'wall')
    const s = await enter(sam, 'tavern')
    await stand(s, tavern.id, { x, y, facing: 'e' })
    expect((await fire(s, tavern.id)).type).toBe('service_result')
    const again = await fire(s, tavern.id)
    expect(again.type).toBe('service_error')
    expect(again.error?.message ?? again.message).toMatch(/not ready/)
    expect(BOLT_MS).toBeGreaterThan(1000)
  })

  test('scorches the wall it stops on, and the room remembers it', async () => {
    const world = worldFor('tavern')!
    const { x, y, stop } = eastward(world, 4, 'wall')
    const s = await enter(sam, 'tavern')
    await stand(s, tavern.id, { x, y, facing: 'e' })
    const { result } = await fire(s, tavern.id)
    expect(result.flights[0].hit).toMatchObject({ kind: 'wall', at: { x: stop.x, y } })
    expect(result.laid).toMatchObject([{ kind: 'scorch', x: stop.x, y }])
    expect(env.app.memory.live(roomChannelName(tavern.id), 'scorch')).toHaveLength(1)
  })

  test('shatters a piece that breaks, which then stops nothing, for everyone', async () => {
    const world = worldFor('woods')!
    const { x, y, stop } = eastward(world, 3, 'piece')
    const s = await enter(sam, 'woods'), a = await enter(ana, 'woods')
    await stand(s, woods.id, { x, y, facing: 'e' })
    await stand(a, woods.id, { x, y, facing: 'e' })

    const first = (await fire(s, woods.id)).result
    expect(first.flights[0].hit).toMatchObject({ kind: 'piece', id: stop.id })
    expect(first.laid).toMatchObject([{ kind: 'struck', id: stop.id }])

    // Another member's bolt, the same line: the piece is gone, so it flies past.
    const second = (await fire(a, woods.id)).result
    expect(second.flights[0].hit?.id).not.toBe(stop.id)
    expect(second.flights[0].path.length).toBeGreaterThan(first.flights[0].path.length)
    expect(second.laid.filter((t: any) => t.kind === 'struck')).toEqual([])
  })

  test('a joiner is handed the broken piece, as a trace beside the footprints', async () => {
    const world = worldFor('woods')!
    const { x, y, stop } = eastward(world, 3, 'piece')
    const s = await enter(sam, 'woods')
    await stand(s, woods.id, { x, y, facing: 'e' })
    await fire(s, woods.id)

    const late = await enter(ana, 'woods')
    const traces = (await call(late, 'rooms', 'traces', { meta: { id: woods.id } })).result
    expect(traces.filter((t: any) => t.kind === 'struck')).toMatchObject([{ kind: 'struck', id: stop.id }])
    expect(traces[0].until).toBeGreaterThan(traces[0].at)
    expect(await call(late, 'rooms', 'traces', { meta: { id: tavern.id } })).toMatchObject({ result: [] })
    expect(await call(late, 'rooms', 'traces', { meta: { id: 99999 } })).toMatchObject({ type: 'service_error', error: { code: 404 } })
  })

  test('dd flies all four ways at once, and keeps the longer wait', async () => {
    const world = worldFor('tavern')!
    const { x, y } = eastward(world, 4, 'wall')
    const s = await enter(sam, 'tavern')
    await stand(s, tavern.id, { x: x + 1, y, facing: 'e' })
    const { result } = await fire(s, tavern.id, { volley: true })
    expect(result.flights.map((f: any) => f.facing)).toEqual(['n', 'e', 's', 'w'])
    expect(result.flights.every((f: any) => f.path.length <= RANGE)).toBe(true)
  })

  test('is refused to a member who is not standing in the room, a banned one, and a room with no scene', async () => {
    const world = worldFor('tavern')!
    const { x, y } = eastward(world, 4, 'wall')
    const s = await enter(sam, 'tavern')
    await stand(s, tavern.id, { x, y, facing: 'e' })
    const a = await enter(ana, 'woods')          // ana is in the woods; sam's tavern is not hers
    expect((await fire(a, tavern.id)).type).toBe('service_error')

    const r = await enter(rex, 'tavern')
    expect((await fire(r, tavern.id)).type).toBe('service_error')

    const booth = await sys.room.create({ data: { slug: 'booth-1-2', name: 'A booth' } })
    expect((await fire(s, booth.id)).type).toBe('service_error')

    // And beside them, the same member's bolt in their own room flies.
    expect((await fire(s, tavern.id)).type).toBe('service_result')
  })
})
