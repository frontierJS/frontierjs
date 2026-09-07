// api/test/alert-evaluate.test.ts
//
// FJS-123: nothing evaluated an alert rule, and nothing delivered a fired one.
//
// Two halves, and they are separate because they fail separately. The
// comparison is pure — no database, no clock, no app — so its rows are the
// cheap ones and cover the shapes a first draft gets wrong. The job is graded
// against a REAL Litestone client, a REAL conduit and a REAL HTTP receiver,
// because every claim it makes is about a crossing: rows the metric store
// wrote, a policy the schema declares, and bytes arriving somewhere else.
//
// ─── What every refusal here is paired with ──────────────────────────────
//
// A missed alert and a quiet system look identical, so a fix that fired NOTHING
// would satisfy any test asking only about the refusals. Every not-fired row
// below therefore sits beside the same series one value over the line.

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'

import { GatePlugin }    from '../../../litestone/src/index.js'
import { createTestEnv } from '../../../litestone/src/testing.js'
import { createConduit } from '@frontierjs/conduit'

import { basecampGateLevel } from '../src/core/gate.ts'
import { evaluateWindow, breaches, describeBreach } from '../src/core/alerting.ts'
import { KINDS, testMessage }  from '../src/core/delivery.ts'
import evaluate              from '../src/jobs/alert-evaluate.job.ts'
import type { BasecampApp }  from '../src/basecamp.types.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const MINUTE     = 60_000

const envs:    { close(): void }[] = []
const servers: { stop(): void }[]  = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
  for (const e of envs.splice(0))    e.close()
})

// ─── the comparison ──────────────────────────────────────────────────────

/** Readings at one-minute spacing, oldest first, ending `now`. */
function series(values: number[], now = Date.now()): { at: number; value: number }[] {
  const base = now - (values.length - 1) * MINUTE
  return values.map((value, i) => ({ at: base + i * MINUTE, value }))
}

describe('evaluateWindow — the three answers that are not "the number is fine"', () => {

  it('an empty window is NOT a breach — paired with the same rule over one reading', () => {
    // `[].every(…)` is `true`, so the obvious implementation fires every rule
    // in the app the moment its exporter dies. The pair is what makes the row
    // grade anything: the same condition over one breaching point must fire.
    const cond = { operator: 'gt' as const, threshold: 80, forMinutes: 0 }

    expect(evaluateWindow([], cond)).toEqual({ breached: false, reason: 'no-data' })
    expect(evaluateWindow(series([90]), cond).breached).toBe(true)
  })

  it('a streak shorter than forMinutes is uncovered — paired with one that reaches it', () => {
    // `forMinutes: 5` means the breach HELD for five minutes, not that a
    // five-minute window happens to contain only breaching points. One reading
    // thirty seconds after a restart satisfies the second and says nothing
    // about the first.
    const cond = { operator: 'gt' as const, threshold: 80, forMinutes: 5 }

    const short = evaluateWindow(series([90, 91, 92]), cond)     // 2 minutes of streak
    expect(short.breached).toBe(false)
    expect(short.reason).toBe('uncovered')

    const held = evaluateWindow(series([90, 91, 92, 93, 94, 95]), cond)  // 5 minutes
    expect(held.breached).toBe(true)
  })

  it('one good reading inside the window ends the streak', () => {
    // The streak is counted BACK from the newest point, so a dip to normal in
    // the middle restarts it. Reading the window as "how many of these breach"
    // fires on a flapping value that was never continuously bad.
    const cond = { operator: 'gt' as const, threshold: 80, forMinutes: 5 }

    const flapped = evaluateWindow(series([90, 91, 50, 92, 93, 94]), cond)
    expect(flapped.breached).toBe(false)
    expect(flapped.reason).toBe('uncovered')
  })

  it('forMinutes 0 reads the newest point and nothing else', () => {
    // A rule with no duration is a rule about right now. Averaging the window,
    // or requiring it, would make zero mean something other than off.
    const cond = { operator: 'gt' as const, threshold: 80, forMinutes: 0 }

    expect(evaluateWindow(series([99, 99, 99, 10]), cond).breached).toBe(false)
    expect(evaluateWindow(series([10, 10, 10, 99]), cond).breached).toBe(true)
  })

  it('`since` is when the streak started, not when the window did', () => {
    // What a person reads off a fired event. Taking the oldest point in the
    // window instead would report a rule as having been bad since before it
    // was.
    const now = Date.now()
    const v   = evaluateWindow(series([10, 10, 90, 91, 92, 93], now),
                               { operator: 'gt', threshold: 80, forMinutes: 3 })
    expect(v.breached).toBe(true)
    if (v.breached) expect(v.since).toBe(now - 3 * MINUTE)
  })

  it('all four operators, each paired with the value one step the other side', () => {
    // A boundary is where an operator is actually decided, so `gte` and `gt`
    // are separated by exactly the value they disagree about.
    expect(breaches(80, 'gt',  80)).toBe(false)
    expect(breaches(81, 'gt',  80)).toBe(true)
    expect(breaches(80, 'gte', 80)).toBe(true)
    expect(breaches(79, 'gte', 80)).toBe(false)
    expect(breaches(1,  'lt',  1)).toBe(false)
    expect(breaches(0,  'lt',  1)).toBe(true)
    expect(breaches(1,  'lte', 1)).toBe(true)
    expect(breaches(2,  'lte', 1)).toBe(false)
  })

  it('the message carries the reading that fired, not an average', () => {
    // An operator paged at 3am needs the number they can go and look at. A mean
    // of the window is a number no screen anywhere shows.
    const msg = describeBreach('process.memoryMb',
                               { operator: 'gt', threshold: 512, forMinutes: 5 }, 640.5)
    expect(msg).toContain('640.5')
    expect(msg).toContain('> 512')
    expect(msg).toContain('for 5m')
  })
})


