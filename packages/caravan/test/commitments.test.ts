// test/commitments.test.ts
//
// `@@commitment` end to end — Litestone says which rows are due, junction's
// `commitments()` sweeps and fires, this queue holds the time (`FJS-D353`,
// `FJS-D358`).
//
// It lives here for the reason outbox-relay.test.ts does: the only place a real
// Litestone client, a real Junction app and a real Caravan queue are all
// importable at once. Junction takes caravan as no dependency at all.
//
// The CLIENT's clock is injected and moved by hand; the queue runs on the wall
// clock. That split is the plugin's own — a sweep reads the client's clock and
// measures each fire's delay on it — so advancing the client past a due time
// is a fire with no delay, which is what lets a test run in milliseconds.

import { describe, it, expect, afterEach } from 'bun:test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join }          from 'node:path'

import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { createApp, createTestApp } from '../../junction/index.ts'
import { commitments, fireCommitment, COMMITMENT_FIRE_JOB } from '../../junction/src/plugins/commitments/index.ts'
import { outbox }        from '../../junction/src/plugins/outbox/index.ts'
import type { CommitmentHook } from '../../junction/src/plugins/commitments/index.ts'
import type { App }      from '../../junction/index.ts'
import { createCaravan } from '../src/index.ts'

const SCHEMA = `
database main { path "./app.db" }

enum OrderStatus { pending paid cancelled }

model Order {
  id        Int         @id @default(autoincrement())
  status    OrderStatus @default(pending)
  held      Boolean     @default(false)
  createdAt DateTime    @default(now())
  @@transitions(status,
    pay:     pending -> paid,
    abandon: pending -> cancelled @system)
  @@commitment(abandon, on: createdAt + 14d, while: held == false)
  @@db(main)
}
`

const DAY = 86_400_000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

type BootOpts = { plugin?: boolean; timeZone?: string; hooks?: Record<string, CommitmentHook>; relay?: boolean }

async function bootApp(schema = SCHEMA, { plugin = true, timeZone, hooks, relay = false }: BootOpts = {}) {
  let t = T0
  const db = await createClient({ databases: ':memory:', schema, now: () => new Date(t) }) as any
  closers.push(() => db.$close())

  const app = await createTestApp()
  app.db = db

  const queue = createCaravan({ db: ':memory:', pollInterval: 10 })
  app.configure(queue)
  // A cron that never fires inside a test: every sweep below is driven by hand,
  // so a tick landing mid-assertion cannot move a count.
  // A long interval for the same reason: only the post-commit kick delivers.
  if (relay) app.configure(outbox({ intervalMs: 60_000 }))
  if (plugin) app.configure(commitments({ cron: '0 0 1 1 *', timeZone, hooks }))
  closers.push(() => queue.stop())

  return {
    app: app as unknown as App & { _startForTest(): Promise<void> }, db, queue,
    advance: (ms: number) => { t += ms },
    status:  async (id: number) => (await db.asSystem().order.findUnique({ where: { id } })).status,
  }
}

