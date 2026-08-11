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

const API = process.env.API_URL ?? 'http://localhost:8110'
const REF = 'ORD-JOBS-1'

try {
  const r = await fetch(`${API}/health`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`Cannot reach api (bun run api) at ${API} — ${e.message}`)
  process.exit(1)
}

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
  const login = await fetch(`${API}/auth/login`, {
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
  // the next one fail for a reason that has nothing to do with jobs.
  const stale = await (await fetch(`${API}/api/orders?reference=${REF}`)).json()
  for (const row of stale.data ?? [])
    await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })

  // ── 1. the queue is mounted and declares what it runs ──────────────────
  //
  // Caravan's admin routes are RAW app.get routes, so `apiPrefix: '/api'` does
  // NOT apply to them — /jobs, not /api/jobs (FJS-012). Worth asserting: the
  // path is the thing most likely to be wrong after a config change, and a 404
  // here is indistinguishable from "no jobs" if you only look at the body.
  const listRes = await fetch(`${API}/jobs`)
  t('admin.list', { status: listRes.status, isArray: Array.isArray(await listRes.json()) })

  const schedules = await (await fetch(`${API}/jobs/schedules`)).json()
  t('cron.registered', {
    names: schedules.map(s => s.name),
    cron:  schedules.find(s => s.name === 'sweep-abandoned')?.cron ?? null,
    // A cron with no next fire time is a parse failure that reports as silence.
    hasNextRun: !!schedules.find(s => s.name === 'sweep-abandoned')?.nextRun,
  })

  // ── 2. ship answers WITHOUT waiting for the courier ────────────────────
  const created = await fetch(`${API}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ reference: REF, total: 12, status: 'pending', customerId: 1 }),
  })
  const body = await created.json()
  orderId = body.id ?? body.data?.id

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
    const o = await (await fetch(`${API}/api/orders/${orderId}`)).json()
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
    const jobs = await (await fetch(`${API}/jobs?limit=500`)).json()
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
  // `unique` is keyed to the order. Shipping a shipped order is a NO-OP at the
  // Data boundary — the row is already at the target state, so unlike `cancel`
  // from `shipped` it does not 409 — and the action therefore reaches its
  // dispatch a second time. A duplicate booking is a real parcel, so the queue
  // has to be the thing that refuses, and that is worth asserting rather than
  // assuming: it used to answer `500 UNIQUE constraint failed: jobs.unique_key`.
  // Counted as a DELTA, not as a total. jobs.db outlives db/shop.db across runs
  // and SQLite reuses row ids, so `book-courier:5` names this run's order and
  // also whichever order held id 5 last time — an absolute count reports the
  // previous run's booking as a duplicate of this one's.
  const bookingsFor = async () =>
    (await (await fetch(`${API}/jobs?limit=500`)).json())
      .filter(j => j.unique_key === `book-courier:${orderId}`).length
  const bookingsBefore = await bookingsFor()

  const second = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'ship' }, body: '{}',
  })
  t('ship.twice', {
    status: second.status,
    newBookings: (await bookingsFor()) - bookingsBefore,
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
  const before = await (await fetch(`${API}/api/orders`)).json()
  const pendingBefore = before.data.filter(o => o.status === 'pending').map(o => o.reference)

  const run = await fetch(`${API}/jobs/run/sweep-abandoned`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days: 0 }),
  })
  const { id: sweepId } = await run.json()
  const sweepJob = await until(async () => {
    const j = await (await fetch(`${API}/jobs/${sweepId}`)).json()
    return j.status === 'done' || j.status === 'failed' ? j : null
  })

  const after = await (await fetch(`${API}/api/orders`)).json()
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
  'cron.registered': { names: ['sweep-abandoned'], cron: '0 3 * * *', hasNextRun: true },

  'ship.answersImmediately': { status: 'shipped', trackingCode: null },
  // Deterministic from the reference, so this is a value and not just "truthy" —
  // a job that wrote the wrong code would still pass a null check.
  'job.wroteTracking': { arrived: true, trackingCode: 'TRK-1A12', stillShipped: 'shipped' },
  'job.record': {
    name: 'book-courier', queue: 'fulfilment', status: 'done', attempts: 1,
    maxAttempts: 5, retryDelay: '[60000,300000,1800000]',
  },
  // Shipping a shipped order is a no-op at the Data boundary (the row is
  // already at the target state), so the SECOND ship answers 200 and the only
  // thing that must not happen twice is the courier booking. `unique` is what
  // stops it — and it 500'd with `UNIQUE constraint failed: jobs.unique_key`
  // until caravan's dedupe was fixed to match a key in any state, not only a
  // pending one.
  'ship.twice': { status: 200, newBookings: 0 },
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
  `means). \`bun run reset\` or a restart re-seeds them.`)
process.exit(failed ? 1 : 0)
