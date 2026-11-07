// api/test/services.test.ts -- the four services that moved in from Basecamp keep
// the standing they declared there. The door grades its one member
// ADMINISTRATOR (auth.ts), so a method declared lower would be reachable by a
// plain signed-in CREATOR the day a second tier appears; a method with no gate
// at all is open to anyone who signs in.

import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LEVELS } from '@frontierjs/litestone'
import { createTestEnv, session } from '@frontierjs/testing'
import type { App } from '@frontierjs/junction'

import { buildWorkbenchApp } from '../src/app.ts'
import { sendReport } from '../src/domain/atlas/autopilot-report.ts'
import type { AutopilotReportPayload } from '../src/notifications/AutopilotReport.notification.ts'

import atlas     from '../src/services/atlas/atlas.service.ts'
import basecamps from '../src/services/basecamps/basecamps.service.ts'
import claude    from '../src/services/claude/claude.service.ts'
import git       from '../src/services/git/git.service.ts'
import laptop    from '../src/services/laptop/laptop.service.ts'
import workbench from '../src/services/workbench/workbench.service.ts'

const services = { atlas, basecamps, claude, git, laptop, workbench } as Record<string, { methods: Array<{ method: string, gate?: number }> }>

describe('every method of the moved services is gated at ADMINISTRATOR', () => {
  for (const [name, service] of Object.entries(services)) {
    test(name, () => {
      expect(service.methods.length).toBeGreaterThan(0)
      for (const m of service.methods) expect([name, m.method, m.gate]).toEqual([name, m.method, LEVELS.ADMINISTRATOR])
    })
  }
})

// The bell reads this service as the door's member (`auth.ts`: a Member id as
// the session id, isAdmin). The real app over a test database, the real
// AutopilotReport through the plugin the app configured.
describe('the member reads the notifications the morning report wrote', () => {
  const DB      = join(import.meta.dir, '..', '..', 'db')
  const PAYLOAD: AutopilotReportPayload = {
    from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z', on: true,
    ran: 2, closed: 2, blocked: 0, failed: 0, framed: 0, spend: 0.5,
    day: { attempts: 2, dollars: 0.5, capAttempts: null, capDollars: null }, patches: 0, tick: null, review: null,
  }
  const envs: { close(): Promise<void> }[] = []
  afterAll(async () => { for (const e of envs.splice(0)) await e.close() })

  async function boot () {
    const env: any = await createTestEnv({
      schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: '0'.repeat(64),
      api: ({ db }: any) => buildWorkbenchApp({ db, key: 'test-key', deliver: (async () => new Response('', { status: 200 })) as unknown as typeof fetch }) as Promise<App>,
    })
    envs.push(env)
    const sys = env.system as any
    const member = await sys.member.create({ data: { nick: 'jordan' } })
    const stranger = await sys.member.create({ data: { nick: 'other' } })
    const as = (m: { id: number }) => env.as(session({ id: String(m.id), isAdmin: true })).service('notifications')
    return { env, sys, member, stranger, as }
  }

  test('lists them newest first, marks one read, and marks the rest read', async () => {
    const { env, sys, member, stranger, as } = await boot()
    expect(await sendReport(env.app, sys, PAYLOAD)).toBe(true)
    await sys.notification.create({ data: { userId: stranger.id, type: 'AutopilotReport', data: { title: 'not yours' } } })
    await sys.notification.create({ data: { userId: member.id, type: 'AutopilotReport', data: { title: 'second' } } })

    const mine = as(member)
    const listed = (await mine.find({})) as { data: Array<{ id: number, userId: number, readAt: string | null, data: { title: string } }> }
    expect(listed.data).toHaveLength(2)
    expect(listed.data.every(n => n.userId === member.id)).toBe(true)
    expect(listed.data.every(n => n.readAt === null)).toBe(true)

    await mine.patch(listed.data[0].id, {})
    const afterOne = (await mine.find({})) as typeof listed
    expect(afterOne.data.filter(n => n.readAt !== null)).toHaveLength(1)

    expect(await mine.call('readAll')).toEqual({ count: 1 })
    const all = (await mine.find({})) as typeof listed
    expect(all.data.every(n => n.readAt !== null)).toBe(true)
    // Somebody else's row is not the member's to mark.
    expect((await sys.notification.findMany({ where: { userId: stranger.id } }))[0].readAt).toBeNull()
  })

  test('a caller with no session is refused, not answered with an empty list', async () => {
    const { env } = await boot()
    await expect(env.service('notifications').find({})).rejects.toThrow()
  })
})
