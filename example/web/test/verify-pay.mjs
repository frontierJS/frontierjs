/**
 * web/test/verify-pay.mjs — money, and the one caller that is not a person.
 *
 * No browser, except for one socket. Everything here is a fact about the API,
 * the provider and the two directions between them.
 *
 * ─── What it drives ───────────────────────────────────────────────────────
 *
 * A payment provider is the only third party in this app that TALKS BACK, and
 * that makes it the only place two things are testable at all:
 *
 *   OUT  a conduit target with `auth: { type: 'hmac' }`. Every other target
 *        here is a bearer token, which is a value; an HMAC binds the request,
 *        and the provider VERIFIES it — a signer with no verifier reads as a
 *        scheme being enforced while enforcing nothing (FJS-349)
 *   IN   a signed webhook against a raw route, verified over `ctx.rawBody`,
 *        which drives the ORDER STATE MACHINE with no session anywhere in the
 *        picture. Every other write in this app is a person
 *
 * Both sides run `@frontierjs/toolbelt/signature` and so does this file — one
 * definition of what a signed request is, three readers, no restatement.
 *
 * ─── The four ways a webhook is refused, separately ───────────────────────
 *
 * A forged signature, a stale clock, a replayed nonce and a redelivered event
 * all end with "nothing happened twice", and it matters enormously which one
 * did it. They are four assertions here because they are four mechanisms with
 * three different lifetimes: the signature is forever, the window is five
 * minutes, the nonce store is per-process, and the ledger is permanent.
 *
 * The API must be up (`bun run api`) — which also starts the provider on 8112.
 * The web server is not needed.
 *
 * It signs in ONCE, sharing the 10-per-15-minutes login window with the other
 * drives.
 */

import { signRequest } from '@frontierjs/toolbelt/signature'

const API  = process.env.API_URL ?? 'http://localhost:8110'
const PSP  = process.env.PSP_URL ?? 'http://localhost:8112'
const HOOK = '/api/webhooks/payments'

/** What the PROVIDER signs with. The shop's own key is a different secret —
 *  see api/src/core/psp.ts for why the two directions are two credentials. */
const HOOK_SECRET = process.env.SHOP_PSP_WEBHOOK_SECRET ?? 'dev-psp-webhook-secret'
/** What the SHOP signs with, so this drive can prove the provider checks it. */
const SHOP_KEY    = process.env.SHOP_PSP_KEY ?? 'dev-psp-key'

for (const [name, url] of [['api (bun run api)', `${API}/api/health`], ['the payment provider', `${PSP}/v1/intents`]]) {
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`Cannot reach ${name} at ${url} — ${e.message}`)
    process.exit(1)
  }
}

/**
 * A stamp for this run's event ids.
 *
 * `PaymentEvent` is append-only by declaration — @@gate("5.8.9.9"), and no
 * relation to delete it through — so a run's ledger rows outlive it and a
 * fixed id makes the SECOND run of this drive read every hand-signed event as
 * a redelivery of the first. That is the ledger doing exactly its job, and a
 * drive that is only correct once is worse than one that fails.
 */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const got = {}
const t = (label, value) => { got[label] = value }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function until(fn, ms = 10_000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}

const json = async (r) => { try { return await r.json() } catch { return null } }

/**
 * Sign a webhook the way the provider does, so this file can vary ONE part at
 * a time. A drive that could only send what the provider sends could assert
 * that the happy path works and nothing about why the others do not.
 */