// ─── the per-kind renderer ───────────────────────────────────────────────

describe('KINDS — one table, and a test must not read as a page-out', () => {

  it('a webhook receiver gets three different event names', () => {
    // The whole reason `action` is on the message. A receiver routing on
    // `event` and given `basecamp.alert` for a button press wakes somebody up
    // for a button press — and a test that looked identical to an alert is
    // exactly what a shared renderer invites.
    const render = KINDS.webhook!.render
    const base   = { title: 't', text: '', severity: 'info' as const }

    expect(render({ ...base, action: 'test'    }, {}).event).toBe('basecamp.test')
    expect(render({ ...base, action: 'trigger' }, {}).event).toBe('basecamp.alert')
    expect(render({ ...base, action: 'resolve' }, {}).event).toBe('basecamp.resolved')
  })

  it('PagerDuty knows two verbs, and a test carries no dedup key', () => {
    // Events API v2 has no third verb, so a test is a trigger. What keeps it
    // from touching a real incident is the absent key, not the verb.
    const render = KINDS.pagerduty!.render
    const base   = { title: 't', text: '', severity: 'warning' as const }

    expect(render({ ...base, action: 'test' }, {}).event_action).toBe('trigger')
    expect(render({ ...base, action: 'test' }, {}).dedup_key).toBeUndefined()
    expect(render({ ...base, action: 'trigger', dedupKey: 'k' }, {}).dedup_key).toBe('k')
    // A resolve sends no payload — v2 rejects one rather than ignoring it.
    expect(render({ ...base, action: 'resolve', dedupKey: 'k' }, {}).payload).toBeUndefined()
  })

  it('the Slack test post is one line and names the channel', () => {
    const body = KINDS.slack!.render(testMessage('#ops'), {}) as { text: string }
    expect(body.text).toContain('#ops')
    expect(body.text).not.toContain('\n')
  })
})

// ─── the job ─────────────────────────────────────────────────────────────

const noopLog = () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return l
}

/** A real client, a real conduit, and a real HTTP receiver to deliver into.
 *  Nothing here is a stand-in: a fake conduit would agree with a fan-out that
 *  built the wrong body, which is exactly the half a unit test cannot see. */
async function makeApp() {
  const env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: ENC_KEY,
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
  })
  envs.push(env)

  const received: { path: string; body: any }[] = []
  const server = Bun.serve({
    port:  0,
    async fetch(req) {
      received.push({ path: new URL(req.url).pathname, body: await req.json() })
      return new Response('ok')
    },
  })
  servers.push(server)

  const conduit = createConduit({ timeout_ms: 2_000, retry_limit: 0 })
  const db: any = env.db.asSystem()

  const app = {
    db: env.db, conduit, logger: noopLog(),
    // `runsAsApp` refuses when an actor is in scope — this is a cron, so there
    // is none, and saying so is what the mode asserts rather than assumes.
    principal: () => undefined,
  } as unknown as BasecampApp

  return { app, db, received, origin: `http://localhost:${server.port}` }
}

