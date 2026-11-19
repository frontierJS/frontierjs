// A claimed mirror's create whose row the caller cannot read yet (`FJS-3148`,
// ruled `FJS-D1305`).
//
// The create lands at the Provider and then as the system here, and the answer
// is the re-read under the caller's policies. A read policy that runs through a
// relation the Provider fills later (a private channel readable through its
// membership, which only the sync lands) re-reads nothing, and that answered
// 204 with no body while the write had happened. The answer is 202 carrying the
// key and nothing the policy withheld. The call announces nothing of its own,
// since the key alone is not a row; the system write it made announces the
// landed row, graded per recipient as every system write is.

import { describe, test, expect } from 'bun:test'
import { request }        from '../src/testing/index.ts'
import { createApp }      from '../src/core/app.ts'
import { createService }  from '../src/core/service.ts'
import { createClient }   from '../../litestone/src/index.js'
import { createStubAuth } from '../index.ts'

const SCHEMA = `
  claim id
  model Channel {
    id         Int     @id
    externalId String
    name       String
    type       String
    members    ChannelMember[]
    @@mirror(key: externalId)
    @@allow(read, type == 'open' || members.some(userId == auth().id))
  }
  model ChannelMember {
    id                Int     @id
    externalId        String
    channelExternalId String
    userId            String
    channel           Channel @relation(fields: [channelExternalId], references: [externalId])
    @@mirror(key: externalId)
    @@allow(read, true)
  }
`

async function mirrorApp() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({
    db:     db as never,
    auth:   createStubAuth({ users: [{ id: 'alice', role: 'member' }] }),
    config: { port: 0 },
  } as never)
  let n = 0
  // The Provider answers the channel alone; the creator's membership reaches
  // this app only by the sync.
  const forward = { create: async (data: Record<string, unknown>) => ({ ...data, externalId: `ch-${++n}` }) }
  app.own('conduit', { send: () => {}, mirrored: (accessor: string) => accessor === 'channel' ? forward : undefined })
  app.services.register(createService({ name: 'channels', model: 'Channel' } as never))
  await app._startForTest()
  const announced: unknown[] = []
  app.events.on('channels:created', (row: unknown) => { announced.push(row) })
  return { app, db, announced }
}

const tick = () => new Promise(r => setTimeout(r, 10))

describe('a claimed mirror create the caller cannot read yet', () => {

  test('answers 202 naming the key, lands the row, and announces the row rather than the key', async () => {
    const { app, db, announced } = await mirrorApp()
    const warned: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    try {
      const res = await request(app).post('/channels').auth('test-token-alice').send({ name: 'secret', type: 'private' })

      expect(res.status).toBe(202)
      expect(res.body).toEqual({ externalId: 'ch-1' })
      expect(await (db as any).asSystem().channel.count()).toBe(1)
      await tick()
    } finally {
      console.warn = warn
    }
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ externalId: 'ch-1', name: 'secret', type: 'private' })
    expect(warned.filter(w => w.includes('not a Channel row'))).toEqual([])
  })

  // The pair: the same create on a row the policy admits answers the row.
  test('a row the caller can read answers 201 with the row, announced', async () => {
    const { app, announced } = await mirrorApp()
    const res = await request(app).post('/channels').auth('test-token-alice').send({ name: 'lobby', type: 'open' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ externalId: 'ch-1', name: 'lobby', type: 'open' })
    await tick()
    expect(announced).toHaveLength(1)
  })
})
