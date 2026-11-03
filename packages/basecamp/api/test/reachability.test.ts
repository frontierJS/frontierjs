/*
 * reachability.test.ts — does anything notice a machine has gone away.
 *
 * The defect this covers was total and completely silent: `unreachable` was the
 * target of no transition, `lastHeartbeatAt` was compared to the clock by
 * nothing, and a machine that died read `online` for ever on every screen
 * (`FJS-1021`).
 *
 * **No drive could have caught it and none can now.** Every browser drive in
 * this app checks in and asserts immediately; nothing anywhere lets time pass.
 * So the clock is a PARAMETER — `sweepUnreachable({ at })` — and this file
 * stands at chosen instants, which is the only arrangement that can ask the
 * question at all.
 *
 * Every row that moves a machine is PAIRED with one that must not: a sweep that
 * marked everything unreachable satisfies any test asking only about the
 * machine that went quiet, and it is the plausible wrong implementation — one
 * WHERE clause on an old timestamp is the whole of it.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }                    from 'node:path'
import { createTestEnv }           from '@frontierjs/testing'
import { GatePlugin }              from '@frontierjs/litestone'
import { basecampGateLevel }       from '../src/core/gate.ts'
import { buildBasecampApp }        from '../src/app.ts'
import { grantsFor }               from '../src/core/capabilities.ts'
import { gradeReachability, HEARTBEAT_GRACE_MS, heartbeatGraceMs,
         DEFAULT_HEARTBEAT_TIMEOUT_S } from '../src/domain/host/reachability.ts'
import { sweepUnreachable }        from '../src/jobs/server-reachability.job.ts'
import notifyDeliver               from '../src/jobs/notify-deliver.job.ts'
import { deliverOwed }             from '../src/domain/notification/owed.ts'

const MINUTE = 60_000

// ─── the verdict, at an instant ─────────────────────────────────────────────

describe('grading one machine', () => {
  const NOW  = Date.parse('2026-09-08T12:00:00.000Z')
  const ago  = (m: number) => new Date(NOW - m * MINUTE).toISOString()

  test('online and quiet past the grace is the one verdict that moves a row', () => {
    expect(gradeReachability({ status: 'online', lastHeartbeatAt: ago(6) }, NOW)).toBe('quiet')
  })

  test('…and online inside the grace is not', () => {
    // The pair. Without it a grader answering `quiet` unconditionally passes the
    // row above, which is the whole of the wrong implementation.
    expect(gradeReachability({ status: 'online', lastHeartbeatAt: ago(1) }, NOW)).toBe('answering')
  })

  test('never having spoken is its OWN answer, not silence', () => {
    // `reportRunning` puts a machine `online` on the vendor's word alone, so an
    // `online` row with no check-in ever is a real state — an enrollment that
    // did not finish. *Never arrived* and *stopped arriving* have different
    // fixes, and folding them loses the one an operator can act on.
    expect(gradeReachability({ status: 'online', lastHeartbeatAt: null }, NOW)).toBe('never-spoke')
  })

  test('a state an operator PUT the machine in is not watched at all', () => {
    // Each of these is quiet by construction — nothing on a stopped box
    // heartbeats — so a sweep grading on the timestamp alone pages somebody
    // about a machine they stopped themselves.
    for (const status of ['stopped', 'draining', 'installing', 'provisioning', 'destroyed'])
      expect(gradeReachability({ status, lastHeartbeatAt: ago(600) }, NOW)).toBe('not-watched')
  })

  test('the grace is a parameter, and the fallback is the COLUMN\'s own default', () => {
    // Not a number chosen here: `HubConfig.heartbeatTimeoutSeconds` is
    // `@default(120)`, and a settings row exists only once somebody has saved
    // one — so until then the app has to behave the way the column says it will.
    expect(DEFAULT_HEARTBEAT_TIMEOUT_S).toBe(120)
    expect(HEARTBEAT_GRACE_MS).toBe(2 * MINUTE)
    const quietFor90s = { status: 'online', lastHeartbeatAt: new Date(NOW - 90_000).toISOString() }
    expect(gradeReachability(quietFor90s, NOW)).toBe('answering')
    expect(gradeReachability(quietFor90s, NOW, 1 * MINUTE)).toBe('quiet')
  })
})

// ─── the sweep, against a real client ───────────────────────────────────────

describe('the fleet sweep', () => {
  let env: any, ws: any, member: any

  beforeAll(async () => {
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
    // `status: 'active'` is stated, not defaulted: `User.status` defaults to
    // `pendingVerification` and `notifyPeople` skips anybody who is not active,
    // silently and correctly — a fixture that left the default would assert the
    // absence of a notification and read as a passing test of the wrong thing.
    member = await sys.user.create({ data: {
      email: `m-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
    ws = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: member.id, role: 'owner',
      capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() } })
  })

  // Far in the future: the test app boots caravan with its cron, and a real
  // sweep at the wall clock would grade a fixture's past heartbeat as quiet, and
  // re-drive a past-stamped owed notice while this file's own pass pays it.
  const NOW = Date.parse('2099-09-08T12:00:00.000Z')
  const ago = (m: number) => new Date(NOW - m * MINUTE).toISOString()

  /** A machine at a stated status and a stated last check-in. A Server is born
   *  `pending` even for the system, so the status is reached by its moves. */
  async function machine(status: 'online' | 'stopped', lastHeartbeatAt: string | null) {
    const uniq = Math.random().toString(36).slice(2, 8)
    const sys  = env.system as any
    const row  = await sys.server.create({ data: {
      workspaceId: ws.id, name: `box-${uniq}`, slug: `box-${uniq}`, lastHeartbeatAt } })
    return sys.server.transition(row.id, status === 'online' ? 'checkIn' : 'reportStopped')
  }
  const statusOf = async (id: string) =>
    (await (env.system as any).server.findUnique({ where: { id } })).status

  test('a machine that went quiet is moved, and its workspace is told', async () => {
    const box = await machine('online', ago(6))
    const before = await (env.system as any).notification.count({ where: { userId: member.id } })

    const res = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })

    expect(res.quiet).toBe(1)
    expect(await statusOf(box.id)).toBe('unreachable')
    expect(await (env.system as any).notification.count({ where: { userId: member.id } }))
      .toBe(before + 1)

    // The trail, and it names the number an operator would otherwise work out
    // from two timestamps on two screens.
    const events = await (env.system as any).serverEvent.findMany({
      where: { serverId: box.id, kind: 'unreachable' } })
    expect(events.length).toBe(1)
    expect(events[0].message).toContain('6 minutes')
  })

  test('the move pays the notice it owes, and the event row stops owing it (FJS-3858)', async () => {
    const box = await machine('online', ago(6))
    await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    const [event] = await (env.system as any).serverEvent.findMany({
      where: { serverId: box.id, kind: 'unreachable' } })
    expect(event.noticeOwedAt).toBeNull()
  })

  test('a notice a crash left owed is paid by notify:deliver, once — paired with one owing nothing', async () => {
    // What a crash between the move and the send leaves: the machine already
    // `unreachable`, so no sweep would move it again, and the event row owing.
    const sys  = env.system as any
    const box  = await machine('online', ago(30))
    await sys.server.transition(box.id, 'loseContact')
    const owed = await sys.serverEvent.create({ data: {
      serverId: box.id, kind: 'unreachable', message: 'No check-in for 30 minutes',
      metadata: { last_heartbeat_at: ago(30) }, noticeOwedAt: ago(10) } })
    const paid = await sys.serverEvent.create({ data: {
      serverId: box.id, kind: 'unreachable', message: 'already told', metadata: {} } })
    const before = await sys.notification.count({ where: { userId: member.id } })

    await (notifyDeliver as any).handler({ app: env.app, data: { owed: 'server', eventId: owed.id } })
    expect(await sys.notification.count({ where: { userId: member.id } })).toBe(before + 1)
    expect((await sys.serverEvent.findUnique({ where: { id: owed.id } })).noticeOwedAt).toBeNull()

    // Paid is paid: a second drain, and a drain of a row that never owed, tell nobody.
    expect(await deliverOwed(env.app, 'server', owed.id)).toBe(false)
    expect(await deliverOwed(env.app, 'server', paid.id)).toBe(false)
    expect(await sys.notification.count({ where: { userId: member.id } })).toBe(before + 1)
  })

  test('a sweep inside the grace window of this process starting grades nobody (FJS-3872)', async () => {
    const box = await machine('online', ago(6))

    // The process began a minute before NOW: the 6-minute silence is Basecamp's own.
    const early = await sweepUnreachable(env.app, { at: NOW, serverId: box.id, startedAt: NOW - 60_000 })
    expect(early.quiet).toBe(0)
    expect(await statusOf(box.id)).toBe('online')

    // The pair: the same machine, once the process has been up past the timeout.
    const later = await sweepUnreachable(env.app, { at: NOW, serverId: box.id, startedAt: NOW - 60 * 60_000 })
    expect(later.quiet).toBe(1)
    expect(await statusOf(box.id)).toBe('unreachable')
  })

  test('…and one still answering is left alone, and told nobody', async () => {
    const box = await machine('online', ago(1))
    const before = await (env.system as any).notification.count({ where: { userId: member.id } })

    const res = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })

    expect(res.quiet).toBe(0)
    expect(await statusOf(box.id)).toBe('online')
    expect(await (env.system as any).notification.count({ where: { userId: member.id } }))
      .toBe(before)
  })

  test('a machine that has never checked in is NAMED, not marked gone', async () => {
    const box = await machine('online', null)
    const res = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })

    expect(res.quiet).toBe(0)
    expect(await statusOf(box.id)).toBe('online')
    // Named rather than counted: this is a state somebody has to fix, and a
    // number nobody can act on is the same as silence.
    expect(res.neverSpoke).toEqual([box.name])
  })

  test('a machine an operator stopped is not swept, however old its heartbeat', async () => {
    const box = await machine('stopped', ago(600))
    const res = await sweepUnreachable(env.app, { at: NOW })
    expect(res.quiet).toBe(0)
    expect(await statusOf(box.id)).toBe('stopped')
  })

  test('sweeping twice at one instant tells nobody twice', async () => {
    const box = await machine('online', ago(9))
    await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    const after = await (env.system as any).notification.count({ where: { userId: member.id } })

    // The second pass reads a row that is no longer `online`, so there is
    // nothing to grade. Asserted because a cron running every minute would
    // otherwise page a workspace 1,440 times about one dead machine.
    const again = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    expect(again.graded).toBe(0)
    expect(await (env.system as any).notification.count({ where: { userId: member.id } }))
      .toBe(after)
  })

  test('a check-in brings it back, which is the half that was already declared', async () => {
    // `checkIn: [pending, installing, unreachable] -> online` has always
    // accepted the return and could never be reached, because nothing could put
    // a row in `unreachable`. This is that round trip.
    const box = await machine('online', ago(6))
    await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    expect(await statusOf(box.id)).toBe('unreachable')

    await (env.system as any).server.transition(box.id, 'checkIn')
    expect(await statusOf(box.id)).toBe('online')
  })

  // ─── a lost machine pages the channels that opted in (FJS-3895) ───────────
  describe('channels', () => {
    const received: { body: any }[] = []
    let hook: ReturnType<typeof Bun.serve>
    beforeAll(() => {
      hook = Bun.serve({ port: 0, async fetch(req) {
        received.push({ body: await req.json() })
        return new Response('ok')
      } })
    })
    // The sweeps after this block would page these channels at a stopped receiver.
    afterAll(async () => {
      await (env.system as any).notificationChannel.updateMany({
        where: { workspaceId: ws.id }, data: { isActive: false } })
      hook?.stop(true)
    })

    async function channel(name: string, extra: Record<string, unknown> = {}) {
      return (env.system as any).notificationChannel.create({ data: {
        workspaceId: ws.id, name: `${name}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'webhook', config: { url: `http://localhost:${hook.port}/${name}` }, ...extra } })
    }
    const heard = (title: string) => received.filter(r => r.body.title === title)

    test('a lost machine pages a channel that pages the fleet, and not one that opted out', async () => {
      received.length = 0
      const on  = await channel('on')
      const off = await channel('off', { isPagedForFleet: false })
      const box = await machine('online', ago(6))
      await sweepUnreachable(env.app, { at: NOW, serverId: box.id })

      const page = heard(`[unreachable] ${box.name}`)
      expect(page.length).toBe(1)
      expect(page[0].body.event).toBe('basecamp.alert')
      expect(page[0].body.severity).toBe('critical')
      expect(page[0].body.key).toBe(`basecamp:server:${box.id}`)
      const stamped = await (env.system as any).notificationChannel.findFirst({ where: { id: on.id } })
      expect(stamped.lastDeliveryAt).toBeTruthy()
      const idle = await (env.system as any).notificationChannel.findFirst({ where: { id: off.id } })
      expect(idle.lastDeliveryAt).toBeNull()
    })

    test('a paused channel is not paged either', async () => {
      received.length = 0
      const paused = await channel('paused', { isActive: false })
      const box = await machine('online', ago(7))
      await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
      const row = await (env.system as any).notificationChannel.findFirst({ where: { id: paused.id } })
      expect(row.lastDeliveryAt).toBeNull()
    })
  })

  test('the timeout comes from the SETTINGS, not from a constant', async () => {
    // `HubConfig.heartbeatTimeoutSeconds` was declared, bounded, rendered on the
    // hub settings screen with a hint describing this exact behavior, and read
    // by nothing. Asserted as a PAIR across one save: the same machine at the
    // same instant is answering under one timeout and quiet under the other, so
    // a sweep that ignored the setting passes neither half.
    const sys = env.system as any
    expect(await heartbeatGraceMs(env.app)).toBe(DEFAULT_HEARTBEAT_TIMEOUT_S * 1_000)

    const box = await machine('online', new Date(NOW - 200_000).toISOString())
    await sys.hubConfig.create({ data: {
      id: 'hub', name: 'Fleet', heartbeatTimeoutSeconds: 3_000 } })
    expect(await heartbeatGraceMs(env.app)).toBe(3_000_000)

    let res = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    expect(res.quiet).toBe(0)
    expect(await statusOf(box.id)).toBe('online')

    const row = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
    await sys.hubConfig.update({ where: { id: 'hub' },
      data: { heartbeatTimeoutSeconds: 30, version: row.version } })

    res = await sweepUnreachable(env.app, { at: NOW, serverId: box.id })
    expect(res.quiet).toBe(1)
    expect(await statusOf(box.id)).toBe('unreachable')

    // Put it back, so the rows after this one grade against the default.
    const again = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
    await sys.hubConfig.update({ where: { id: 'hub' },
      data: { heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_S, version: again.version } })
  })

  test('the fleet pass grades every workspace, and only the quiet ones move', async () => {
    const quiet   = await machine('online', ago(30))
    const talking = await machine('online', new Date(NOW - 20_000).toISOString())
    const res = await sweepUnreachable(env.app, { at: NOW })

    expect(await statusOf(quiet.id)).toBe('unreachable')
    expect(await statusOf(talking.id)).toBe('online')
    // Every `online` row was graded, not just the one that moved — the pair that
    // separates *the sweep works* from *the WHERE clause happened to match*.
    expect(res.graded).toBeGreaterThan(res.quiet)
  })
})