/** A workspace, a rule, and the series the rule watches, with readings. */
async function fixture(db: any, opts: {
  values:     number[]
  operator?:  'gt' | 'gte' | 'lt' | 'lte'
  threshold?: number
  forMinutes?: number
  metricName?: string
  /** Push every reading this far into the past, to make the series stale. */
  ageMs?:     number
}) {
  const stamp   = `${Date.now()}-${Math.round(performance.now() * 1000)}`
  const account = await db.account.create({ data: { displayName: 'Acme', slug: `acme-${stamp}` } })
  const ws      = await db.workspace.create({
    data: { name: 'Ops', slug: `ops-${stamp}`, accountId: account.id, ownerId: account.id },
  })

  const name = opts.metricName ?? 'process.memoryMb'
  const rule = await db.alertRule.create({
    data: {
      workspaceId: ws.id, name: `watch ${stamp}`, metricName: name, severity: 'warning',
      operator: opts.operator ?? 'gt', threshold: opts.threshold ?? 512,
      forMinutes: opts.forMinutes ?? 0,
    },
  })

  const age    = opts.ageMs ?? 0
  const newest = Date.now() - age
  const s = await db.metricSeries.create({
    data: { name, labelsKey: name, type: 'gauge',
            lastSeenAt: new Date(newest).toISOString() },
  })
  const base = newest - (opts.values.length - 1) * MINUTE
  for (let i = 0; i < opts.values.length; i++)
    await db.metricPoint.create({
      data: { seriesId: s.id, at: base + i * MINUTE, value: opts.values[i] },
    })

  return { ws, rule, series: s }
}

const run = (app: BasecampApp) => (evaluate as any).handler({ app } as never)

