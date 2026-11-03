// The morning report leaves through a transport Workbench owns: an in-app row
// for the member and a ping to the topic their phone holds. Run against the
// real plugin, the real schema and the real notification file, with ntfy's
// HTTP stubbed by path -- what is asserted is what would have been POSTed.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { createTestEnv } from '@frontierjs/litestone/testing'
import { notifications, ntfy } from '@frontierjs/notifications'
import type { App } from '@frontierjs/junction'

import { sendReport } from '../src/domain/atlas/autopilot-report.ts'
import { pushTopic }  from '../src/push.ts'
import { summary, type AutopilotReportPayload } from '../src/notifications/AutopilotReport.notification.ts'

const DB         = join(import.meta.dir, '..', '..', 'db')
const SRC        = join(import.meta.dir, '..', 'src')
const ENC_KEY    = '0'.repeat(64)
const scratch    = mkdtempSync(join(tmpdir(), 'workbench-push-'))
const envs: { close(): void }[] = []
afterAll(() => { for (const e of envs.splice(0)) e.close(); rmSync(scratch, { recursive: true, force: true }) })

const PAYLOAD: AutopilotReportPayload = {
  from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z', on: true,
  ran: 4, closed: 3, blocked: 1, failed: 0, framed: 2, spend: 1.5,
  day: { attempts: 4, dollars: 1.5, capAttempts: 10, capDollars: 20 }, patches: 2, tick: null, review: null,
}

async function makeApp () {
  const env = await createTestEnv({ schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: ENC_KEY })
  envs.push(env)

  const posts: { url: string, headers: Record<string, string>, body: string }[] = []
  const deliver = (async (url: string, init: { headers: Record<string, string>, body: string }) => {
    posts.push({ url, headers: init.headers, body: init.body })
    return new Response(JSON.stringify({ id: 'n1' }), { status: 200 })
  }) as unknown as typeof fetch

  const l: any = { info () {}, warn () {}, error () {}, debug () {}, child: () => l }
  const app: any = {
    db: env.db, logger: l, root: SRC,
    push: { rung: 3, url: 'https://ntfy.test', topic: 'workbench-abcdefghijkl' },
    channel: () => undefined,
    own (name: string, value: unknown) { (this as any)[name] = value },
  }
  const plugin = notifications({ db: env.db, transports: { push: ntfy({ url: 'https://ntfy.test', deliver }) } }) as any
  plugin.register(app)
  await plugin.boot?.(app)
  return { app: app as App, sys: env.db.asSystem() as any, posts }
}

describe('the AutopilotReport is sent', () => {
  test('writes the member an in-app row and publishes the one-line summary to their topic', async () => {
    const { app, sys, posts } = await makeApp()
    const member = await sys.member.create({ data: { nick: 'jordan' } })

    expect(await sendReport(app, sys, PAYLOAD)).toBe(true)

    const rows = await sys.notification.findMany({ where: { userId: member.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('AutopilotReport')
    expect(rows[0].readAt).toBeNull()
    expect(rows[0].data.title).toBe('Autopilot overnight')
    expect(rows[0].data.body).toBe(`${summary(PAYLOAD)} 2 patches on the Dock.`)
    expect(rows[0].data.action).toEqual({ label: 'Open the town', url: '/atlas/autopilot/' })

    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('https://ntfy.test/workbench-abcdefghijkl')
    expect(posts[0].body).toBe('4 runs · 3 closed · 1 blocked · 2 framed · $1.50')
    expect(posts[0].headers.Title).toBe('Autopilot overnight')
    expect(posts[0].headers.Click).toBe('http://localhost:5508/atlas/autopilot/')
  })

  test('with nobody signed in at the door, nothing is written and nothing is published', async () => {
    const { app, sys, posts } = await makeApp()
    expect(await sendReport(app, sys, PAYLOAD)).toBe(false)
    expect(await sys.notification.findMany({})).toHaveLength(0)
    expect(posts).toHaveLength(0)
  })
})

describe('the topic', () => {
  test('is minted once into the push file and read back, never re-minted', () => {
    const file = join(scratch, 'config', 'push.json')
    const first = pushTopic(file)
    expect(first).toMatch(/^workbench-[a-z0-9]{12}$/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ topic: first })
    expect(pushTopic(file)).toBe(first)
  })
})
