/*
 * crash.test.ts — an app Basecamp deployed reports its crash (IDEAS/alerting.md 2.3).
 *
 * Two halves, because the app holds its exit 3 s at most (FJS-D2185): the route
 * answers at once and only QUEUES, and the `app:crashed` job tells the people
 * and the channels the App picked. Each answer the app acts on is claimed: a
 * 404 and a 503 send it to its own ntfy settings, a 202 does not — including
 * the 202 that says alerts are off, which must queue nothing.
 *
 * `createTestEnv` starts no worker (FJS-4584), so the job is run by hand from
 * the row the route queued.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }               from 'node:path'
import { createTestEnv }      from '@frontierjs/testing'
import { GatePlugin }         from '@frontierjs/litestone'
import { basecampGateLevel }  from '../src/core/gate.ts'
import { buildBasecampApp }   from '../src/app.ts'
import { grantsFor }          from '../src/core/capabilities.ts'
import crashed, { CRASH_JOB } from '../src/jobs/app-crashed.job.ts'
import { crashLimiter, parseCrash, CRASH_LIMIT } from '../src/plugins/app-crash.ts'

let env: any, ws: any, member: any, environment: any, hook: ReturnType<typeof Bun.serve>
const heard: any[] = [], pushed: any[] = []
const uniq = () => Math.random().toString(36).slice(2, 8)
const sys  = () => env.system as any

beforeAll(async () => {
  hook = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/crash') heard.push(await req.json())
    else pushed.push({ path, title: req.headers.get('title') ?? req.headers.get('x-title'), body: await req.text() })
    return new Response('ok')
  } })
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    // The fleet first, and the hub's own ntfy App in it: push is resolved once
    // at boot, and with no server named it is public ntfy.sh (`push.ts`).
    api: async ({ db, path }: any) => { await fleet(db.asSystem()); return buildBasecampApp({ db, dbPath: path }) },
  })
})

async function fleet(sys: any) {
  const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
  member = await sys.user.create({ data: { email: `m-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: member.id, role: 'owner',
    capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() } })
  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
  const bp = await sys.blueprint.findFirst({ where: { slug: 'ntfy' } }) ?? await sys.blueprint.create({ data: {
    slug: 'ntfy', name: 'ntfy', category: 'notifications', description: 'push', version: '2', image: 'binwiederhier/ntfy' } })
  const ntfy = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: 'ntfy', slug: `ntfy-${uniq()}`, blueprintId: bp.id, status: 'running' } })
  await sys.variable.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, appId: ntfy.id, key: 'NTFY_BASE_URL', value: `http://127.0.0.1:${hook.port}` } })
}

afterAll(() => { hook?.stop(true) })

const anApp = (over: Record<string, unknown> = {}) => sys().app.create({ data: {
  workspaceId: ws.id, environmentId: environment.id, name: `shop-${uniq()}`, slug: `s-${uniq()}`, ...over } })

const report = (appId: string, body: unknown = { message: 'boom', stack: 'at main', host: 'box-1', missed: 2 }) =>
  env.http.post(`/hooks/crash/${appId}`).send(body)

const queued = (appId: string) =>
  (env.app.jobs.list({ queue: 'default', status: 'pending', limit: 10_000 }) as any[])
    .filter(j => j.name === CRASH_JOB && JSON.parse(j.data).appId === appId)

const runQueued = (appId: string) =>
  Promise.all(queued(appId).map(j => (crashed as any).handler({ app: env.app, data: JSON.parse(j.data), attempts: 1 })))

describe('the crash route answers at once', () => {
  test('a crash for an App with alerts on is 202 and queues one fan-out', async () => {
    const app = await anApp()
    const res = await report(app.id)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ queued: true })
    const [job] = queued(app.id)
    expect(JSON.parse(job.data)).toEqual({ appId: app.id, message: 'boom', stack: 'at main', host: 'box-1', missed: 2 })
  })

  test('alerts off is 202 too, so the app does not fall back, and nothing is queued', async () => {
    const app = await anApp({ isCrashAlerted: false })
    const res = await report(app.id)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ queued: false, reason: 'crash alerts are off for this app' })
    expect(queued(app.id)).toHaveLength(0)
  })

  test('an App that does not exist, or was deleted, is 404 — the app falls back to its own ntfy', async () => {
    expect((await report('00000000-0000-4000-8000-000000000000')).status).toBe(404)
    const gone = await anApp()
    await sys().app.delete({ where: { id: gone.id } })
    expect((await report(gone.id)).status).toBe(404)
  })

  test('a body that is not a crash is 400 and queues nothing', async () => {
    const app = await anApp()
    const res = await report(app.id, { stack: 'no message' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/needs `message`/)
    expect(queued(app.id)).toHaveLength(0)
  })

  test(`past ${CRASH_LIMIT} reports an hour one App is 429 with Retry-After, and another App is not`, async () => {
    const loud = await anApp(), quiet = await anApp()
    for (let i = 0; i < CRASH_LIMIT; i++) expect((await report(loud.id)).status).toBe(202)
    const over = await report(loud.id)
    expect(over.status).toBe(429)
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    expect(queued(loud.id)).toHaveLength(CRASH_LIMIT)
    expect((await report(quiet.id)).status).toBe(202)
  })
})

describe('parseCrash and the limiter', () => {
  test('missed is a whole number, and long fields are cut, not refused', () => {
    expect(parseCrash({ message: 'x', missed: -1 })).toMatch(/whole number/)
    expect(parseCrash({ message: 'x', missed: 1.5 })).toMatch(/whole number/)
    expect(parseCrash({ message: 'x', host: 3 })).toMatch(/`host` is a string/)
    const r = parseCrash({ message: 'm'.repeat(5000) }) as any
    expect(r.message).toHaveLength(2000)
    expect(r).toMatchObject({ stack: '', host: '', missed: 0 })
  })

  test('the window resets, and the count is per App', () => {
    let now = 0
    const over = crashLimiter(1, 1000, () => now)
    expect(over('a')).toBeNull()
    expect(over('a')).toBe(1)
    expect(over('b')).toBeNull()
    now = 1000
    expect(over('a')).toBeNull()
  })
})

describe('the app:crashed job tells people and the picked channels', () => {
  const channel = () => sys().notificationChannel.create({ data: {
    workspaceId: ws.id, name: `hook-${uniq()}`, kind: 'webhook',
    config: { url: `http://localhost:${hook.port}/crash` } } })
  const told = (appId: string) => sys().notification.findMany({ where: { userId: member.id, type: 'AppCrashed' } })
    .then((rows: any[]) => rows.filter(r => JSON.stringify(r).includes(appId)))

  test('a picked webhook hears one trigger with no dedup key, and the members are told', async () => {
    const app = await anApp()
    const picked = await channel(), unpicked = await channel()
    await sys().appChannel.create({ data: { appId: app.id, channelId: picked.id } })
    heard.length = 0; pushed.length = 0

    await report(app.id)
    await runQueued(app.id)

    expect(pushed).toHaveLength(1)
    expect(pushed[0].path).toMatch(/-critical-/)
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({ event: 'basecamp.alert', title: `[crashed] ${app.name}`, severity: 'critical', appId: app.id, host: 'box-1' })
    expect(heard[0].text).toMatch(/boom/)
    expect(heard[0].text).toMatch(/Crashed 2 more times/)
    expect(heard[0]).not.toHaveProperty('key')
    expect(JSON.stringify(heard)).not.toContain(unpicked.id)
    expect(await told(app.id)).toHaveLength(1)
  })

  test('an App switched off after the report pages nobody', async () => {
    const app = await anApp()
    const picked = await channel()
    await sys().appChannel.create({ data: { appId: app.id, channelId: picked.id } })
    heard.length = 0; pushed.length = 0

    await report(app.id)
    await sys().app.update({ where: { id: app.id }, data: { isCrashAlerted: false } })
    await runQueued(app.id)

    expect(heard).toHaveLength(0)
    expect(pushed).toHaveLength(0)
    expect(await told(app.id)).toHaveLength(0)
  })
})
