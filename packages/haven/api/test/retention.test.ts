// api/test/retention.test.ts
// A room keeps its newest KEEP lines and nothing older: the sweep drops the
// rest, exactly, through a burst that stamps several lines on one
// millisecond; a room under the count is untouched; a second sweep finds
// nothing; and the app has the sweep on its clock.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { sweepRooms }    from '../src/retention.ts'
import { signIn }        from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')

let env: any, sys: any, tavern: any, square: any, sam: any

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0 }),
  })
  sys    = env.system
  square = await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  tavern = await sys.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
  sam    = await signIn(env.port, 'sam')
})

afterEach(async () => { await env?.close?.() })

const say = (roomId: number, body: string) =>
  sys.message.create({ data: { roomId, memberId: sam.id, body } })

const bodies = async (roomId: number) =>
  (await sys.message.findMany({ where: { roomId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m: any) => m.body)

test('a room keeps its newest lines and the sweep drops the rest, exactly', async () => {
  for (let i = 1; i <= 7; i++) await say(tavern.id, `tavern ${i}`)
  await say(square.id, 'square 1')
  await say(square.id, 'square 2')

  expect(await sweepRooms(env.db, { keep: 3 })).toEqual([{ roomId: tavern.id, removed: 4 }])
  expect(await bodies(tavern.id)).toEqual(['tavern 5', 'tavern 6', 'tavern 7'])
  expect(await bodies(square.id)).toEqual(['square 1', 'square 2'])

  expect(await sweepRooms(env.db, { keep: 3 })).toEqual([])
  expect(await bodies(tavern.id)).toEqual(['tavern 5', 'tavern 6', 'tavern 7'])
})

test('the app sweeps on its own clock, every hour', () => {
  expect(env.app.scheduler.describe()).toEqual([{ id: expect.any(String), type: 'interval', expr: '1 hour' }])
})