describe('alert-evaluate — the job between a rule and an event', () => {

  it('fires once, and does not fire a second event while the first is open', async () => {
    // The second pass is the assertion. An evaluator that wrote an event every
    // minute a threshold was crossed would page somebody sixty times an hour,
    // and the first pass alone cannot tell that apart from working.
    const { app, db } = await makeApp()
    const { rule }    = await fixture(db, { values: [600, 610, 620] })

    await run(app)
    let events = await db.alertEvent.findMany({ where: { ruleId: rule.id } })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('firing')
    expect(events[0].valueAtTrigger).toBe(620)
    // A series is neither a server nor a volume, and calling it one would page
    // whoever owns the machine for a number about this process.
    expect(events[0].subjectType).toBe('series')

    await run(app)
    events = await db.alertEvent.findMany({ where: { ruleId: rule.id } })
    expect(events).toHaveLength(1)
  })

  it('a reading back inside the threshold resolves the open event', async () => {
    const { app, db } = await makeApp()
    const { rule, series: s } = await fixture(db, { values: [600, 610, 620] })

    await run(app)
    const opened = (await db.alertEvent.findMany({ where: { ruleId: rule.id } }))[0]
    expect(opened.status).toBe('firing')

    await db.metricPoint.create({ data: { seriesId: s.id, at: Date.now() + MINUTE, value: 100 } })
    await run(app)

    const closed = await db.alertEvent.findFirst({ where: { id: opened.id } })
    expect(closed.status).toBe('resolved')
    expect(closed.resolvedAt).toBeTruthy()
  })

  it('A SERIES THAT STOPPED DOES NOT RESOLVE — paired with one that recovered', async () => {
    // The single worst thing this file could do. A scrape that stopped and a
    // value that came back inside its threshold draw the same flat line, and
    // closing an incident because the exporter died is how an outage goes
    // unnoticed. The pair is the whole row: the same open event, the same rule,
    // one with a good reading and one with no reading at all.
    const { app, db } = await makeApp()

    const stopped = await fixture(db, { values: [600, 610, 620], metricName: 'a.stopped' })
    await run(app)
    const openA = (await db.alertEvent.findMany({ where: { ruleId: stopped.rule.id } }))[0]
    expect(openA.status).toBe('firing')

    // Every point ages out of the window; nothing new arrives.
    await db.metricPoint.removeMany({ where: { seriesId: stopped.series.id } })
    await run(app)
    expect((await db.alertEvent.findFirst({ where: { id: openA.id } })).status).toBe('firing')

    const recovered = await fixture(db, { values: [600, 610, 620], metricName: 'b.recovered' })
    await run(app)
    const openB = (await db.alertEvent.findMany({ where: { ruleId: recovered.rule.id } }))[0]
    await db.metricPoint.create({
      data: { seriesId: recovered.series.id, at: Date.now() + MINUTE, value: 1 },
    })
    await run(app)
    expect((await db.alertEvent.findFirst({ where: { id: openB.id } })).status).toBe('resolved')
  })

  it('a rule naming a series nothing has written fires nothing and throws nothing', async () => {
    // The state a typo leaves a rule in. It must not fire, and it must not take
    // the rest of the pass down with it — the rules after it in the same run
    // are the ones that would go unevaluated.
    const { app, db } = await makeApp()
    const { rule }    = await fixture(db, { values: [600], metricName: 'real.series' })
    const ghost = await db.alertRule.create({
      data: { workspaceId: rule.workspaceId, name: 'typo', metricName: 'proces.memoryMb',
              severity: 'warning', operator: 'gt', threshold: 1 },
    })

    await run(app)
    expect(await db.alertEvent.count({ where: { ruleId: ghost.id } })).toBe(0)
    expect(await db.alertEvent.count({ where: { ruleId: rule.id } })).toBe(1)
  })

  it('a paused rule is not evaluated — paired with the identical active one', async () => {
    const { app, db } = await makeApp()
    const { rule } = await fixture(db, { values: [600, 610], metricName: 'c.paused' })
    await db.alertRule.update({ where: { id: rule.id }, data: { isActive: false } })
    const twin = await fixture(db, { values: [600, 610], metricName: 'd.active' })

    await run(app)
    expect(await db.alertEvent.count({ where: { ruleId: rule.id } })).toBe(0)
    expect(await db.alertEvent.count({ where: { ruleId: twin.rule.id } })).toBe(1)
  })

  it('a stale series cannot fire on the number it last wrote', async () => {
    // Bounded by MIN_WINDOW_MS. Without it a `forMinutes: 0` rule reads the
    // newest point whenever it was written, so an exporter that died a week ago
    // pages somebody for a reading from last Tuesday, forever.
    const { app, db } = await makeApp()
    const { rule } = await fixture(db, { values: [600, 610], ageMs: 3 * 24 * 60 * MINUTE,
                                         metricName: 'e.stale' })
    const fresh    = await fixture(db, { values: [600, 610], metricName: 'f.fresh' })

    await run(app)
    expect(await db.alertEvent.count({ where: { ruleId: rule.id } })).toBe(0)
    expect(await db.alertEvent.count({ where: { ruleId: fresh.rule.id } })).toBe(1)
  })

  it('the event REACHES the channel — paired with a rule attached to none', async () => {
    // A fan-out that delivered to nobody is indistinguishable from one that
    // works if the only thing asserted is the event row. This is the crossing:
    // real conduit, real HTTP, and the bytes are read off the receiver.
    const { app, db, received, origin } = await makeApp()
    const { ws, rule } = await fixture(db, { values: [600, 610], metricName: 'g.delivered' })

    const channel = await db.notificationChannel.create({
      data: { workspaceId: ws.id, name: '#ops', kind: 'webhook',
              config: { url: `${origin}/hook` } },
    })
    await db.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: channel.id } })

    const silent = await fixture(db, { values: [600, 610], metricName: 'h.silent' })

    await run(app)

    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/hook')
    expect(received[0].body.event).toBe('basecamp.alert')
    expect(received[0].body.severity).toBe('warning')
    expect(received[0].body.text).toContain('g.delivered')

    // The rule with no channel still fired — reaching nobody is a legitimate
    // state, and swallowing the event would hide the rule from its own screen.
    expect(await db.alertEvent.count({ where: { ruleId: silent.rule.id } })).toBe(1)

    // The stamp means something arrived, which is why it is written after the
    // send and not beside it.
    const stamped = await db.notificationChannel.findFirst({ where: { id: channel.id } })
    expect(stamped.lastDeliveryAt).toBeTruthy()
  })

  it('the resolve carries the SAME dedup key as the trigger', async () => {
    // What lets PagerDuty close the incident it opened instead of opening a
    // second one. The event id, not the rule id: two firings of one rule are
    // two incidents.
    const { app, db, received, origin } = await makeApp()
    const { ws, rule, series: s } = await fixture(db, { values: [600, 610], metricName: 'i.dedup' })

    const channel = await db.notificationChannel.create({
      data: { workspaceId: ws.id, name: '#ops', kind: 'webhook', config: { url: `${origin}/hook` } },
    })
    await db.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: channel.id } })

    await run(app)
    await db.metricPoint.create({ data: { seriesId: s.id, at: Date.now() + MINUTE, value: 1 } })
    await run(app)

    expect(received).toHaveLength(2)
    expect(received[0].body.event).toBe('basecamp.alert')
    expect(received[1].body.event).toBe('basecamp.resolved')
    expect(received[1].body.key).toBe(received[0].body.key)
  })

  it('a channel that refuses does not cost the rules after it', async () => {
    // One dead Slack webhook must not abandon every rule later in the pass —
    // which is why delivery ANSWERS rather than throws.
    const { app, db, origin } = await makeApp()
    const { ws, rule } = await fixture(db, { values: [600, 610], metricName: 'j.broken' })

    const broken = await db.notificationChannel.create({
      // No credential stored, so the send is refused before it leaves.
      data: { workspaceId: ws.id, name: '#dead', kind: 'slack', config: {} },
    })
    await db.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: broken.id } })
    const later = await fixture(db, { values: [600, 610], metricName: 'k.later' })

    await run(app)
    expect(await db.alertEvent.count({ where: { ruleId: rule.id } })).toBe(1)
    expect(await db.alertEvent.count({ where: { ruleId: later.rule.id } })).toBe(1)
    expect(origin).toBeTruthy()
  })
})