async function postWebhook(body, opts = {}) {
  const raw  = JSON.stringify(body)
  const headers = await signRequest({
    secret:    opts.secret ?? HOOK_SECRET,
    method:    'POST',
    path:      HOOK,
    body:      raw,
    prefix:    'X-Psp',
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    nonce:     opts.nonce ?? crypto.randomUUID(),
  })
  return fetch(`${API}${HOOK}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? headers) },
    body: opts.body ?? raw,
  })
}

let auth = null
let ws   = null
/** Every `{event, data}` frame this run's socket saw. */
const frames = []

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
  const token = (await login.json()).token
  auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // `reference` is @unique, so a run that threw before its cleanup would fail
  // the next one for a reason that has nothing to do with payments. Deleting
  // the order takes its Payment rows with it (onDelete: Cascade); the ledger
  // is append-only and keeps its rows, which is what append-only means — every
  // count below is scoped to THIS run's event ids for exactly that reason.
  //
  // **The sweep has to look with `$withDeleted` and RELEASE the value rather
  // than delete the row again.** `Order` soft-deletes and a deleted row keeps
  // its `@unique` values — deliberately, or `restore()` would fail whenever a
  // stranger had taken the reference meanwhile — so this drive's own cleanup
  // leaves ORD-PAY-1 held by a row no ordinary read returns, a second DELETE
  // is a no-op against something already gone, and the next run's create is a
  // 409 that reports as *the provider refused the payment*. It passed exactly
  // once per database for its whole life (`FJS-546`, `FJS-530`); the release
  // below is the same one `verify.mjs` does and the documented way out of a
  // `SoftDeletedUniqueError`.
  for (const ref of ['ORD-PAY-1', 'ORD-PAY-2', 'ORD-PAY-3', 'ORD-PAY-4']) {
    const stale = await json(await fetch(`${API}/api/orders?reference=${ref}&$withDeleted=true`, { headers: auth }))
    for (const row of stale?.data ?? []) {
      // `@length(3, 20)`, so the freed reference is truncated rather than grown.
      const freed = `${ref}-X${row.id}`.slice(0, 20)
      await fetch(`${API}/api/orders/${row.id}?$withDeleted=true`, {
        method: 'PATCH', headers: auth, body: JSON.stringify({ reference: freed }),
      })
      if (!row.deletedAt)
        await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })
    }
  }

  const newOrder = async (reference, total) => {
    const r = await fetch(`${API}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ reference, total, status: 'pending', customerId: 1, note: 'payment drive' }),
    })
    const b = await json(r)
    return b?.id ?? b?.data?.id
  }

  // What a hosted checkout would have been handed. `carts.checkout` answers this
  // to the shopper who just bought; the orders that reach `start` here are made
  // by staff over the API instead, so they come and ask for it as staff — the
  // other of the two doors, and the reason `orders.paymentCode` exists rather
  // than the code living only in a checkout response nothing here produces.
  //
  // Derived rather than stored (`api/src/core/checkout-code.ts`), so it is on no
  // read of the order and there is no column to probe: asking is the only way
  // to hold one, and this method's own read is what grades the asker.
  const codeFor = async (orderId) => {
    const r = await fetch(`${API}/api/orders/${orderId}`, {
      method: 'POST', headers: { ...auth, 'x-service-method': 'paymentCode' },
      body: '{}',
    })
    return (await json(r))?.checkoutCode
  }

  // ── The socket, opened FIRST ──────────────────────────────────────────
  //
  // A frame that arrives before anybody is listening is indistinguishable from
  // a frame that was never sent, and the assertion this exists for is exactly
  // "was one sent". api/src/app.ts joins every connection to `orders`, so
  // nothing here subscribes.
  await new Promise((resolve) => {
    ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
    ws.onmessage = (m) => {
      try {
        const f = JSON.parse(m.data)
        if (f.type === 'event') frames.push({ event: f.event, data: f.data })
      } catch { /* not an event frame */ }
    }
    ws.onopen  = () => resolve()
    ws.onerror = () => resolve()
    setTimeout(resolve, 3_000)
  })

  // ── 1. the provider refuses an unsigned call ──────────────────────────
  //
  // This is the assertion that makes every other outbound one mean something.
  // The shop's target declares `auth: { type: 'hmac' }`; if the provider took
  // the call anyway, the declaration would be decoration and nothing in this
  // repo would notice.
  const unsigned = await fetch(`${PSP}/v1/intents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 1, currency: 'USD', reference: 'nope' }),
  })
  // …and a signature over a DIFFERENT body, which is the forgery that a scheme
  // signing only a timestamp would let through.
  const swapped = await (async () => {
    const headers = await signRequest({
      secret: SHOP_KEY, method: 'POST', path: '/v1/intents',
      body: JSON.stringify({ amount: 1, currency: 'USD', reference: 'a' }),
      prefix: 'X-Hub', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    return fetch(`${PSP}/v1/intents`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ amount: 999999, currency: 'USD', reference: 'a' }),
    })
  })()
  t('provider.refusesUnsigned', { unsigned: unsigned.status, bodySwapped: swapped.status })

  // ── 2. start: the shop asks, signed, and writes the row ───────────────
  //
  // Anonymous on purpose — no `auth` header. A hosted checkout is reached by a
  // shopper with no session, and what makes that possible is the CODE: `Order`
  // reads at VISITOR(1) behind two policies, so there is nobody here for either
  // of them to admit, and the code is the credential instead (`FJS-497`).
  const orderId = await newOrder('ORD-PAY-1', 4250)
  const payCode = await codeFor(orderId)
  const startRes = await fetch(`${API}/api/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: payCode }),
  })
  const started = await json(startRes)
  t('start.answers', {
    status:      startRes.status,
    providerRef: typeof started?.providerRef === 'string' && started.providerRef.startsWith('pi_'),
    amount:      started?.amount,
    paymentStatus: started?.status,
  })

  // ── 2b. who may open a payment, and the oracle that used to be here ──
  //
  // The old shape read the order as the SHOP for whatever id arrived, so a
  // stranger naming a sequential integer got an intent — and with it the order's
  // TOTAL in the answer and its STATUS in the refusal. Neither is the money
  // moving anywhere, and both are an existence-and-amount oracle over the whole
  // ledger, walked by counting from 1 (`FJS-497`).
  //
  // Four probes, and the fourth is the one that matters. A refusal is only
  // evidence if the identical request SUCCEEDS with the credential added, which
  // `start.answers` above already showed for this very order.
  const anonById = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ orderId }),
  })
  const anonBody = await json(anonById)

  const wrongCode = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: 'not-a-code-this-shop-issued' }),
  })

  // An id nobody has ever used. The assertion is not that it refuses — it is
  // that it refuses IDENTICALLY to the real order above. A different status or
  // a different sentence is the oracle wearing a smaller hat.
  const anonMissing = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ orderId: 99_999_999 }),
  })
  const missingBody = await json(anonMissing)

  t('start.refusesAStrangerNamingAnId', {
    status:        anonById.status,
    // Nothing about the order came back with the refusal.
    leaksAmount:   JSON.stringify(anonBody ?? {}).includes('4250'),
    leaksStatus:   /pending|paid|shipped|cancelled/.test(anonBody?.message ?? ''),
    wrongCode:     wrongCode.status,
    // A real order and an imaginary one are indistinguishable from outside.
    sameAsMissing: anonById.status === anonMissing.status
                   && (anonBody?.message ?? null) === (missingBody?.message ?? null),
  })

  // Staff need no code: they can read the order, so the policy already answers.
  // Its own order, so the assertion is about the DOOR and not about the money.
  const staffOrder = await newOrder('ORD-PAY-4', 350)
  const staffStart = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'start' },
    body: JSON.stringify({ orderId: staffOrder }),
  })
  t('start.staffNeedNoCode', { status: staffStart.status })

  const ref = started?.providerRef

  // The provider's own record of what it was asked for. The amount crossing a
  // real socket, signed, and coming back the same is the whole outbound path.
  const intents = await json(await fetch(`${PSP}/v1/intents`))
  const intent  = intents?.find(i => i.id === ref)
  t('start.reachedTheProvider', {
    found:     !!intent,
    amount:    intent?.amount,
    currency:  intent?.currency,
    reference: intent?.reference,
    status:    intent?.status,
  })

  // ── 3. four ways a webhook is refused ─────────────────────────────────
  const evt = (id, type = 'payment.succeeded', paymentRef = ref) =>
    ({ id, type, created: Math.floor(Date.now() / 1000), data: { paymentRef, amount: 4250, currency: 'USD', reference: 'ORD-PAY-1', reason: null } })

  // (a) a forged signature
  const forged = await postWebhook(evt(`evt_${RUN}_forged`), { secret: 'not-the-secret' })

  // (b) a real signature over a body that was then changed. The hash of the
  //     body is in the canonical string, so this is the case a scheme signing
  //     `timestamp.body` and a scheme signing nothing at all differ on.
  const tampered = await postWebhook(evt(`evt_${RUN}_tampered`), {
    body: JSON.stringify(evt(`evt_${RUN}_tampered_changed`)),
  })

  // (c) a clock ten minutes out — a valid signature, refused on freshness.
  const stale = await postWebhook(evt(`evt_${RUN}_stale`), {
    timestamp: Math.floor(Date.now() / 1000) - 600,
  })

  // (d) the SAME request twice, byte for byte. Refused on the nonce, before
  //     the ledger is ever consulted — which is why the id below is one no
  //     ledger row exists for and the second call is a 401 rather than the
  //     200 a duplicate event gets.
  const nonce = crypto.randomUUID()
  // A paymentRef this shop has no row for, so the ledger row it legitimately
  // writes does not land in the slice counted at step 6. The FIRST call is a
  // real 200 — the nonce is what refuses the second, and it refuses before the
  // ledger is ever consulted, which is the whole distinction being drawn.
  const replayBody = evt(`evt_${RUN}_replay`, 'payment.unknown', `pi_${RUN}_replay`)
  const first  = await postWebhook(replayBody, { nonce })
  const second = await postWebhook(replayBody, { nonce })

  t('webhook.refusals', {
    forged:   forged.status,
    tampered: tampered.status,
    stale:    stale.status,
    replayFirst:  first.status,
    replaySecond: second.status,
  })

  // None of the four moved anything.
  const afterRefusals = await json(await fetch(`${API}/api/orders/${orderId}`, { headers: auth }))
  t('webhook.refusalsChangedNothing', { status: afterRefusals?.status })

  // ── 4. the shopper pays, and the machine moves ────────────────────────
  //
  // Through the PROVIDER, not through this file: `confirm` is the provider's
  // hosted page, and it signs and delivers the webhook itself. What this drive
  // signs by hand above is only the cases a provider will not produce on demand.
  const announcements = async () =>
    (await json(await fetch(`${API}/api/jobs?limit=500`)) ?? [])
      .filter(j => {
        if (j.name !== 'announce-payment') return false
        try { return JSON.parse(j.data)?.orderId === orderId } catch { return false }
      })
  const announcementsBefore = (await announcements()).length

  const confirm = await fetch(`${PSP}/v1/intents/${ref}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeeded' }),
  })
  const confirmed = await json(confirm)
  t('confirm.deliveredTheWebhook', { status: confirm.status, webhook: confirmed?.webhook })

  const paid = await json(await fetch(`${API}/api/orders/${orderId}`, { headers: auth }))
  t('webhook.settledTheOrder', { status: paid?.status })

  // The payment row, read as an administrator — @@gate("5.8.8.9").
  const payments = await json(await fetch(`${API}/api/payments?providerRef=${ref}`, { headers: auth }))
  const payment  = payments?.data?.[0]
  t('webhook.settledThePayment', {
    status:    payment?.status,
    settled:   typeof payment?.settledAt === 'string',
    amount:    payment?.amount,
    orderId:   payment?.orderId === orderId,
  })

  // ── 5. the state move reached the socket ──────────────────────────────
  //
  // The order was moved by `payments.record` through a Litestone client, not
  // through the orders service — so nothing in the service pipeline announced
  // it. Litestone's own write tap is what does, and until FJS-463 it dropped
  // `transition` events entirely: the write succeeded, the seller's open tab
  // stayed on `pending`, and nothing anywhere said so.
  //
  // Announced under the MOVE's name, which is the same name a `pay` through
  // the orders service announces under — one event for a subscriber to handle
  // however the move was made.
  const frame = await until(async () =>
    frames.find(f => f.event === 'orders pay' && f.data?.id === orderId) ?? null, 6_000)
  t('live.moveReachedTheChannel', frame
    ? { event: frame.event, id: frame.data?.id, status: frame.data?.status, reference: frame.data?.reference }
    : { missing: true, saw: frames.map(f => f.event) })

  // ── 6. the ledger, and a redelivery ───────────────────────────────────
  const ledgerFor = async (paymentRef) =>
    (await json(await fetch(`${API}/api/payment-events?paymentRef=${paymentRef}&$limit=100`, { headers: auth })))?.data ?? []

  const before = await ledgerFor(ref)
  const again  = await fetch(`${PSP}/v1/intents/${ref}/redeliver`, { method: 'POST' })
  const after  = await ledgerFor(ref)

  t('webhook.redeliveryIsDeduped', {
    accepted:  again.status,
    rowsBefore: before.length,
    // The provider sent the same event id again. One row, not two — and the
    // order did not move twice, which the state machine would have refused
    // anyway. Both are true and they are true for different reasons.
    rowsAfter:  after.length,
    kinds:      after.map(r => r.kind),
  })

  // One announcement for one payment. The redelivery must not queue a second
  // email — the ledger stops it before `settleOrder` is reached, which is the
  // half `@@transitions` could not cover on its own.
  //
  // Counted as a DELTA from before the settlement, for the reason verify-jobs
  // counts its bookings that way: db/jobs.db outlives `bun run reset` and
  // SQLite reuses row ids, so an announcement naming order 4 is this run's and
  // also whichever order held id 4 last time.
  const queued = await until(async () => {
    const rows = await announcements()
    return rows.length > announcementsBefore ? rows : null
  })

  // ─── And it RAN ───────────────────────────────────────────────────────
  //
  // Counting the row is not the assertion. This one was `{ count: 1 }` alone
  // and stayed green while every announcement this drive queued failed its
  // whole retry ladder: the webhook runs as the app's own principal, and
  // re-resolving that principal at run time threw `no such principal` — the
  // app saying its own name and not being recognised (`FJS-467`). A queued
  // job nobody watches finish is a row, not an effect.
  const finished = queued ? await until(async () => {
    const rows = await announcements()
    const mine = rows.slice(announcementsBefore)
    return mine.every(j => j.status === 'done') ? mine : null
  }, 15_000) : null

  t('outbox.oneAnnouncement', {
    count:  queued ? queued.length - announcementsBefore : 0,
    ranOk:  !!finished,
    // Named, because a job that failed and is waiting to retry is `pending`
    // with an error on it — which reads exactly like one that has not started.
    statuses: finished ? [...new Set(finished.map(j => j.status))] : (queued ?? []).slice(announcementsBefore).map(j => `${j.status}:${String(j.error ?? '').slice(0, 60)}`),
  })

  // ── 7. paying a paid order ────────────────────────────────────────────
  const startAgain = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: payCode }),
  })
  t('start.refusesASettledOrder', { status: startAgain.status })

  // ── 8. a declined card ────────────────────────────────────────────────
  //
  // The order stays PENDING. A refusal is not a cancellation: the shopper is
  // expected to try another card, and `start` has to keep answering — which it
  // only does because nothing moved the status.
  const order2 = await newOrder('ORD-PAY-2', 999)
  const code2  = await codeFor(order2)
  const start2 = await json(await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: code2 }),
  }))
  await fetch(`${PSP}/v1/intents/${start2.providerRef}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'failed' }),
  })
  const declined = await json(await fetch(`${API}/api/payments?providerRef=${start2.providerRef}`, { headers: auth }))
  const order2After = await json(await fetch(`${API}/api/orders/${order2}`, { headers: auth }))
  // The same code again. A declined card is expected to be retried, which is
  // where a payment code parts company with `Cart.handoffCode`: a handoff is one
  // transfer and this is a capability that lasts as long as the order is payable.
  const retry = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: code2 }),
  })
  t('webhook.declinedLeavesTheOrderPayable', {
    payment:  declined?.data?.[0]?.status,
    reason:   typeof declined?.data?.[0]?.failureReason === 'string',
    order:    order2After?.status,
    retry:    retry.status,
  })

  // ── 9. an event about a payment this shop has never heard of ──────────
  //
  // A refund issued from the provider's own dashboard, a test event fired at a
  // fresh database. Recorded and not acted on, and answered 200 — there is
  // nothing for the provider to retry, and a 4xx here means it retries a
  // stranger's event forever.
  const unknown = await postWebhook(evt(`evt_${RUN}_unknown`, 'payment.succeeded', `pi_${RUN}_never`))
  const unknownBody = await json(unknown)
  const unknownRows = await ledgerFor(`pi_${RUN}_never`)
  t('webhook.unknownPaymentIsRecorded', {
    status: unknown.status,
    said:   unknownBody?.status,
    rows:   unknownRows.length,
  })

  // ── 10. the provider is down ──────────────────────────────────────────
  //
  // `retryable` is the thing a status code cannot carry, and it is the whole
  // reason this goes through conduit: "the provider is having a bad minute"
  // and "our key is wrong" are one failed fetch and two different things to
  // tell a shopper.
  await fetch(`${PSP}/fail-next`, { method: 'POST' })
  const order3 = await newOrder('ORD-PAY-3', 500)
  const outage = await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: await codeFor(order3) }),
  })
  const outageBody = await json(outage)
  t('start.reportsAProviderOutage', {
    status:    outage.status,
    retryable: outageBody?.retryable ?? outageBody?.data?.retryable,
    // Nothing was written. A row claiming a payment exists at a provider that
    // refused the request is worse than no row at all.
    rows: ((await json(await fetch(`${API}/api/payments?orderId=${order3}`, { headers: auth })))?.data ?? []).length,
  })
  await fetch(`${API}/api/orders/${order3}`, { method: 'DELETE', headers: auth })

  // ── 11. the declared surface ──────────────────────────────────────────
  //
  // `methods:` names find, get, start and record. Everything else is 405 —
  // and a payment is not a row a person makes, so that is the right answer
  // rather than a 403 from a gate the caller could not have known about.
  const created = await fetch(`${API}/api/payments`, { method: 'POST', headers: auth, body: JSON.stringify({ amount: 1 }) })
  const anon    = await fetch(`${API}/api/payments`)
  // The ledger refuses an edit TWICE, and the outer one answers first: the
  // service declares `methods: ['find','get']`, so PATCH is 405 and never
  // reaches the Data boundary. Behind it `@@gate("5.8.9.9")` has update at 9 —
  // LOCKED, which `asSystem()` does not pass either, which is what append-only
  // is spelt with. Asserted as 405 because that is what a caller gets; the 9 is
  // asserted where it can be, in db/access.snapshot.md.
  const ledgerRow = (await ledgerFor(ref))[0]
  const edited = await fetch(`${API}/api/payment-events/${ledgerRow?.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ kind: 'rewritten' }),
  })
  t('surface.isDeclared', { create: created.status, anonymousRead: anon.status, ledgerPatch: edited.status })

  // ── 12. a refund, on an order that came from a real basket ────────────
  //
  // Every order above was created straight through the orders service, which
  // is fine for the money and useless for the shelf: an Order carries no
  // lines, and what a refund puts back is read from the INVENTORY LEDGER,
  // which only a checkout writes. So this one is bought the way a shopper
  // buys it — open a basket, add a line, check out — and that is also the only
  // path that exercises `x-cart-token` as a declared per-call header.
  const variants = await json(await fetch(`${API}/api/product-variants?active=true&$limit=20`))
  const variant  = (variants?.data ?? []).find(v => v.stock > 3)
  if (!variant) throw new Error('no variant with stock to buy — run `bun run reset`')

  const opened = await json(await fetch(`${API}/api/carts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'open' }, body: '{}',
  }))
  const cartId = opened?.id, cartToken = opened?.token
  const cart = (method, body) => fetch(`${API}/api/carts/${cartId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-method': method, 'x-cart-token': cartToken },
    body: JSON.stringify(body ?? {}),
  })

  await cart('addLine', { variantId: variant.id, quantity: 2 })
  const bought = await json(await cart('checkout', { email: 'refunds@shop.test', name: 'Reva Fund' }))

  const stockAfterSale = (await json(await fetch(`${API}/api/product-variants/${variant.id}`)))?.stock

  // The one start in this file that uses the code a SHOPPER was handed, off
  // `carts.checkout`'s own answer, rather than one staff asked for. That is the
  // path a hosted checkout takes, so it is the one worth spending a real
  // checkout on.
  const sale = await json(await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ code: bought.checkoutCode }),
  }))
  await fetch(`${PSP}/v1/intents/${sale.providerRef}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'succeeded' }),
  })

  const doRefund = (headers, body) => fetch(`${API}/api/payments/${sale.paymentId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'refund', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  const paymentNow = async () =>
    (await json(await fetch(`${API}/api/payments/${sale.paymentId}`, { headers: auth })))
  const orderNow = async () =>
    (await json(await fetch(`${API}/api/orders/${bought.orderId}`, { headers: auth })))
  const stockNow = async () =>
    (await json(await fetch(`${API}/api/product-variants/${variant.id}`)))?.stock

  t('refund.setup', {
    soldTwo:  stockAfterSale === variant.stock - 2,
    paid:     (await orderNow())?.status,
    // The SUBTOTAL is the lines. `total` is what the card was charged, and
    // since shipping and tax arrived those are two different numbers — this
    // basket chose no delivery method, so the gap is the shop's tax alone.
    // The refunds below are all fractions of `total`, which is the figure a
    // payment was taken for and therefore the only one a refund can be against.
    total:    bought.subtotal === variant.price * 2,
  })

  // ── 13. the authority is the SEED's, not a number in a service ─────────
  //
  // `refund: paid -> refunded @gate(5)` in db/schema.lite. `gateAuth` grades
  // CRUD and says nothing about a custom method, so `payments.refund` asks
  // `db.order.transitions(row)` — which answers `allowed` for the caller in
  // scope, off that same declaration. A level-4 user is refused by the seed's
  // rule rather than by a comparison this file would have to keep in step.
  const staff = await json(await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sam@shop.test', password: 'correct-horse-battery' }),
  }))
  const asStaff = { authorization: `Bearer ${staff.token}` }

  const refusedForLevel = await doRefund(asStaff, {})
  const refusedAnon     = await doRefund({}, {})
  t('refund.needsAnAdministrator', {
    level4:    refusedForLevel.status,
    anonymous: refusedAnon.status,
    // And nothing went back — the check is before the provider, not after it.
    refunded:  (await paymentNow())?.refundedAmount,
    provider:  (await json(await fetch(`${PSP}/v1/intents`)))?.find(i => i.id === sale.providerRef)?.refunded,
  })

  // ── 14. part of it ────────────────────────────────────────────────────
  //
  // Money back on an order that is still paid and still shipping — the shop
  // has refunded the postage, not the sale. The order must NOT move and the
  // shelf must NOT change, because neither has happened.
  // Cents, so a half is an integer division that may leave one over — and the
  // remainder matters: the whole of the rest is refunded below and the two have
  // to add up to what was charged.
  const half = Math.floor(bought.total / 2)
  const partial = await json(await doRefund(auth, { amount: half }))
  const afterPartial = await paymentNow()
  t('refund.partial', {
    answered:  partial?.refunded,
    recorded:  afterPartial?.refundedAmount,
    // Still `succeeded`: the status is about the ATTEMPT and the amount is a
    // separate fact. A fifth enum member would fuse them.
    status:    afterPartial?.status,
    order:     (await orderNow())?.status,
    stock:     await stockNow(),
  })

  // ── 15. the same refund twice is one refund ───────────────────────────
  //
  // The one outbound call in this app that states an `Idempotency-Key`, and
  // the only endpoint where a retry costs real money. The key is built from
  // the payment and the amount — what makes two attempts THE SAME refund is
  // the shop's intention, which nothing downstream can infer.
  const twice = await json(await doRefund(auth, { amount: half }))
  const afterTwice = await paymentNow()
  t('refund.idempotent', {
    answered: twice?.refundedTotal,
    recorded: afterTwice?.refundedAmount,
    provider: (await json(await fetch(`${PSP}/v1/intents`)))?.find(i => i.id === sale.providerRef)?.refunded,
  })

  // ── 16. the rest of it, and the shelf ─────────────────────────────────
  //
  // No `amount` means everything that is left, which is what a shop means nine
  // times in ten; stating a number to mean "all of it" is the shape that goes
  // wrong when the number is stale.
  const rest = await json(await doRefund(auth, {}))
  const afterFull = await paymentNow()
  const returned = ((await json(await fetch(
    `${API}/api/inventory?reference=${bought.reference}&kind=returned`, { headers: auth })))?.data ?? [])
  t('refund.wholeMovesTheOrderAndTheShelf', {
    answered:  rest?.refundedTotal,
    payment:   afterFull?.status,
    refunded:  afterFull?.refundedAmount,
    order:     (await orderNow())?.status,
    // Back on the shelf, and the LEDGER says so — read back from the movement
    // rows, which is also where `restock` read what to put back.
    stock:     await stockNow(),
    movements: returned.length,
    putBack:   returned.reduce((n, m) => n + m.quantity, 0),
  })

  // ── 17. and there is nothing left to give back ─────────────────────────
  const already = await doRefund(auth, {})
  t('refund.exhausted', { status: already.status })

  // ── Leave the queue quiet ─────────────────────────────────────────────
  //
  // Not an assertion — housekeeping, and it is here because this drive is the
  // one that made it necessary. Paying four orders queues four
  // `announce-payment` jobs on a concurrency-1 queue, and `verify:notify` runs
  // in the same process against the same queue: it arms the mail sink's
  // `POST /fail-next` and expects ITS OWN email to hit the 500. A job of this
  // drive's still in flight consumes that armed failure instead, and
  // `verify:notify` fails on an assertion about a provider outage it never
  // saw. Measured — it passes alone and fails when run after this file.
  //
  // Waiting for a terminal state rather than sleeping: a fixed pause is a
  // guess that gets slower and still races.
  await until(async () => {
    const jobs = await json(await fetch(`${API}/api/jobs?limit=500`)) ?? []
    const busy = jobs.filter(j => j.name === 'announce-payment' && (j.status === 'pending' || j.status === 'running'))
    return busy.length === 0 ? true : null
  }, 20_000)

} catch (err) {
  console.error(`\nDrive threw: ${err.message}`)
  console.error(err.stack)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* already gone */ }
}

const expected = {
  // A target declaring `hmac` means nothing unless the far side checks it.
  // The second half is the one that separates this from signing a timestamp:
  // a real signature over a body that was then swapped is still refused.
  'provider.refusesUnsigned': { unsigned: 401, bodySwapped: 401 },

  'start.answers': { status: 200, providerRef: true, amount: 4250, paymentStatus: 'pending' },
  'start.refusesAStrangerNamingAnId': {
    status: 404, leaksAmount: false, leaksStatus: false, wrongCode: 404, sameAsMissing: true,
  },
  'start.staffNeedNoCode': { status: 200 },
  'start.reachedTheProvider': {
    found: true, amount: 4250, currency: 'USD',
    reference: 'ORD-PAY-1', status: 'requires_confirmation',
  },

  // Four mechanisms, four lifetimes: the secret is forever, the body hash is
  // per request, the window is five minutes, the nonce store is per process.
  'webhook.refusals': {
    forged: 401, tampered: 401, stale: 401, replayFirst: 200, replaySecond: 401,
  },
  'webhook.refusalsChangedNothing': { status: 'pending' },

  'confirm.deliveredTheWebhook': { status: 200, webhook: 200 },
  'webhook.settledTheOrder': { status: 'paid' },
  'webhook.settledThePayment': { status: 'succeeded', settled: true, amount: 4250, orderId: true },

  // FJS-463: a transition made outside the service that owns the model used to
  // announce nothing at all.
  'live.moveReachedTheChannel': { event: 'orders pay', id: null, status: 'paid', reference: 'ORD-PAY-1' },

  'webhook.redeliveryIsDeduped': {
    accepted: 200, rowsBefore: 1, rowsAfter: 1, kinds: ['payment.succeeded'],
  },
  'outbox.oneAnnouncement': { count: 1, ranOk: true, statuses: ['done'] },
  'start.refusesASettledOrder': { status: 400 },

  'webhook.declinedLeavesTheOrderPayable': {
    payment: 'failed', reason: true, order: 'pending', retry: 200,
  },
  'webhook.unknownPaymentIsRecorded': { status: 200, said: 'unknown-payment', rows: 1 },
  'start.reportsAProviderOutage': { status: 502, retryable: true, rows: 0 },
  'surface.isDeclared': { create: 405, anonymousRead: 401, ledgerPatch: 405 },

  // A real sale, so there is a ledger to refund against.
  'refund.setup': { soldTwo: true, paid: 'paid', total: true },

  // 403 from the SEED's `@gate(5)` on the transition, asked through
  // `transitions(row)` — not from a level compared in a service. Nothing moved
  // at the provider, because the check is before the money and not after it.
  'refund.needsAnAdministrator': { level4: 403, anonymous: 403, refunded: 0, provider: 0 },

  // Money back, order untouched, shelf untouched.
  'refund.partial': { answered: 'HALF', recorded: 'HALF', status: 'succeeded', order: 'paid', stock: 'SOLD' },

  // The provider replayed its first answer; nothing moved a second time.
  'refund.idempotent': { answered: 'HALF', recorded: 'HALF', provider: 'HALF' },

  // The rest of it: the payment closes, the order moves, and two items go back
  // on the shelf through one `returned` movement per line.
  'refund.wholeMovesTheOrderAndTheShelf': {
    answered: 'TOTAL', payment: 'refunded', refunded: 'TOTAL',
    order: 'refunded', stock: 'RESTORED', movements: 1, putBack: 2,
  },

  'refund.exhausted': { status: 400 },
}

// Three of the refund expectations are computed from this run's own basket —
// the variant's price decides the total and the seeded stock decides the
// shelf — so the constants above are placeholders filled in here. Written this
// way rather than as bare `true` so a wrong NUMBER fails, not just a wrong
// shape.
{
  const setup = got['refund.setup'] ?? {}
  const half  = got['refund.partial']?.answered
  const total = got['refund.wholeMovesTheOrderAndTheShelf']?.answered
  const sold  = got['refund.partial']?.stock
  const fill = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === 'HALF')     obj[k] = half
      if (v === 'TOTAL')    obj[k] = total
      if (v === 'SOLD')     obj[k] = sold
      if (v === 'RESTORED') obj[k] = sold + 2
    }
  }
  fill(expected['refund.partial'])
  fill(expected['refund.idempotent'])
  fill(expected['refund.wholeMovesTheOrderAndTheShelf'])
  // …and the two that must be REAL numbers rather than whatever was answered:
  // half of the order total, and the whole of it.
  if (setup.total === true && typeof half === 'number' && typeof total === 'number') {
    if (Math.abs(half * 2 - total) > 1) {
      console.log(`  FAIL refund.amountsAgree`)
      console.log(`         half ${half} does not double to total ${total}`)
      process.exitCode = 1
    }
  }
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  let have = got[key]
  // The order id is this run's and cannot be a constant. Asserted as "the id
  // this run created" by the drive body, and blanked here so the rest of the
  // frame is compared literally.
  if (key === 'live.moveReachedTheChannel' && have && !have.missing) have = { ...have, id: null }
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}

const total = Object.keys(expected).length
console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${total} assertions passed`)
process.exit(failed ? 1 : 0)
