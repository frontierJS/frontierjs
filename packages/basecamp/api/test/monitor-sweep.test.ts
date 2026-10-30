/*
 * monitor-sweep.test.ts — does anything ask a URL whether it is up.
 *
 * Nothing in Basecamp probed a URL (`FJS-1557`). The grading is `probe.test.ts`;
 * this is the sweep against a real client and a real listener, standing at
 * chosen instants (`sweepMonitors({ at })`), because no drive lets time pass.
 *
 * Each row that moves a monitor is paired with one that must not: a sweep that
 * paged on every failure, or probed everything every pass, satisfies any test
 * asking only about the monitor that did go down.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }                    from 'node:path'
import { createTestEnv }           from '@frontierjs/testing'
import { GatePlugin }              from '@frontierjs/litestone'
import { basecampGateLevel }       from '../src/core/gate.ts'
import { buildBasecampApp }        from '../src/app.ts'
import { grantsFor }               from '../src/core/capabilities.ts'
import { sweepMonitors }           from '../src/jobs/monitor-sweep.job.ts'

const SECOND = 1_000
// Far in the future, and every fixture is due AT it: the test app boots caravan
// with its cron, and a real `monitor-sweep` firing on a minute boundary mid-test
// would otherwise probe a fixture whose `nextCheckAt` is null or already past.
const T0     = Date.parse('2099-01-01T12:00:00.000Z')

describe('the monitor sweep', () => {
  let env: any, ws: any, member: any, target: ReturnType<typeof Bun.serve>
  let answer = 200

  beforeAll(async () => {
    // The thing being probed. `answer` is what it says next; `/redirect/N`
    // bounces N more times; `/slow` outlasts any timeout this file sets.
    target = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const hop = /^\/redirect\/(\d+)$/.exec(url.pathname)
        if (hop) {
          const n = Number(hop[1])
          return n > 0
            ? new Response(null, { status: 302, headers: { location: `/redirect/${n - 1}` } })
            : new Response('end', { status: 200 })
        }
        if (url.pathname === '/slow') { await Bun.sleep(3_000); return new Response('late') }
        return new Response(answer === 200 ? 'ok' : 'no', { status: answer })
      },
    })

    env = await createTestEnv({
      schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
      migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
      encryptionKey: '0'.repeat(64),
      plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
      api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
    })
    const sys  = env.system as any
    const uniq = () => Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
    member = await sys.user.create({ data: {
      email: `m-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
    ws = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: member.id, role: 'owner',
      capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() } })
  })

  afterAll(() => { target?.stop(true) })

  const base = () => `http://127.0.0.1:${target.port}`
  const sys  = () => env.system as any
  // The listener is on loopback, which the sweep refuses by default; the block
  // after this one is what it refuses.
  const sweep = (opts: Parameters<typeof sweepMonitors>[1]) =>
    sweepMonitors(env.app, { destinations: { allowPrivate: true }, ...opts })

  async function monitor(over: Record<string, unknown> = {}) {
    return sys().monitor.create({ data: {
      workspaceId: ws.id, name: `m-${Math.random().toString(36).slice(2, 8)}`,
      url: `${base()}/`, retries: 1, retryIntervalSec: 60, intervalSec: 120,
      nextCheckAt: new Date(T0).toISOString(),
      ...over } })
  }
  const row    = (id: string) => sys().monitor.findUnique({ where: { id } })
  const events = (id: string) => sys().monitorEvent.findMany({ where: { monitorId: id } })
  const told   = () => sys().notification.count({ where: { userId: member.id } })

  test('a 502 waits out its retries, then goes down and pages once', async () => {
    answer = 502
    const m = await monitor()
    const before = await told()

    await sweep({ at: T0, monitorId: m.id })
    let r = await row(m.id)
    expect(r.status).toBe('pending')
    expect(r.failStreak).toBe(1)
    expect(await told()).toBe(before)
    // The retry comes at the retry interval, not the monitor's own.
    expect(Date.parse(r.nextCheckAt)).toBe(T0 + 60 * SECOND)

    const res = await sweep({ at: T0 + 60 * SECOND, monitorId: m.id })
    expect(res.down).toBe(1)
    r = await row(m.id)
    expect(r.status).toBe('down')
    expect(await told()).toBe(before + 1)
    const ev = await events(m.id)
    expect(ev.length).toBe(1)
    expect(ev[0].fromStatus).toBe('pending')
    expect(ev[0].toStatus).toBe('down')
    expect(ev[0].message).toBe('Request failed with status code 502')

    // The pair: still failing is not a second page.
    await sweep({ at: T0 + 180 * SECOND, monitorId: m.id })
    expect(await told()).toBe(before + 1)
    expect((await events(m.id)).length).toBe(1)

    // Every probe is a heartbeat-bar row.
    expect(await sys().monitorCheck.count({ where: { monitorId: m.id } })).toBe(3)

    // Recovery: one message, and the streak is gone.
    answer = 200
    const back = await sweep({ at: T0 + 300 * SECOND, monitorId: m.id })
    expect(back.up).toBe(1)
    r = await row(m.id)
    expect(r.status).toBe('up')
    expect(r.failStreak).toBe(0)
    expect(r.lastLatencyMs).toBeGreaterThanOrEqual(0)
    expect(await told()).toBe(before + 2)
  })

  test('a monitor that is not due, or is paused, is not probed', async () => {
    answer = 200
    const due    = await monitor()
    const future = await monitor({ nextCheckAt: new Date(T0 + 600 * SECOND).toISOString() })
    const paused = await monitor()
    await sys().monitor.transition(paused.id, 'pause')

    await sweep({ at: T0 })

    expect((await row(due.id)).lastCheckedAt).not.toBeNull()
    expect((await row(future.id)).lastCheckedAt).toBeNull()
    expect((await row(paused.id)).lastCheckedAt).toBeNull()
  })

  test('a first success is up with no recovery notice', async () => {
    answer = 200
    const m = await monitor()
    const before = await told()
    await sweep({ at: T0, monitorId: m.id })
    expect((await row(m.id)).status).toBe('up')
    expect(await told()).toBe(before)
    expect((await events(m.id)).length).toBe(1)
  })

  test('redirects are followed up to maxRedirects, and then it is a failure', async () => {
    const ok  = await monitor({ url: `${base()}/redirect/2`, maxRedirects: 2, retries: 0 })
    const bad = await monitor({ url: `${base()}/redirect/3`, maxRedirects: 2, retries: 0 })
    await sweep({ at: T0 })
    expect((await row(ok.id)).status).toBe('up')
    expect((await row(bad.id)).status).toBe('down')
    const checks = await sys().monitorCheck.findMany({ where: { monitorId: bad.id } })
    expect(checks[0].message).toBe('Maximum redirects (2) exceeded')
  })

  test('a request that never answers fails with its reason, not an aborted sweep', async () => {
    const slow = await monitor({ url: `${base()}/slow`, timeoutMs: 1_000, retries: 0 })
    // Nothing listens on port 1.
    const dead = await monitor({ url: 'http://127.0.0.1:1/', retries: 0 })
    const fine = await monitor({ retries: 0 })
    answer = 200

    await sweep({ at: T0 })

    expect((await row(slow.id)).status).toBe('down')
    const [slowCheck] = await sys().monitorCheck.findMany({ where: { monitorId: slow.id } })
    expect(slowCheck.message).toBe('Timed out after 1000ms')
    expect(slowCheck.latencyMs).toBeNull()
    expect((await row(dead.id)).status).toBe('down')
    // The monitor after the broken ones still got its check.
    expect((await row(fine.id)).status).toBe('up')
  })

  test('upside-down: a URL that must not answer is up while it fails', async () => {
    answer = 503
    const m = await monitor({ invert: true, retries: 0 })
    await sweep({ at: T0, monitorId: m.id })
    expect((await row(m.id)).status).toBe('up')
  })

  test('a monitor paused while its probe was in flight stays paused', async () => {
    answer = 502
    const m = await monitor({ retries: 0 })
    await sys().monitor.transition(m.id, 'pause')
    await sweep({ at: T0, monitorId: m.id })
    expect((await row(m.id)).status).toBe('paused')
  })
})

// FJS-2879 · FJS-D1018: the sweep runs inside the network that holds the
// fleet's secrets, and an admin who writes a monitor is a workspace role, not
// an operator. Every request and every redirect hop is graded, with no setting.
describe('the monitor sweep grades every destination', () => {
  let env: any, ws: any, target: ReturnType<typeof Bun.serve>
  let hits = 0

  beforeAll(async () => {
    target = Bun.serve({ port: 0, fetch() { hits++; return new Response('ok') } })
    env = await createTestEnv({
      schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
      migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
      encryptionKey: '0'.repeat(64),
      plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
      api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
    })
    const sys  = env.system as any
    const uniq = () => Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
    const user = await sys.user.create({ data: {
      email: `m-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
    ws = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  })

  afterAll(() => { target?.stop(true) })

  const probeOf = async (url: string) => {
    const sys = env.system as any
    const m = await sys.monitor.create({ data: {
      workspaceId: ws.id, name: `m-${Math.random().toString(36).slice(2, 8)}`, url,
      retries: 0, nextCheckAt: new Date(T0).toISOString() } })
    await sweepMonitors(env.app, { monitorId: m.id, at: T0 })
    const [check] = await sys.monitorCheck.findMany({ where: { monitorId: m.id } })
    return check
  }

  test('loopback is refused before a request is sent', async () => {
    const check = await probeOf(`http://127.0.0.1:${target.port}/`)
    expect(check.ok).toBe(false)
    expect(check.message).toBe('127.0.0.1 is a private address')
    expect(hits).toBe(0)
  })

  test('a name resolving to loopback, and the metadata service, are refused too', async () => {
    expect((await probeOf(`http://localhost:${target.port}/`)).message).toMatch(/resolves to a private address/)
    expect((await probeOf('http://169.254.169.254/latest/meta-data/')).message).toBe('169.254.169.254 is a private address')
    expect(hits).toBe(0)
  })
})
