/**
 * web/test/verify-notify.mjs — the outbound boundary and the two audiences.
 *
 * No browser. Paying an order tells two people in two ways:
 *
 *   the customer   an email, through @frontierjs/conduit to a declared target
 *   the staff      a row, through @frontierjs/notifications' inApp channel
 *
 * Both happen on the queue, after the response. The mail provider is
 * api/src/providers/mail/sink.ts — a dev catcher on :8111 speaking the shape a provider REST
 * API speaks, so the request really leaves the process, really carries a
 * resolved credential, and can really answer 500.
 *
 * What this drive is FOR: an email nobody reads is the easiest thing in a
 * framework to believe in and never check. Every assertion here is either a
 * message that arrived at a server or a row a specific caller could see.
 *
 *   bun run api          # terminal 1  (starts the sink too)
 *   bun run verify:notify
 *
 * It signs in TWICE — once as each demo user, because "you see only your own"
 * cannot be shown with one account. Shares the 10-per-15-minutes window with
 * the other drives.
 */

const API  = process.env.API_URL       ?? 'http://localhost:8110'
const SINK = process.env.MAIL_SINK_URL ?? 'http://localhost:8111'
// A reference of this run's own, not a fixed one, and the reason is a live
// hazard rather than tidiness: `Order` is `@@softDelete` and a soft-deleted row
// KEEPS its `@unique` values, so the cleanup below — which deletes over HTTP and
// therefore soft-deletes — cannot free the reference it just used. A fixed REF
// makes this drive pass exactly once per seed and then answer a 409 on create,
// an undefined order id, and a 500 from `pay` on `/orders/undefined` that names
// nothing about the cause. Same shape as `verify:money` minting its own discount
// codes under a run prefix.
//
// UPPERCASE, because `Order.reference` carries an `@upper` transform: a
// lowercase id is stored uppercased, and the drive would then search the mail
// sink for a subject containing the reference it THINKS it used. That miss is
// silent — the mail is there and the assertion says `missing`.
//
// SHORT, because the column is `@length(3, 20)`. A run id on the end of
// `ORD-NOTIFY-` overruns it, and the 400 that follows is a create the drive does
// not check, an undefined order id, and a 500 from `pay` on `/orders/undefined`
// naming nothing about the cause.
const RUN  = Date.now().toString(36).slice(-6).toUpperCase()
const REF  = `ORD-N${RUN}`

import { requireServers } from './lib/preflight.mjs'

await requireServers([['api (bun run api)', `${API}/api/health`], ['the mail sink', `${SINK}/outbox`]])

const got = {}
const t = (label, value) => { got[label] = value }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function until(fn, ms = 15_000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}

