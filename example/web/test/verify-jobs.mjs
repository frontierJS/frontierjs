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

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { requireServers } from './lib/preflight.mjs'

const API = process.env.API_URL ?? 'http://localhost:8110'
const REF = 'ORD-JOBS-1'
// The audit database is `driver logger` with `retention 90d`, so its rows are
// lines in a file rather than a table. Relative to the app root, which is where
// `bun run verify:jobs` is invoked from — the same resolution the declaration
// gets, and the reason `FJS-449` is a hazard worth knowing about here.
const AUDIT = 'db/audit/auditLogs.jsonl'

await requireServers([['api (bun run api)', `${API}/api/health`]])

const got = {}
const t = (label, value) => { got[label] = value }

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
    cron:  cronOf('sweep-abandoned'),
    holds: cronOf('release-holds'),
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
        if (j.name !== 'announce-payment') return false
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
    return jobs.find(j => j.unique_key === `book-courier:${orderId}` && j.status === 'done') ?? null
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
  // and SQLite reuses row ids, so `book-courier:5` names this run's order and
  // also whichever order held id 5 last time — an absolute count reports the
  // previous run's booking as a duplicate of this one's.
  const bookingsFor = async () =>
    (await (await fetch(`${API}/api/jobs?limit=500`)).json())
      .filter(j => j.unique_key === `book-courier:${orderId}`).length
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

  // ── 6. the cron's BEHAVIOUR, not just its schedule ─────────────────────
  //
  // `nextRuns()` proves a schedule was registered, which is not the same as the
  // handler being right — and waiting until 03:00 is not a test. `POST
  // /jobs/run/{name}` runs a registered job now, and the body becomes its data,
  // so the sweep gets a zero-day horizon: every pending order is abandoned by
  // that definition, and it should cancel exactly those and touch nothing else.
  //
  // The run route did not exist before 2026-08-06 — Caravan could retry and
  // cancel a job but not start one, which made every cron handler in every app
  // unreachable from a test. Added while writing this drive.
  const before = await (await fetch(`${API}/api/orders`, { headers: auth })).json()
  const pendingBefore = before.data.filter(o => o.status === 'pending').map(o => o.reference)

  const run = await fetch(`${API}/api/jobs/run/sweep-abandoned`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days: 0 }),
  })
  const { id: sweepId } = await run.json()
  const sweepJob = await until(async () => {
    const j = await (await fetch(`${API}/api/jobs/${sweepId}`)).json()
    return j.status === 'done' || j.status === 'failed' ? j : null
  })

  const after = await (await fetch(`${API}/api/orders`, { headers: auth })).json()
  t('sweep.ranOnDemand', { accepted: run.status, finished: sweepJob ? sweepJob.status : null })

  // Put the shop back. A 0-day sweep cancels every pending order, including the
  // seeded ones the other three drives assert on — and `cancelled` is terminal,
  // so there is no move back. Re-create them from the snapshot taken above:
  // same reference, same total, same customer, pending again. Without this the
  // next `bun run verify` fails on rows this file moved, which is exactly the
  // shape of FJS-080 and reads as a regression in whatever you changed last.
  for (const was of before.data) {
    if (was.status !== 'pending' || was.reference === REF) continue
    const now = after.data.find(o => o.reference === was.reference)
    if (!now || now.status !== 'cancelled') continue
    await fetch(`${API}/api/orders/${now.id}`, { method: 'DELETE', headers: auth })
    await fetch(`${API}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        reference: was.reference, total: was.total, note: was.note,
        status: 'pending', customerId: was.customerId,
      }),
    })
  }
  t('sweep.cancelsAbandoned', {
    wasPending:  [...pendingBefore].sort(),
    // Every one of them is now cancelled…
    nowCancelled: after.data
      .filter(o => pendingBefore.includes(o.reference) && o.status === 'cancelled')
      .map(o => o.reference).sort(),
    leftPending: after.data.filter(o => o.status === 'pending').length,
    // …and nothing else moved. A sweep that cancels a paid order is a refund
    // nobody asked for.
    othersUntouched: after.data
      .filter(o => !pendingBefore.includes(o.reference))
      .every(o => o.status === before.data.find(b => b.reference === o.reference).status),
  })
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
  // file. It is the right optimisation (this runs on every boot, over a file
  // that grows for the life of the deployment) and it means a probe appending an
  // old line to the end measures the pre-check rather than the sweep: the job
  // reports `done`, removes nothing, and looks broken. A log that has genuinely
  // aged has its old rows at the top, which is what this reproduces.
  //
  // The companion index maps ids to byte offsets, so a rewrite invalidates it —
  // removed here for the same reason the compaction removes its own, and
  // rebuilt lazily on the next write.
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
  try { rmSync(AUDIT + '.index.db') } catch { /* absent is fine — it is rebuilt lazily */ }

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
}

if (process.exitCode) process.exit(1)

// ─── the report ───────────────────────────────────────────────────────────

// The sweep runs against whatever is pending when the drive starts, and
// `bun run verify` leaves a different set behind than a fresh seed does — so
// the assertion is that the sweep cancelled EXACTLY what was pending, not a
// fixed list. Everything else is a fixed value.
const expected = {
  'admin.list': { status: 200, isArray: true },
  'cron.registered': {
    // Every schedule, by name. Two of these are billing's — a subscription
    // renews on a clock and an unpaid one is chased on another — and they
    // are here for the same reason as the other three: a schedule that
    // stops being registered is nothing happening.
    names: ['dun-subscriptions', 'release-holds', 'renew-subscriptions',
            'retention', 'sweep-abandoned'],
    cron:  '0 3 * * *',
    holds: '*/5 * * * *',
    // 04:00, after the 03:00 sweep: a run that cancels an order has already
    // happened, so the audit rows being aged are that run's and not ones
    // written a minute later.
    retain: '0 4 * * *',
    hasNextRun: true,
  },

  'ship.answersImmediately': { status: 'shipped', trackingCode: null },
  // Deterministic from the reference, so this is a value and not just "truthy" —
  // a job that wrote the wrong code would still pass a null check.
  'job.wroteTracking': { arrived: true, trackingCode: 'TRK-1A12', stillShipped: 'shipped' },
  'job.record': {
    name: 'book-courier', queue: 'fulfilment', status: 'done', attempts: 1,
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
  // `packages/caravan/tests/caravan.test.ts`, including a second dispatch while
  // the first is still queued — so nothing is uncovered; it is covered one
  // layer down instead of two layers up.
  'ship.twice': { status: 409, newBookings: 0 },

  // One announcement for one payment, queued under the outbox row's own id.
  'outbox.announcementQueued': { count: 1, idIsRowId: true, uniqueKey: null },
  // A move the state machine refuses leaves no intent behind — the outbox row
  // is written inside the transaction, so it rolls back with everything else.
  'outbox.refusedMoveRecordsNothing': { status: 409, newAnnouncements: 0 },
  'sweep.ranOnDemand': { accepted: 200, finished: 'done' },
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const have = got[key]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}

// The sweep, compared against what it found rather than a constant.
const sweep = got['sweep.cancelsAbandoned']
const sweepOk = sweep
  && JSON.stringify(sweep.nowCancelled) === JSON.stringify(sweep.wasPending)
  && sweep.leftPending === 0
  && sweep.othersUntouched === true
if (!sweepOk) failed++
console.log(`${sweepOk ? '  ok  ' : '  FAIL'} sweep.cancelsAbandoned`)
if (!sweepOk) console.log(`         have ${JSON.stringify(sweep)}`)

const total = Object.keys(expected).length + 1
console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${total} assertions passed`)
if (!failed) console.log(
  `\nNote: this drive cancels every pending order (that is what a 0-day sweep\n` +
  `means). \`bun run reset\` re-seeds them — a restart no longer does.`)
process.exit(failed ? 1 : 0)
