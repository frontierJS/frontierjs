/**
 * web/test/verify-jobs.mjs — the deferred-work realm, over HTTP only.
 *
 * No browser. Everything here is a fact about the API and the queue, and the
 * one fact that needs a browser — *a tab nobody touched shows the tracking code
 * a job wrote* — lives in verify-live.mjs where the watcher tab already is.
 *
 * What it drives: `ship` is a state transition plus one piece of work that
 * should NOT happen inline. The move answers immediately with no tracking code;
 * a @frontierjs/caravan worker books the courier off the request and writes the
 * result back through the orders SERVICE, so the change announces like any
 * other.
 *
 * The API must be up (`bun run api`). The web server is not needed.
 *
 * It signs in ONCE, sharing the 10-per-15-minutes login window with the three
 * browser drives.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { requireServers } from './lib/preflight.mjs'
import { results, report } from './lib/report.mjs'

const API = process.env.API_URL ?? 'http://localhost:8110'
const REF = 'ORD-JOBS-1'
// The audit database is `driver trail` with `retention 90d`, so its rows are
// lines in a file rather than a table. Relative to the app root, which is where
// `bun run verify:jobs` is invoked from — the same resolution the declaration
// gets, and the reason `FJS-449` is a hazard worth knowing about here.
const AUDIT = 'db/audit/auditTrail.jsonl'

await requireServers([['api (bun run api)', `${API}/api/health`]])

const { got, t } = results()

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Poll until `fn()` returns something truthy, or give up. Returns false on timeout. */
async function until(fn, ms = 10_000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}

let orderId = null
let auth    = null
const abandonIds = []
// Planted straight into the shop's file, so removed from it the same way: an
// invoice is deleted by the system alone, and its subscription is `Restrict`.
const dunning = { subs: [], invoices: [] }