async function signIn(email) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  })
  if (!res.ok) {
    if (res.status === 429) console.error(
      `\nSign-in was rate limited (HTTP 429).\n` +
      `Login allows 10 attempts per 15 minutes; this drive signs in twice and shares\n` +
      `the window with the other four. Wait, or restart the API to reset it.`)
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status}`)
  }
  const token = (await res.json()).token
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

let orderId = null
let admin   = null

try {
  admin      = await signIn('alex@shop.test')
  const user = await signIn('sam@shop.test')

  // Its own reference, and its own slice of the outbox.
  const stale = await (await fetch(`${API}/api/orders?reference=${REF}`, { headers: admin })).json()
  for (const row of stale.data ?? [])
    await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: admin })
  await fetch(`${SINK}/outbox`, { method: 'DELETE' })

  const startedAt = new Date().toISOString()

  const created = await (await fetch(`${API}/api/orders`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ reference: REF, total: 4200, status: 'pending', customerId: 1 }),
  })).json()
  orderId = created.id ?? created.data?.id

  // GET /jobs pages at 50 by default and this queue keeps every job every drive
  // has run, so these scans pass `?limit=500`. Without it the scan stops before
  // the row it is about and reads as "there is no such job".
  //
  // No stale-key dance here any more. `pay` records its announcement through
  // ctx.enqueue, so the job is queued under the OUTBOX ROW's uuid rather than
  // under a `unique` key built from the order id — and SQLite reusing that id
  // can no longer make this run's announcement de-duplicate against a pending
  // job left by an earlier one. What used to stand here cancelled those jobs
  // before every run.

  // ── 1. paying answers without waiting for anybody ──────────────────────
  const before = Date.now()
  const paid = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...admin, 'x-service-method': 'pay' }, body: '{}',
  })
  const payMs = Date.now() - before
  const outboxAtOnce = await (await fetch(`${SINK}/outbox`)).json()

  // The response must not have waited on the provider. Asserted as "the outbox
  // was still empty when pay() returned" rather than as a duration — a timing
  // assertion is a flake generator, an ordering one is not.
  t('pay.doesNotWaitForMail', { status: paid.status, mailSentYet: outboxAtOnce.length })

  // ── 2. the customer's email, at a real server ──────────────────────────
  const mail = await until(async () => {
    const box = await (await fetch(`${SINK}/outbox`)).json()
    return box.find(m => m.subject.includes(REF)) ?? null
  })
  t('mail.arrived', mail ? {
    to:      mail.to,
    from:    mail.from,
    // Authored in the template's `<script module>`, as a function of the same
    // data the body renders from — so the subject names the order without the
    // wording living in two files.
    subject: mail.subject,
    // A message with a subject and no body used to be the shipped behaviour of
    // the notifications email driver, and it "succeeded".
    bodyHasTotal:  !!mail.text?.includes('42.00'),
    bodyHasAction: !!mail.text?.includes(`/orders/${orderId}/`),
    htmlHasAnchor: !!mail.html?.includes('<a href='),
  } : { missing: true })

  // ── 2b. the body is the email kit's, not the line builder's ────────────
  //
  // The distinction is the whole reason `@frontierjs/email-kit` exists: the
  // builder emits `<div><p>…</p></div>`, which is fine for a password reset and
  // is not an email a 2003 mail client lays out correctly. The kit renders a
  // `.mesa` template through the same Mesa compiler the browser uses, at
  // `target: 'email'` — tables, inlined CSS, an Outlook conditional block.
  //
  // Asserted structurally rather than by eye. Nobody in this repo has opened
  // one of these in a real mail client, and that is still true — what this
  // checks is that the kit ran, not that Outlook is happy.
  t('mail.renderedByTheKit', mail ? {
    isDocument:  mail.html.startsWith('<!DOCTYPE html>'),
    tables:      (mail.html.match(/<table/g) ?? []).length > 4,
    inlinedCss:  mail.html.includes('style="'),
    outlookBlock: mail.html.includes('[if mso]'),
    // …and NOT the builder's shape.
    notTheBuilder: !mail.html.includes('font-family:system-ui'),
  } : { missing: true })

  // The sink 401s without `Authorization: Bearer <key>`, so a captured message
  // is proof the credential REF resolved and conduit attached it. Nothing in
  // the app ever holds that value — it is `auth: { ref: 'SHOP_MAIL_KEY' }` in
  // api/src/app.ts and `process.env` at send time.
  t('mail.credentialWasResolved', { captured: !!mail })

  // ── 3. the staff's row, and only their own ─────────────────────────────
  // Scoped to THIS run, not to the reference. A notification has no foreign key
  // to its order (`contextType`/`contextId` is a loose reference, deliberately),
  // so deleting the order at the end of a run leaves its notifications behind —
  // which is the design working, and would otherwise make the second run of
  // this file count two.
  const listFor = async (headers) => {
    const res = await (await fetch(`${API}/api/notifications`, { headers })).json()
    return res.data.filter(n => n.data?.reference === REF && n.createdAt >= startedAt)
  }

  const adminRows = await until(async () => (await listFor(admin)).length ? listFor(admin) : null)
  const userRows  = await until(async () => (await listFor(user)).length  ? listFor(user)  : null)

  t('inApp.eachSeesTheirOwn', {
    admin: adminRows ? adminRows.length : 0,
    user:  userRows  ? userRows.length  : 0,
    // Two users, one event, one row each — and neither can see the other's.
    // Nothing in notifications.service.ts says so; the model does, with
    // `@@allow('read', userId == auth().id)`.
    sameRow: adminRows && userRows ? adminRows[0].id === userRows[0].id : null,
    type:    adminRows ? adminRows[0].type : null,
    title:   adminRows ? adminRows[0].data.title : null,
  })

  // ── 4. what the service refuses ────────────────────────────────────────
  //
  // `methods: ['find','get','patch']` on createBaseService. Declaring it there
  // did NOTHING until 2026-08-06 — the option was read by createService and
  // neither read nor forwarded by the base factory — so this answered 403 from
  // the model's gate, or 400 from validation, depending on the body.
  const forged = await fetch(`${API}/api/notifications`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ userId: 'x', type: 'Forged', data: {} }),
  })
  t('service.refusesCreate', { status: forged.status, message: (await forged.json()).message })

  // ── 5. marking one read, and only one's own ────────────────────────────
  const mine = adminRows[0]
  const read = await fetch(`${API}/api/notifications/${mine.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({}),
  })
  const afterRead = await read.json()
  t('inApp.markRead', { status: read.status, wasUnread: !mine.readAt, nowRead: !!afterRead.readAt })

  // The other user's row is not patchable, and the refusal comes from the Data
  // boundary rather than from a check in the service.
  const theirs = userRows[0]
  const stolen = await fetch(`${API}/api/notifications/${theirs.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({}),
  })
  t('inApp.cannotReadSomebodyElses', { status: stolen.status })

  // ── 6. the provider having a bad minute ────────────────────────────────
  //
  // conduit answers `server_error` (retryable) rather than throwing a string,
  // the mailer turns that into an Error naming the kind, and Caravan schedules
  // a retry instead of losing the mail. The first backoff is 30s, so the job is
  // still pending when this reads it — which is the assertion.
  await fetch(`${SINK}/fail-next`, { method: 'POST' })

  const second = await (await fetch(`${API}/api/orders`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ reference: `${REF}-B`, total: 700, status: 'pending', customerId: 2 }),
  })).json()
  const secondId = second.id ?? second.data?.id

  await fetch(`${API}/api/orders/${secondId}`, {
    method: 'POST', headers: { ...admin, 'x-service-method': 'pay' }, body: '{}',
  })

  // The LIVE one: pending with an error is "failed an attempt, retry scheduled",
  // which is the claim. Identified by its PAYLOAD rather than by a key — there
  // is no `unique` key any more, and the payload is what says which order this
  // job is about. Matching on `j.error` alone would also match cancelled
  // corpses from earlier runs, which keep the error that got them cancelled.
  const isForThisOrder = (j) => {
    if (j.name !== 'announce-payment') return false
    try { return JSON.parse(j.data)?.orderId === secondId } catch { return false }
  }

  const failed = await until(async () => {
    // `?data=1` because this predicate reads the PAYLOAD. The admin route
    // redacts `data` unless a request asks for it, so without the flag every
    // row's `JSON.parse` throws, the filter matches nothing, and the drive
    // reports the job as never having run.
    const jobs = await (await fetch(`${API}/api/jobs?limit=500&data=1`)).json()
    return jobs.find(j => isForThisOrder(j) && j.error && j.status === 'pending') ?? null
  })
  t('mail.providerOutageIsRetried', failed ? {
    // Not 'failed': attempts are below maxAttempts, so it is queued to run again.
    status:      failed.status,
    namesTheKind: failed.error.includes('server_error'),
    // The staff still heard about it — allSettled per channel, and this job
    // sends the two notifications independently.
    saysMailHalf: failed.error.startsWith('announce-payment: email:'),
  } : { missing: true })

  // ── the inbox ───────────────────────────────────────────────────────────
  // The sink's own viewer. An email is the one thing in an app nobody looks at,
  // and a page nobody opens is a page that breaks quietly — so the two routes
  // that make it reachable are asserted here rather than trusted. No browser:
  // this drive has none and should not grow one. That the page RENDERS is a
  // separate question and was answered by hand against a real Chrome.
  const page = await fetch(`${SINK}/`)
  const html = page.ok ? await page.text() : ''
  const sent = await (await fetch(`${SINK}/outbox`)).json()
  const one  = sent[0]
  const raw  = one ? await fetch(`${SINK}/outbox/${one.id}/html`) : null
  t('inbox.isServed', {
    status:      page.status,
    isHtml:      (page.headers.get('content-type') ?? '').startsWith('text/html'),
    // The body goes in an iframe so an email's own <style> cannot restyle the
    // inbox around it. Named here because losing it looks like nothing.
    isolatesTheBody: html.includes('srcdoc'),
  })
  t('inbox.servesOneMessageRaw', raw ? {
    status:   raw.status,
    isHtml:   (raw.headers.get('content-type') ?? '').startsWith('text/html'),
    isTheMail: (await raw.text()).length > 0,
    missing:  (await fetch(`${SINK}/outbox/no-such-id/html`)).status,
  } : { noMailToCheck: true })

  await fetch(`${API}/api/orders/${secondId}`, { method: 'DELETE', headers: admin })
} catch (e) {
  console.error('\nThe drive threw:', e.message)
  console.error('collected so far:', got)
  process.exitCode = 1
} finally {
  if (orderId && admin)
    await fetch(`${API}/api/orders/${orderId}`, { method: 'DELETE', headers: admin }).catch(() => {})
}

if (process.exitCode) process.exit(1)

// ─── the report ───────────────────────────────────────────────────────────

const expected = {
  'pay.doesNotWaitForMail': { status: 200, mailSentYet: 0 },

  'mail.arrived': {
    to:      ['ops@acme.test'],
    // The FLAGSHIP's own address, not the deployment's default.
    //
    // One process serves the whole fleet, so a from-address destructured out of
    // the mailer's options when the plugin was configured is one address for
    // every shop — and a customer reads it on the receipt. `createConduitMailer`
    // resolves it per send through `app.configFor()`, which answers this shop's
    // registry settings over `config.mail.from` as the floor (`FJS-D126`).
    //
    // `shop@example.test` is that floor and is what a shop with no settings of
    // its own still reads; seeing it here would mean the per-send read had
    // silently gone back to being a constant.
    from:    'orders@flagship.test',
    subject: `Your order ${REF} is confirmed`,
    bodyHasTotal: true, bodyHasAction: true, htmlHasAnchor: true,
  },
  'mail.renderedByTheKit': {
    isDocument: true, tables: true, inlinedCss: true,
    outlookBlock: true, notTheBuilder: true,
  },
  'mail.credentialWasResolved': { captured: true },

  'inApp.eachSeesTheirOwn': {
    admin: 1, user: 1, sameRow: false,
    type: 'OrderPaid', title: 'Order paid',
  },

  'service.refusesCreate': {
    status: 405,
    message: "Service 'notifications' does not offer 'create' (allowed: find, get, patch)",
  },

  'inApp.markRead': { status: 200, wasUnread: true, nowRead: true },
  'inApp.cannotReadSomebodyElses': { status: 404 },

  'mail.providerOutageIsRetried': {
    status: 'pending', namesTheKind: true, saysMailHalf: true,
  },

  'inbox.isServed':          { status: 200, isHtml: true, isolatesTheBody: true },
  'inbox.servesOneMessageRaw': { status: 200, isHtml: true, isTheMail: true, missing: 404 },
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

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed ? 1 : 0)