async function started(schema = SCHEMA, opts: BootOpts = {}) {
  const env = await bootApp(schema, opts)
  await env.app._startForTest()
  return env
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ok()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

const metrics = (app: App) => (app as any)._metricsSources.get('commitments')()

const fires = (queue: ReturnType<typeof createCaravan>) =>
  queue.list({ limit: 500 }).filter(j => j.name === COMMITMENT_FIRE_JOB)

// ─── the sweep and the fire ───────────────────────────────────────────────────

describe('a due row is transitioned', () => {

  it('nothing is dispatched before the due time, and the move is made after it', async () => {
    const { app, db, queue, advance, status } = await started()
    const order = await db.order.create({ data: {} })

    expect(await app.commitments!.sweep()).toEqual({ due: 0 })
    expect(fires(queue)).toHaveLength(0)

    advance(14 * DAY)
    expect(await app.commitments!.sweep()).toEqual({ due: 1 })
    await until('the order to be abandoned', async () => (await status(order.id)) === 'cancelled')
  })

  it('a row due inside the lookahead is dispatched with a delay to its time', async () => {
    // The cadence is not the precision: the sweep runs once and the queue
    // holds the time. Four minutes early, inside the five-minute default.
    const { app, db, queue, advance, status } = await started()
    const order = await db.order.create({ data: {} })

    advance(14 * DAY - 4 * 60_000)
    expect(await app.commitments!.sweep()).toEqual({ due: 1 })

    const [job] = fires(queue)
    expect(job.status).toBe('pending')
    expect(job.run_at - job.created_at).toBeGreaterThan(3 * 60_000)
    expect(await status(order.id)).toBe('pending')
  })

  it('a second sweep while the fire is in flight queues nothing more', async () => {
    const { app, db, queue, advance } = await started()
    await db.order.create({ data: {} })

    advance(14 * DAY - 4 * 60_000)
    await app.commitments!.sweep()
    await app.commitments!.sweep()
    expect(fires(queue)).toHaveLength(1)
  })

  it('the move announces under the transition\'s name', async () => {
    const { app, db, advance } = await started()
    const heard: string[] = []
    ;(db as any).$tapEvents((e: { event: string; transition?: string }) => {
      if (e.event === 'transition') heard.push(e.transition!)
    })
    await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the transition event', () => heard.includes('abandon'))
  })

  it('the trail names the move as well, so a later read tells it from a cancel', async () => {
    // The announcement reaches a live screen and nothing afterwards; the audit
    // row is what an investigation reads, and `before`/`after` alone are the
    // same row a person's cancel writes (`FJS-1294`).
    const dir    = mkdtempSync(join(tmpdir(), 'fjs-commit-audit-'))
    const logged = SCHEMA
      .replace('database main { path "./app.db" }',
        `database main { path "./app.db" }\ndatabase audit { path "${dir}/audit/" driver logger }`)
      .replace('@@db(main)', '@@db(main)\n  @@log(audit)')
    const { app, db, advance, status } = await started(logged)
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the order to be abandoned', async () => (await status(order.id)) === 'cancelled')
    await Bun.sleep(20)

    const rows = await db.asSystem().auditLogs.findMany({})
    const move = rows.find((r: any) => r.operation === 'update')
    expect(move.transition).toBe('abandon')
    expect(JSON.parse(move.after).status).toBe('cancelled')
  })
})

// ─── re-derivation ────────────────────────────────────────────────────────────

describe('the fire asks again before it moves', () => {

  // The queue is PAUSED across the sweep and the write, so the write lands
  // between the dispatch and the fire — the window the re-derivation exists for.

  it('a row that moved after the sweep is a quiet no-op', async () => {
    const { app, db, queue, advance, status } = await started()
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    queue.queue('default').pause()
    await app.commitments!.sweep()
    await db.order.transition(order.id, 'pay')
    queue.queue('default').resume()

    const [job] = fires(queue)
    await until('the fire to finish', () => queue.find(job.id)!.status === 'done')
    expect(await status(order.id)).toBe('paid')
    expect(metrics(app)).toMatchObject({ fired: 0, lapsed: 1, failed: 0 })
  })

  it('a row held and then released fires again at the SAME due time', async () => {
    // Why the key is `unique` and not a stated `id`: an id is idempotent for all
    // time, so the second dispatch below — same row, same transition, same due
    // time — would have been swallowed and the row owed its move forever.
    const { app, db, queue, advance, status } = await started()
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    queue.queue('default').pause()
    await app.commitments!.sweep()
    await db.order.update({ where: { id: order.id }, data: { held: true } })
    queue.queue('default').resume()

    const [first] = fires(queue)
    await until('the held fire to lapse', () => queue.find(first.id)!.status === 'done')
    expect(await status(order.id)).toBe('pending')

    await db.order.update({ where: { id: order.id }, data: { held: false } })
    expect(await app.commitments!.sweep()).toEqual({ due: 1 })
    expect(fires(queue)).toHaveLength(2)
    await until('the released row to be abandoned', async () => (await status(order.id)) === 'cancelled')
  })

  it('while: is read at the sweep too, so a held row is not dispatched at all', async () => {
    const { app, db, queue, advance } = await started()
    await db.order.create({ data: { held: true } })

    advance(15 * DAY)
    expect(await app.commitments!.sweep()).toEqual({ due: 0 })
    expect(fires(queue)).toHaveLength(0)
  })
})

// ─── across a relation ────────────────────────────────────────────────────────

// FJS-D362: the invoice owns the deadline and the subscription owns the move.
// Two unpaid invoices under one subscription is the case the ruling turns on —
// both are dispatched, the older one moves the subscription, and the newer one
// must answer NOTHING DUE rather than a refused move and a failed job.
const DUNNING = `
database main { path "./app.db" }

enum SubStatus  { active pastDue cancelled }
enum BillStatus { issued paid }

model Subscription {
  id       Int       @id @default(autoincrement())
  status   SubStatus @default(active)
  invoices Invoice[]
  @@transitions(status,
    lapse:  active -> pastDue @system,
    cancel: [active, pastDue] -> cancelled @system)
  @@db(main)
}

model Invoice {
  id             Int           @id @default(autoincrement())
  status         BillStatus    @default(issued)
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id])
  subscriptionId Int?
  dueOn          String        @date
  graceDays      Int           @unit(d) @immutable
  @@transitions(status, settle: issued -> paid)
  @@commitment(subscription.lapse, on: dueOn + graceDays, while: status == 'issued')
  @@db(main)
}
`

describe('a commitment on a related model moves the TARGET', () => {

  it('the oldest invoice lapses the subscription and the later one is nothing due', async () => {
    const { app, db, queue, advance } = await started(DUNNING)
    const sub = await db.subscription.create({ data: {} })
    await db.invoice.create({ data: { subscriptionId: sub.id, dueOn: '2025-12-20', graceDays: 3 } })
    await db.invoice.create({ data: { subscriptionId: sub.id, dueOn: '2025-12-25', graceDays: 3 } })
    const subStatus = async () => (await db.asSystem().subscription.findUnique({ where: { id: sub.id } })).status

    advance(DAY)
    queue.queue('default').pause()
    expect(await app.commitments!.sweep()).toEqual({ due: 2 })
    queue.queue('default').resume()

    await until('both fires to finish', () => fires(queue).every(j => j.status === 'done'))
    expect(await subStatus()).toBe('pastDue')
    expect(metrics(app)).toMatchObject({ fired: 1, lapsed: 1, failed: 0 })
    expect(await app.commitments!.sweep()).toEqual({ due: 0 })
  })

  it('a DAY is read in the zone the plugin is given, and the delay is to its start there', async () => {
    // 11:30 UTC on the 9th is half past midnight on the 10th in Auckland. The
    // invoice is due on the 10th: owed there, not yet in UTC — and the fire's
    // delay is measured to the 10th's start in Auckland, not to UTC midnight,
    // which would hold it thirteen hours past its day.
    const staged = async (timeZone?: string) => {
      const env = await started(DUNNING, { timeZone })
      const sub = await env.db.subscription.create({ data: {} })
      await env.db.invoice.create({ data: { subscriptionId: sub.id, dueOn: '2026-01-10', graceDays: 0 } })
      env.advance(8 * DAY + 11.5 * 3_600_000)
      return env
    }
    expect(await (await staged()).app.commitments!.sweep()).toEqual({ due: 0 })

    const nz = await staged('Pacific/Auckland')
    nz.queue.queue('default').pause()
    expect(await nz.app.commitments!.sweep()).toEqual({ due: 1 })
    const [job] = fires(nz.queue)
    expect(job.run_at - job.created_at).toBeLessThan(1_000)
  })

  it('an invoice with no subscription owes nothing, however late', async () => {
    const { app, db, advance } = await started(DUNNING)
    await db.invoice.create({ data: { subscriptionId: null, dueOn: '2025-01-01', graceDays: 3 } })
    advance(365 * DAY)
    expect(await app.commitments!.sweep()).toEqual({ due: 0 })
  })
})

// ─── what a move owes beyond itself ───────────────────────────────────────────

// A receipt per abandon stands in for `example`'s invoice per closed period:
// the effect a move owes, which has to commit with the move or not at all.
const RECEIPTS = SCHEMA.replace('@@db(main)\n}', '@@db(main)\n}\n\nmodel Receipt {\n  id      Int @id @default(autoincrement())\n  orderId Int @unique\n  @@db(main)\n}')

describe('a hook runs in the move\'s transaction', () => {

  it('the move and its effect commit together, and afterCommit runs once after', async () => {
    const seen: string[] = []
    const { app, db, advance, status } = await started(RECEIPTS, { hooks: {
      'Order.abandon': async ({ db: tx, record, afterCommit }) => {
        await tx.asSystem().receipt.create({ data: { orderId: record.id } })
        afterCommit(async () => { seen.push(await status(record.id)) })
      },
    } })
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the afterCommit', () => seen.length === 1)
    expect(seen).toEqual(['cancelled'])
    expect(await db.asSystem().receipt.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('a hook that throws takes the move back with it, and the fire fails', async () => {
    const { app, db, queue, advance, status } = await started(RECEIPTS, { hooks: {
      'Order.abandon': async ({ db: tx, record }) => {
        await tx.asSystem().receipt.create({ data: { orderId: record.id } })
        throw new Error('the effect could not be made')
      },
    } })
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the fire to be attempted', () => metrics(app).failed >= 1)
    expect(await status(order.id)).toBe('pending')
    expect(await db.asSystem().receipt.count()).toBe(0)
    expect(fires(queue)).toHaveLength(1)
  })

  it('a key naming no declared commitment is refused at start', async () => {
    // A renamed commitment would leave its effect unrun with nothing saying so.
    const { app } = await bootApp(SCHEMA, { hooks: { 'Order.abandonn': () => {} } })
    await expect(app._startForTest()).rejects.toThrow(/'Order\.abandonn', which no @@commitment declares/)
  })

  it('fireCommitment runs the same path on a bare client, with no app', async () => {
    // What a drive with no server calls: the plugin's own fire, not a copy.
    let t = T0
    const db = await createClient({ databases: ':memory:', schema: RECEIPTS, now: () => new Date(t) }) as any
    closers.push(() => db.$close())
    const later: string[] = []
    const hooks = { 'Order.abandon': (async ({ db: tx, record, afterCommit }) => {
      await tx.asSystem().receipt.create({ data: { orderId: record.id } })
      afterCommit(() => later.push('after'))
    }) as CommitmentHook }
    const order = await db.order.create({ data: {} })
    const job = { accessor: 'order', transition: 'abandon', id: order.id, dueAt: '' }

    expect(await fireCommitment(db, job, { hooks })).toBe('lapsed')
    t += 14 * DAY
    expect(await fireCommitment(db, job, { hooks })).toBe('fired')
    expect(await fireCommitment(db, job, { hooks })).toBe('lapsed')
    expect(later).toEqual(['after'])
    expect(await db.asSystem().receipt.count()).toBe(1)
  })
})

// ─── an effect outside the database ──────────────────────────────────────────
//
// A reminder's email cannot be taken back, and `afterCommit` loses it to a
// crash between the commit and the send with the move already saying it went —
// a moved row is never due again. `enqueue` writes the intent on the move's
// own transaction instead, and the relay delivers it.

const OUTBOX   = await Bun.file(new URL('../../junction/db/outbox.lite', import.meta.url)).text()
const OUTBOXED = `${SCHEMA}\n${OUTBOX}`

describe('a hook enqueues on the move\'s transaction', () => {

  it('the row commits with the move and the relay runs the job once', async () => {
    const sent: unknown[] = []
    const { app, db, queue, advance, status } = await bootApp(OUTBOXED, { relay: true, hooks: {
      'Order.abandon': async ({ record, enqueue }) => { await enqueue('order-notice', { orderId: record.id }) },
    } })
    queue.handle('order-notice', async (ctx: { data: unknown }) => { sent.push(ctx.data) })
    await app._startForTest()
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the notice', () => sent.length === 1)
    expect(sent).toEqual([{ orderId: order.id }])
    expect(await status(order.id)).toBe('cancelled')

    await app.commitments!.sweep()
    await Bun.sleep(100)
    expect(sent).toHaveLength(1)
    expect(await db.asSystem().outboxMessage.count({ where: { deliveredAt: null } })).toBe(0)
  })

  it('a hook that throws after enqueueing leaves no row and no move', async () => {
    const { app, db, advance, status } = await started(OUTBOXED, { relay: true, hooks: {
      'Order.abandon': async ({ record, enqueue }) => {
        await enqueue('order-notice', { orderId: record.id })
        throw new Error('after the enqueue')
      },
    } })
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the fire to fail', () => metrics(app).failed >= 1)
    expect(await status(order.id)).toBe('pending')
    expect(await db.asSystem().outboxMessage.count()).toBe(0)
  })

  it('with no relay installed the enqueue is refused by name and the move rolls back', async () => {
    // A row nothing delivers would be a reminder that says it went.
    const db = await createClient({ databases: ':memory:', schema: OUTBOXED, now: () => new Date(T0 + 14 * DAY) }) as any
    closers.push(() => db.$close())
    const order = await db.order.create({ data: { createdAt: new Date(T0).toISOString() } })
    const hooks = { 'Order.abandon': (async ({ record, enqueue }) => { await enqueue('order-notice', { orderId: record.id }) }) as CommitmentHook }

    await expect(fireCommitment(db, { accessor: 'order', transition: 'abandon', id: order.id, dueAt: '' }, { hooks }))
      .rejects.toThrow(/ctx\.enqueue\('order-notice'\) in 'commitments\.Order\.abandon': no outbox relay is installed/)
    expect((await db.order.findUnique({ where: { id: order.id } })).status).toBe('pending')
  })
})

// ─── what the app is told ─────────────────────────────────────────────────────

describe('the sweep reports itself', () => {

  it('/metrics carries the counts', async () => {
    const { app, db, advance, status } = await started()
    const order = await db.order.create({ data: {} })
    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the move', async () => (await status(order.id)) === 'cancelled')

    expect(metrics(app)).toMatchObject({ due: 1, fired: 1, lapsed: 0, failed: 0 })
    expect(metrics(app).lastSweepAt).not.toBeNull()
  })

  it('the sweep is a DECLARED schedule, so jobs.snapshot.md carries it', async () => {
    const { queue } = await started()
    const names = queue.registrations().map(r => r.name)
    expect(names).toContain('commitment-sweep')
    expect(names).toContain('commitment-fire')
  })
})

// ─── who makes the move ───────────────────────────────────────────────────────

describe('the move is graded, not bypassed', () => {

  it('a gate the app\'s own principal does not clear FAILS the fire rather than lapsing it', async () => {
    // The read is as system and the move is not: `asSystem()` would skip the
    // state machine and its from-state lock. So a gate above the app's
    // standing refuses the move, and the refusal is counted and retried — a
    // row that is owed a move and cannot get one must not look settled.
    const gated = SCHEMA.replace('model Order {', 'model Order {\n  @@gate("0.0.9.0")')
    const { app, db, queue, advance, status } = await started(gated)
    const order = await db.asSystem().order.create({ data: {} })

    advance(14 * DAY)
    await app.commitments!.sweep()
    await until('the fire to be refused', () => metrics(app).failed >= 1)
    expect(await status(order.id)).toBe('pending')
    expect(metrics(app).lapsed).toBe(0)
    expect(fires(queue)).toHaveLength(1)
  })
})

// ─── tenancy ──────────────────────────────────────────────────────────────────

/** A `createApp({ tenants })` app over two tenants, whose rows are due the moment they exist. */
async function tenanted({ plugin = true } = {}) {
  // An offset BEHIND the anchor, so every row is due the moment it exists and
  // the test needs no clock: a registry opens its clients itself.
  const dir  = mkdtempSync(join(tmpdir(), 'commitments-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, `
tenancy {
  strategy database
  dir      "${dir}/tenants"
  registry "${dir}/registry.db"
}
${SCHEMA.replace('database main { path "./app.db" }', '').replace('  @@db(main)\n', '').replace('createdAt + 14d', 'createdAt - 1d')}
`)
  const registry: any = await createTenantRegistry({ path })
  for (const id of ['acme', 'globex']) await registry.create(id)
  closers.push(() => registry.close?.())

  const app = createApp({ tenants: registry }) as any
  const queue = createCaravan({ db: ':memory:', pollInterval: 10 })
  app.configure(queue)
  if (plugin) app.configure(commitments({ cron: '0 0 1 1 *' }))
  closers.push(() => queue.stop())
  return { app, registry, queue }
}

describe('under tenancy { strategy database }', () => {

  it('a sweep walks every tenant and each fire moves the row in its own file', async () => {
    const { app, registry, queue } = await tenanted()
    await app._startForTest()

    const ids: Record<string, number> = {}
    for (const t of ['acme', 'globex'])
      ids[t] = (await (await registry.get(t)).order.create({ data: {} })).id

    expect(await app.commitments.sweep()).toEqual({ due: 2 })
    expect(fires(queue).map(j => j.tenant_id).sort()).toEqual(['acme', 'globex'])

    for (const t of ['acme', 'globex'])
      await until(`${t}'s order to be abandoned`, async () =>
        (await (await registry.get(t)).asSystem().order.findUnique({ where: { id: ids[t] } })).status === 'cancelled')
  })
})

// ─── refusals ─────────────────────────────────────────────────────────────────

describe('a schema that owes a move with nothing to make it', () => {

  it('is refused at start, naming the plugin', async () => {
    const { app } = await bootApp(SCHEMA, { plugin: false })
    await expect(app._startForTest()).rejects.toThrow(/@@commitment and no commitments\(\) plugin/)
  })

  it('is refused under a tenant registry too, which has no app.db to ask', async () => {
    // `example` is this shape, and it booted with the plugin removed until the
    // refusal read the registry's parsed schema.
    const { app } = await tenanted({ plugin: false })
    await expect(app._startForTest()).rejects.toThrow(/@@commitment and no commitments\(\) plugin/)
  })

  it('a schema with no commitment starts without the plugin', async () => {
    const { app } = await bootApp(SCHEMA.replace(/  @@commitment.*\n/, ''), { plugin: false })
    await app._startForTest()
  })
})