try {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
  })
  if (!login.ok) {
    if (login.status === 429) console.error(
      `\nSign-in was rate limited (HTTP 429).\n` +
      `Login allows 10 attempts per 15 minutes and the drives share the window.\n` +
      `Wait, or restart the API to reset it.`)
    throw new Error(`sign-in failed: HTTP ${login.status}`)
  }
  auth = { authorization: `Bearer ${(await login.json()).token}`, 'content-type': 'application/json' }

  // `reference` is @unique, so a run that threw before its cleanup would make
  // the next one fail for a reason that has nothing to do with jobs — and the
  // sweep has to look with `$withDeleted` and RELEASE the value rather than
  // delete the row again: `Order` soft-deletes and a deleted row keeps its
  // `@unique` values, so the row this drive removed still holds ORD-JOBS-1 and
  // a second DELETE is a no-op against something already gone (`FJS-546`).
  const stale = await (await fetch(`${API}/api/orders?reference=${REF}&$withDeleted=true`, { headers: auth })).json()
  for (const row of stale.data ?? []) {
    // `@length(3, 20)`, so the freed reference is truncated rather than grown.
    const freed = `${REF}-X${row.id}`.slice(0, 20)
    await fetch(`${API}/api/orders/${row.id}?$withDeleted=true`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ reference: freed }),
    })
    if (!row.deletedAt)
      await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })
  }

  // ── 1. the queue is mounted and declares what it runs ──────────────────
  //
  // Caravan's admin routes are raw app.get routes, and app.get applies the
  // app's apiPrefix like it does to everything else — /api/jobs (FJS-012).
  // Worth asserting: the path is the thing most likely to be wrong after a
  // config change, and a 404 here is indistinguishable from "no jobs" if you
  // only look at the body.
  const listRes = await fetch(`${API}/api/jobs`)
  t('admin.list', { status: listRes.status, isArray: Array.isArray(await listRes.json()) })

  const schedules = await (await fetch(`${API}/api/jobs/schedules`)).json()
  // Sorted, because two `*.job.ts` files declare a `cron` and the autoloader's
  // order is the file system's. Both are asserted by name: a schedule that
  // stops being registered is NOTHING HAPPENING, which is the failure mode
  // this file exists for (FJS-327, FJS-328).
  const cronOf = (name) => schedules.find(s => s.name === name)?.cron ?? null
  t('cron.registered', {
    names: schedules.map(s => s.name).sort(),
    // The clock under every `@@commitment`, installed by `commitments()` and
    // written in no job file — an order's abandon, an invoice's dunning and
    // reminder, and a subscription period's close.
    commit: cronOf('commitment-sweep'),
    holds:  cronOf('holds-release'),
    // The schema's own retention policy, which litestone sweeps once inside
    // `createClient` and never again — so `database audit { retention 90d }` is
    // true for one moment unless something puts it on a clock (`FJS-521`). The
    // declaration is the policy and the schedule is the app's; asserting the
    // expression here is what stops that sentence quietly becoming false again.
    retain: cronOf('retention'),
    // A cron with no next fire time is a parse failure that reports as silence.
    hasNextRun: schedules.every(s => !!s.nextRun),
  })

  // ── 2. ship answers WITHOUT waiting for the courier ────────────────────
  const created = await fetch(`${API}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ reference: REF, total: 1200, status: 'pending', customerId: 1 }),
  })
  const body = await created.json()
  orderId = body.id ?? body.data?.id

  // Counted as a DELTA from here, for the reason the courier bookings are:
  // jobs.db outlives db/shop.db across runs and SQLite reuses row ids, so an
  // announcement naming order 5 is this run's and also whichever order held id
  // 5 last time. An absolute count reports the previous run's work as this
  // run's. Identified by PAYLOAD — ctx.enqueue writes no `unique` key.
  // `?data=1` — the admin route redacts the payload unless asked, and this
  // filter reads it, so without the flag it matches nothing and the drive
  // reports a job that ran as one that never did.
  const announcementsFor = async () =>
    (await (await fetch(`${API}/api/jobs?limit=500&data=1`)).json())
      .filter(j => {
        if (j.name !== 'payment-announce') return false
        try { return JSON.parse(j.data)?.orderId === orderId } catch { return false }
      })
  const announcementsBefore = (await announcementsFor()).length

  await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'pay' }, body: '{}',
  })

  const shipped = await (await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'ship' }, body: '{}',
  })).json()

  // The whole point: the order has moved and the courier has not been called.
  // If this ever comes back WITH a tracking code, the booking has crept back
  // into the request and the caller is waiting on a third party again.
  t('ship.answersImmediately', { status: shipped.status, trackingCode: shipped.trackingCode })

  // ── 3. …and the work happens afterwards ────────────────────────────────
  const tracked = await until(async () => {
    const o = await (await fetch(`${API}/api/orders/${orderId}`, { headers: auth })).json()
    return o.trackingCode ? o : null
  })
  t('job.wroteTracking', {
    arrived: !!tracked,
    // Deterministic from the reference, so this is a value and not just "truthy".
    trackingCode: tracked ? tracked.trackingCode : null,
    stillShipped: tracked ? tracked.status : null,
  })

  // ── 4. the job record itself ───────────────────────────────────────────
  const job = await until(async () => {
    const jobs = await (await fetch(`${API}/api/jobs?limit=500`)).json()
    return jobs.find(j => j.unique_key === `courier-book:${orderId}` && j.status === 'done') ?? null
  })
  t('job.record', job ? {
    name:     job.name,
    queue:    job.queue,
    status:   job.status,
    attempts: job.attempts,
    // Declared on defineJob, not at dispatch — a courier outage is minutes.
    maxAttempts: job.max_attempts,
    retryDelay:  job.retry_delay,
  } : { missing: true })

  // ── 5. dispatching the same move twice books one courier ───────────────
  //
  // Shipping a shipped order is refused at the Data boundary: since `FJS-611` a
  // move asked for BY NAME onto the state the row already holds is a
  // `TransitionConflictError` (409, `retryable: false`), because arriving there
  // means the move did not happen here. So the dispatch is never reached, and
  // the booking count is held at zero by the state machine rather than by the
  // queue. A duplicate booking is a real parcel, so it is still worth counting
  // — what changed is WHICH mechanism is being asked.
  // Counted as a DELTA, not as a total. jobs.db outlives db/shop.db across runs
  // and SQLite reuses row ids, so `courier-book:5` names this run's order and
  // also whichever order held id 5 last time — an absolute count reports the
  // previous run's booking as a duplicate of this one's.
  const bookingsFor = async () =>
    (await (await fetch(`${API}/api/jobs?limit=500`)).json())
      .filter(j => j.unique_key === `courier-book:${orderId}`).length
  const bookingsBefore = await bookingsFor()

  const second = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'ship' }, body: '{}',
  })
  t('ship.twice', {
    status: second.status,
    newBookings: (await bookingsFor()) - bookingsBefore,
  })

  // ── 6. the outbox: an effect that survives the gap ─────────────────────
  //
  // `pay` records its announcement with ctx.enqueue rather than dispatching it,
  // so the intent is written INSIDE the move's own transaction and the relay
  // hands it to the queue afterwards (`FJS-D35`). Two things are observable
  // from out here, and both are the point:
  //
  //   · the job is queued under the outbox row's uuid, not under a `unique`
  //     key — which is what makes a replayed handoff a no-op rather than a
  //     second email
  //   · a REFUSED move records nothing, because the row rolls back with the
  //     write it belongs to. That is the half a second database could not buy
  //     and the half afterCommit cannot buy either
  const announced = await until(async () => {
    const rows = await announcementsFor()
    return rows.length > announcementsBefore ? rows : null
  })
  t('outbox.announcementQueued', {
    count: announced ? announced.length - announcementsBefore : 0,
    // The outbox row's id IS the job id, namespaced. `occurrenceKey('outbox', id)`
    // is the one definition of it (FJS-342) — the jobs table is shared with every
    // id a caller states, so the relay's ids live under a prefix rather than
    // competing with them. A `unique` key would still be here if this had gone
    // out as a plain dispatch.
    // The newest row is this run's — /api/jobs answers newest first.
    idIsRowId: !!announced && /^outbox:[0-9a-f-]{36}$/.test(announced[0].id),
    uniqueKey: announced ? announced[0].unique_key : 'no job',
  })

  // The order is SHIPPED by now, so paying it is refused by the machine. The
  // claim is not the 409 — it is that nothing was recorded on the way to it.
  const beforeRefused = (await announcementsFor()).length
  const refused = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'pay' }, body: '{}',
  })
  await sleep(1_500)   // longer than the relay's interval — it must find nothing
  t('outbox.refusedMoveRecordsNothing', {
    status:         refused.status,
    newAnnouncements: (await announcementsFor()).length - beforeRefused,
  })

  // ── 6. a commitment, run rather than waited for ────────────────────────
  //
  // `@@commitment(abandon, on: createdAt + 14d)` on Order is the schedule, and
  // junction's `commitments()` is the clock under it. Two orders are placed and
  // ONE is aged fifteen days by hand, then a sweep is run: the aged order is
  // abandoned and its twin, placed the same minute, is not. Planting both is
  // what isolates the rule, for the reason section 7 plants two audit lines.
  //
  // Aged in the shop's own file rather than through the API: `createdAt` is in
  // no mode junction writes, so no request can backdate a row, and fourteen
  // days is not a test. The API holds the file in WAL, so this is a second
  // writer and not a stale copy.
  //
  // References are minted per run. Order soft-deletes and a deleted row keeps
  // its `@unique` values, so a fixed pair would be single-use (`FJS-530`).
  // The cron sweeps every minute on its own, so the aged row can be abandoned
  // before the run below — the assertion is on where the rows END, not on
  // which sweep moved them.
  const mint  = Date.now().toString(36).toUpperCase()
  const place = async (reference) => {
    const res = await fetch(`${API}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ reference, total: 500, status: 'pending', customerId: 1 }),
    })
    const row = await res.json()
    return row.id ?? row.data?.id
  }
  const agedId  = await place(`ABN-OLD-${mint}`)
  const freshId = await place(`ABN-NEW-${mint}`)
  abandonIds.push(agedId, freshId)

  const shop = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
  shop.prepare('UPDATE "order" SET createdAt = ? WHERE id = ?')
    .run(new Date(Date.now() - 15 * 86_400_000).toISOString(), agedId)
  shop.close()

  const run = await fetch(`${API}/api/jobs/run/commitment-sweep`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const { id: sweepId } = await run.json()
  const sweepJob = await until(async () => {
    const j = await (await fetch(`${API}/api/jobs/${sweepId}`)).json()
    return j.status === 'done' || j.status === 'failed' ? j : null
  })
  t('commitment.sweepRan', { accepted: run.status, finished: sweepJob ? sweepJob.status : null })

  const statusOf = async (id) => (await (await fetch(`${API}/api/orders/${id}`, { headers: auth })).json()).status
  await until(async () => (await statusOf(agedId)) === 'cancelled')
  t('commitment.abandonsOnlyTheDue', {
    aged:  await statusOf(agedId),
    // Placed the same minute, so a sweep reading the wrong column or the
    // wrong clock moves both.
    fresh: await statusOf(freshId),
  })

  // The trail's row for the abandon. Its before and after are the row a
  // person's cancel writes, so the move's name is the only thing in the trail
  // that says a commitment did it (`FJS-1294`). The write is fire-and-forget,
  // so it is polled for rather than read once.
  const abandonRow = await until(() => {
    if (!existsSync(AUDIT)) return null
    return readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .find(r => r.operation === 'update' && r.field == null
        && [].concat(typeof r.records === 'string' ? JSON.parse(r.records) : r.records).includes(agedId)
        && (typeof r.after === 'string' ? JSON.parse(r.after) : r.after)?.status === 'cancelled') ?? null
  })
  t('commitment.trailNamesTheMove', {
    transition: abandonRow ? abandonRow.transition ?? null : 'no audit row',
  })

  // ── 6b. dunning — a commitment on a RELATED model ──────────────────────
  //
  // `@@commitment(subscription.lapse, on: dueOn + graceDays, …)` on Invoice:
  // the invoice owns the deadline and the subscription owns the move
  // (`FJS-D362`). Three subscriptions, planted in the shop's file because an
  // invoice is created by the system alone and a due date cannot be backdated
  // through any request:
  //
  //   lapsing    two unpaid invoices, both past their grace — the older fires
  //              the lapse and the newer must answer NOTHING DUE, not a failed
  //              fire, which is the half of the ruling that is easy to lose
  //   cancelled  one invoice past its dunning deadline
  //   control    one invoice still inside its grace, planted the same minute
  //
  // Then the way back (`FJS-D363`), over HTTP as staff: settling one of the
  // two leaves the subscription `pastDue`, and voiding the other brings it
  // back — with no job run, on the CALLER's client, which is the condition
  // the ruling carries: a staff member's payment must not fail on the
  // subscription it clears.
  //
  // Due dates are days either side of every boundary, so the shop's zone
  // cannot move a row across one.
  // Stamped BEFORE the rows exist: the minute cron may sweep them before the
  // run below does, and its fires are this run's too.
  const sweptAt = Date.now()
  const shop2 = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
  const base  = shop2.prepare('SELECT customerId, planVersionId, userId FROM subscription ORDER BY id LIMIT 1').get()
  const day   = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const plantSub = (suffix) => Number(shop2.prepare(
    `INSERT INTO subscription (reference, customerId, planVersionId, status, userId)
     VALUES (?, ?, ?, 'active', ?)`)
    .run(`DUN-${suffix}-${mint}`, base.customerId, base.planVersionId, base.userId).lastInsertRowid)
  const plantInvoice = (suffix, subscriptionId, dueOn) => Number(shop2.prepare(
    `INSERT INTO invoice (number, status, customerId, subscriptionId, subtotal, tax, total,
                          periodStart, periodEnd, dueOn, graceDays, dunningDays, userId)
     VALUES (?, 'issued', ?, ?, 1000, 0, 1000, ?, ?, ?, 3, 21, ?)`)
    .run(`DUN-${suffix}-${mint}`, base.customerId, subscriptionId, day(-40), day(-10), dueOn, base.userId).lastInsertRowid)

  const lapsingId  = plantSub('L')
  const cancelId   = plantSub('C')
  const controlId  = plantSub('K')
  dunning.subs.push(lapsingId, cancelId, controlId)
  const olderId    = plantInvoice('L1', lapsingId, day(-6))
  const newerId    = plantInvoice('L2', lapsingId, day(-5))
  dunning.invoices.push(olderId, newerId,
    plantInvoice('C1', cancelId,  day(-25)),
    plantInvoice('K1', controlId, day(-1)))
  shop2.close()

  const dunRun  = await fetch(`${API}/api/jobs/run/commitment-sweep`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const { id: dunSweepId } = await dunRun.json()
  await until(async () => {
    const j = await (await fetch(`${API}/api/jobs/${dunSweepId}`)).json()
    return j.status === 'done' || j.status === 'failed'
  })

  const subStatus = async (id) =>
    (await (await fetch(`${API}/api/subscriptions/${id}`, { headers: auth })).json()).status
  // Every fire this run dispatched for one of its own invoices. Row ids are
  // reused across runs (a reset reseeds from 1), so the window is the sweep.
  const firesFor = async () =>
    (await (await fetch(`${API}/api/jobs?limit=500&data=1`)).json())
      .filter(j => {
        if (j.name !== 'commitment-fire' || j.created_at < sweptAt - 1_000) return false
        try {
          const d = JSON.parse(j.data)
          // Every planted invoice is past its reminder too; 6d grades those.
          return d.accessor === 'invoice' && d.transition !== 'remind' && dunning.invoices.includes(d.id)
        } catch { return false }
      })
  await until(async () => {
    const f = await firesFor()
    return f.length >= 4 && f.every(j => j.status === 'done' || j.status === 'failed')
  })
  const fired = await firesFor()
  const newerFires = fired.filter(j => JSON.parse(j.data).id === newerId)
  t('dunning.commitmentMovesTheSubscription', {
    lapsing:   await subStatus(lapsingId),
    cancelled: await subStatus(cancelId),
    control:   await subStatus(controlId),
    // Two lapse fires for one subscription, and a cancel and a lapse for
    // another: every one done, none failed. A later invoice meeting a move
    // already made is nothing due, never a refused transition.
    firesDone:   fired.length > 0 && fired.every(j => j.status === 'done'),
    newerFired:  newerFires.length === 1,
  })

  const move = (id, method) => fetch(`${API}/api/invoices/${id}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': method }, body: '{}',
  })
  const settled     = await move(olderId, 'settle')
  const afterSettle = await subStatus(lapsingId)
  const voided      = await move(newerId, 'void')
  t('dunning.staffClearsTheLedger', {
    settle: settled.status, afterSettle,
    void:   voided.status,  afterVoid: await subStatus(lapsingId),
  })

  // ── 6c. renewal — a PERIOD closing ─────────────────────────────────────
  //
  // `@@commitment(close, on: endsOn)` on SubscriptionPeriod (`FJS-D367`), and
  // the hook `commitments()` runs in the close's own transaction (`FJS-D368`):
  // the next period and its invoice. A subscription is planted with one period
  // that ended yesterday, a sweep is run, and the renewal is read back over
  // HTTP — `currentPeriodEnd` is `@from` the periods, so the API answering the
  // new end is the derived window reaching a caller. A second sweep issues
  // nothing: the closed period owes nothing and the new one is not yet due.
  {
    const shop3 = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
    const renewId = Number(shop3.prepare(
      `INSERT INTO subscription (reference, customerId, planVersionId, status, userId) VALUES (?, ?, ?, 'active', ?)`)
      .run(`REN-${mint}`, base.customerId, base.planVersionId, base.userId).lastInsertRowid)
    dunning.subs.push(renewId)
    const periodId = Number(shop3.prepare(
      `INSERT INTO subscription_period (subscriptionId, startsOn, endsOn, status, userId) VALUES (?, ?, ?, 'open', ?)`)
      .run(renewId, day(-31), day(-1), base.userId).lastInsertRowid)
    shop3.close()

    const renewedAt = Date.now()
    const sweep = async () => {
      const r = await fetch(`${API}/api/jobs/run/commitment-sweep`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const { id } = await r.json()
      await until(async () => ['done', 'failed'].includes((await (await fetch(`${API}/api/jobs/${id}`)).json()).status))
    }
    const periodFires = async () =>
      (await (await fetch(`${API}/api/jobs?limit=500&data=1`)).json())
        .filter(j => {
          if (j.name !== 'commitment-fire' || j.created_at < renewedAt - 1_000) return false
          try { const d = JSON.parse(j.data); return d.accessor === 'subscriptionPeriod' && d.id === periodId }
          catch { return false }
        })
    await sweep()
    await until(async () => (await periodFires()).some(j => j.status === 'done' || j.status === 'failed'))

    const read = () => {
      const db3 = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
      const periods  = db3.prepare('SELECT status, startsOn FROM subscription_period WHERE subscriptionId = ? ORDER BY startsOn').all(renewId)
      const invoices = db3.prepare('SELECT id, status, periodStart FROM invoice WHERE subscriptionId = ?').all(renewId)
      db3.close()
      return { periods, invoices }
    }
    const once = read()
    dunning.invoices.push(...once.invoices.map(i => i.id))
    const sub = await (await fetch(`${API}/api/subscriptions/${renewId}`, { headers: auth })).json()
    t('renewal.periodCloses', {
      fire:     (await periodFires()).map(j => j.status).join(','),
      periods:  once.periods.map(p => p.status).join(','),
      next:     once.periods[1]?.startsOn === day(-1),
      invoices: once.invoices.length,
      billsTheNextPeriod: once.invoices[0]?.periodStart === day(-1),
      windowOverHttp:     sub.currentPeriodStart === day(-1) && sub.currentPeriodEnd > day(-1),
    })

    await sweep()
    await sleep(500)
    const twice = read()
    dunning.invoices.push(...twice.invoices.map(i => i.id).filter(id => !dunning.invoices.includes(id)))
    t('renewal.secondSweepBillsNothing', { periods: twice.periods.length, invoices: twice.invoices.length })
  }

  // ── 6d. a reminder — a Boolean move that sends an email ────────────────
  //
  // `@@commitment(remind, on: dueOn - 3d, while: status == 'issued')` on
  // Invoice, beside its status machine. The hook enqueues the email on the
  // move's own transaction and the outbox relay dispatches `invoice-remind`,
  // so what is asserted is the whole path: the column moved, the sink got the
  // mail, and a second sweep sends nothing. A paid invoice past the same date
  // and an issued one not yet inside the three days are the two controls.
  {
    const SINK  = process.env.MAIL_SINK_URL ?? 'http://localhost:8111'
    const shop4 = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
    const plant = (suffix, status, dueOn) => Number(shop4.prepare(
      `INSERT INTO invoice (number, status, customerId, subtotal, tax, total,
                            periodStart, periodEnd, dueOn, graceDays, dunningDays, userId)
       VALUES (?, ?, ?, 1000, 0, 1000, ?, ?, ?, 3, 21, ?)`)
      .run(`REM-${suffix}-${mint}`, status, base.customerId, day(-30), day(0), dueOn, base.userId).lastInsertRowid)
    const dueId   = plant('D', 'issued', day(2))
    const paidId  = plant('P', 'paid',   day(2))
    const aheadId = plant('A', 'issued', day(10))
    dunning.invoices.push(dueId, paidId, aheadId)
    shop4.close()

    const sweep = async () => {
      const r = await fetch(`${API}/api/jobs/run/commitment-sweep`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const { id } = await r.json()
      await until(async () => ['done', 'failed'].includes((await (await fetch(`${API}/api/jobs/${id}`)).json()).status))
    }
    const mails = async () => ((await (await fetch(`${SINK}/outbox`)).json().catch(() => [])) ?? [])
      .filter(m => String(m.subject ?? '').includes(`-${mint}`) && String(m.subject).startsWith('Invoice REM-'))
    const reminded = () => {
      const db4 = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
      const rows = db4.prepare(`SELECT id, reminded FROM invoice WHERE id IN (?, ?, ?)`).all(dueId, paidId, aheadId)
      db4.close()
      return Object.fromEntries(rows.map(r => [r.id, r.reminded === 1]))
    }

    await sweep()
    await until(async () => (await mails()).length >= 1)
    const once = reminded()
    const sent = await mails()
    t('reminder.sentWithTheMove', {
      due:    once[dueId],
      paid:   once[paidId],
      ahead:  once[aheadId],
      mails:  sent.length,
      toThem: sent[0]?.subject === `Invoice REM-D-${mint} is due on ${day(2)}`,
    })

    await sweep()
    await sleep(1_500)
    t('reminder.secondSweepSendsNothing', { mails: (await mails()).length })
  }

  // ── 7. the OTHER cron, and the one the schema declares ─────────────────
  //
  // `database audit { … retention 90d }` is a policy in the seed, and until a
  // job existed it was true for exactly one moment per boot: litestone sweeps
  // once inside `createClient`, so a shop whose API stays up for a month pruned
  // on the day it started and never again (`FJS-521`). The declaration is
  // litestone's and the CLOCK is the app's, because unattended recurring work
  // belongs to the queue (`FJS-D36`) and litestone may not import it.
  //
  // Asserting the schedule is registered is what section 1 does and it is not
  // this: a handler that runs on time and sweeps nothing is the same silence
  // the whole feature exists to break. So this plants two rows one line apart —
  // one older than the window, one written now — and asks whether the pass can
  // tell them apart. Planting BOTH is what isolates the rule: a sweep that
  // truncated the file would pass a test that only looked for the old row's
  // absence.
  //
  // Written to the file directly rather than through the logger, because there
  // is no way to ask the logger for a row with last spring's date on it.
  //
  // The old row goes at the FRONT and that is not cosmetic. `compactJsonl` has a
  // cheap pre-check — an append-only log is oldest-first, so if the FIRST line
  // is inside the window every line is, and the pass returns without reading the
  // file. It is the right optimization (this runs on every boot, over a file
  // that grows for the life of the deployment) and it means a probe appending an
  // old line to the end measures the pre-check rather than the sweep: the job
  // reports `done`, removes nothing, and looks broken. A log that has genuinely
  // aged has its old rows at the top, which is what this reproduces.
  //
  // The companion index maps ids to byte offsets, so this rewrite invalidates
  // it — and it is deliberately LEFT ALONE. Compaction reads the file rather
  // than the index and calls `rebuildIndex` when it is done, so the stale
  // offsets are repaired by the very pass this is testing.
  //
  // Deleting it is what this used to do, and it is the one thing `FJS-D180`
  // says never to do: the sidecar is in WAL, the API process holds it open, and
  // an unlink leaves `-wal`/`-shm` behind while that process goes on writing
  // into an inode with no directory entry — answering ok the whole time. The
  // state it leaves is visible on disk as a 4 KB index beside a 240 KB `-wal`.
  const MARK   = `retention-probe-${Date.now().toString(36)}`
  const stamp  = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  const line   = (age) => JSON.stringify({
    operation: 'create', model: MARK, field: null, records: '[0]',
    before: null, after: null, actorId: null, actorType: null, meta: null,
    createdAt: stamp(age),
  })

  if (!existsSync(AUDIT)) throw new Error(`no audit log at ${AUDIT} — has anything been written?`)
  // 200 days is comfortably past the declared 90 and comfortably short of a
  // clock-skew argument. The fresh one carries today's date and the same marker.
  const trail = readFileSync(AUDIT, 'utf8')
  writeFileSync(AUDIT, line(200) + '\n' + trail.replace(/\n?$/, '\n') + line(0) + '\n')

  const planted = readFileSync(AUDIT, 'utf8')
  t('retention.planted', {
    old:   planted.includes(`"createdAt":"${stamp(200).slice(0, 10)}`),
    fresh: planted.split('\n').filter(l => l.includes(MARK)).length,
  })

  const retainRun = await fetch(`${API}/api/jobs/run/retention`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const { id: retainId } = await retainRun.json()
  const retainJob = await until(async () => {
    const j = await (await fetch(`${API}/api/jobs/${retainId}`)).json()
    return j.status === 'done' || j.status === 'failed' ? j : null
  })

  const swept = readFileSync(AUDIT, 'utf8').split('\n').filter(l => l.includes(MARK))
  t('retention.sweptTheOldOne', {
    accepted: retainRun.status,
    finished: retainJob ? retainJob.status : null,
    // One line left carrying the marker, and it is the fresh one. Two would mean
    // the pass ran and did nothing; zero would mean it took the wrong rows.
    left:     swept.length,
    leftIsFresh: swept.length === 1 && swept[0].includes(`"createdAt":"${stamp(0).slice(0, 10)}`),
    // The rest of the trail is still there. A retention pass that emptied the
    // file would satisfy every assertion above it.
    othersKept: readFileSync(AUDIT, 'utf8').split('\n').filter(l => l.trim() && !l.includes(MARK)).length > 0,
  })

} catch (e) {
  console.error('\nThe drive threw:', e.message)
  console.error('collected so far:', got)
  process.exitCode = 1
} finally {
  if (orderId && auth)
    await fetch(`${API}/api/orders/${orderId}`, { method: 'DELETE', headers: auth }).catch(() => {})
  for (const id of abandonIds.filter(Boolean))
    await fetch(`${API}/api/orders/${id}`, { method: 'DELETE', headers: auth }).catch(() => {})
  if (dunning.subs.length) {
    const shop = new DatabaseSync(`db/shops/${process.env.SHOP ?? 'flagship'}.db`)
    const list = (ids) => ids.map(Number).join(',')
    if (dunning.invoices.length) {
      shop.exec(`DELETE FROM invoice_line WHERE invoiceId IN (${list(dunning.invoices)})`)
      shop.exec(`DELETE FROM payment WHERE invoiceId IN (${list(dunning.invoices)})`)
      shop.exec(`DELETE FROM invoice WHERE id IN (${list(dunning.invoices)})`)
    }
    shop.exec(`DELETE FROM subscription_period WHERE subscriptionId IN (${list(dunning.subs)})`)
    shop.exec(`DELETE FROM subscription WHERE id IN (${list(dunning.subs)})`)
    shop.close()
  }
}

if (process.exitCode) process.exit(1)

// ─── the report ───────────────────────────────────────────────────────────

const expected = {
  'admin.list': { status: 200, isArray: true },
  'cron.registered': {
    // Every schedule, by name. A subscription renews and an unpaid one is
    // chased by `commitment-sweep`, which is junction's, as `orion.sweep` is
    // orion's — each installed with its plugin. Here for one reason: a
    // schedule that stops being registered is nothing happening.
    names: ['commitment-sweep', 'holds-release', 'orion.sweep', 'retention'],
    commit: '* * * * *',
    holds:  '*/5 * * * *',
    retain: '0 4 * * *',
    hasNextRun: true,
  },

  'ship.answersImmediately': { status: 'shipped', trackingCode: null },
  // Deterministic from the reference, so this is a value and not just "truthy" —
  // a job that wrote the wrong code would still pass a null check.
  'job.wroteTracking': { arrived: true, trackingCode: 'TRK-1A12', stillShipped: 'shipped' },
  'job.record': {
    name: 'courier-book', queue: 'fulfillment', status: 'done', attempts: 1,
    maxAttempts: 5, retryDelay: '[60000,300000,1800000]',
  },
  'retention.planted':      { old: true, fresh: 2 },
  'retention.sweptTheOldOne': {
    accepted: 200, finished: 'done', left: 1, leftIsFresh: true, othersKept: true,
  },

  // Shipping a shipped order is a `TransitionConflictError` — 409, not the 200
  // this asserted for most of its life. `FJS-611` is the change: a move asked
  // for BY NAME is not an update that happens to carry the column, so arriving
  // at the state the row already holds means the move did not happen HERE, and
  // the early return that used to call it a no-op was also skipping the gate,
  // the capability and `@system`.
  //
  // What that costs this assertion is worth saying rather than leaving to be
  // rediscovered: `newBookings: 0` is now guaranteed by the TRANSITION, which
  // refuses before anything is dispatched, and no longer by caravan's `unique`.
  // The end-to-end crossing it used to prove is not reachable through a named
  // move any more. Caravan's own suite holds the dedupe — four cases in
  // `packages/caravan/test/caravan.test.ts`, including a second dispatch while
  // the first is still queued — so nothing is uncovered; it is covered one
  // layer down instead of two layers up.
  'ship.twice': { status: 409, newBookings: 0 },

  // One announcement for one payment, queued under the outbox row's own id.
  'outbox.announcementQueued': { count: 1, idIsRowId: true, uniqueKey: null },
  // A move the state machine refuses leaves no intent behind — the outbox row
  // is written inside the transaction, so it rolls back with everything else.
  'outbox.refusedMoveRecordsNothing': { status: 409, newAnnouncements: 0 },
  'commitment.sweepRan':        { accepted: 200, finished: 'done' },
  'commitment.abandonsOnlyTheDue': { aged: 'cancelled', fresh: 'pending' },
  'commitment.trailNamesTheMove':  { transition: 'abandon' },
  'dunning.commitmentMovesTheSubscription': {
    lapsing: 'pastDue', cancelled: 'cancelled', control: 'active', firesDone: true, newerFired: true,
  },
  // One of two paid is still behind; the void clears it (`FJS-D363`).
  'dunning.staffClearsTheLedger': { settle: 200, afterSettle: 'pastDue', void: 200, afterVoid: 'active' },
  'renewal.periodCloses': {
    fire: 'done', periods: 'closed,open', next: true, invoices: 1, billsTheNextPeriod: true, windowOverHttp: true,
  },
  'renewal.secondSweepBillsNothing': { periods: 2, invoices: 1 },
  'reminder.sentWithTheMove':        { due: true, paid: false, ahead: false, mails: 1, toThem: true },
  'reminder.secondSweepSendsNothing': { mails: 1 },
}

const failed = report(got, expected)
process.exit(failed)
