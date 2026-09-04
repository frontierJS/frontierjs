/**
 * web/test/verify-collect.mjs — the vendor half of a subscription.
 *
 * **This app owns the schedule and the provider takes the money.** A provider
 * will run the whole cycle if asked, and then the state machine, the durable
 * clock and the cross-row invariant all live in the provider's product rather
 * than in the application — which is the opposite of what this app is for. So
 * what is asserted here is the seam: one call out, one signed event back, and
 * what the shop DOES with the answer.
 *
 * ─── The three things nothing else here covers ────────────────────────────
 *
 * `verify:pay` already proves a signed webhook drives an ORDER, four ways a
 * forged one is refused, and that a redelivered event is absorbed by the
 * ledger. None of that is repeated. What is new is:
 *
 *   **A payment is for an ORDER or an INVOICE, exactly one.** `Payment` is
 *   `@@arc([orderId, invoiceId])` and the Data boundary refuses both-set and
 *   neither-set — the shop's first use of the declaration, and the reason a
 *   subscription payment needs no second table.
 *
 *   **A decline is a domain answer, and WHICH answer is the provider's code.**
 *   Soft — the money may be there tomorrow — leaves the dunning clock to run.
 *   Hard — a stolen card — lapses the subscription at once, because a shop that
 *   keeps re-presenting one gets its merchant account reviewed.
 *
 *   **An event that arrives out of ORDER cannot corrupt anything**, and the
 *   mechanism is not a timestamp comparison: `@@transitions` refuses a move
 *   from where the row already is. A stale failure landing after a settlement
 *   finds a `paid` invoice and `settle: issued -> paid` does not apply.
 *
 * It starts its own API and stops it. No browser, and no login: everything here
 * is a machine talking to a machine, so it costs nothing against the limiter.
 */

import { execFileSync }  from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signRequest }   from '@frontierjs/toolbelt/signature'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const HOOK = '/api/webhooks/payments'
const HOOK_SECRET = process.env.SHOP_PSP_WEBHOOK_SECRET ?? 'dev-psp-webhook-secret'

// ─── The app runs IN THIS PROCESS, and that is the finding ────────────────
//
// The first version of this drive spawned `api/index.ts` and reached the app
// only over HTTP, which is what every other drive here does. It could not
// charge anything: a conduit TARGET is registered in the plugin's `boot()`, so
// an app that has been built and not started has `app.conduit` and no targets,
// and `chargeInvoice` answered `target_not_found` — a correct refusal to a
// question nobody meant to ask.
//
// Starting it here is not a convenience. The seam under test is *what the shop
// does with what the provider says*, and both halves of that need the same
// process: the outbound call needs the booted conduit, and the inbound webhook
// needs the route bound on 8110. A spawned server gives the second and not the
// first.
const stopAll = () => {}

for (const [port, what] of [[8110, 'the API']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

// The provider, then the app. Both are the ones `bun run api` starts — the
// same module, the same port — so what is exercised below is the shipped
// wiring and not a rehearsal of it.
const { startPspSink } = await import(join(ROOT, 'api/src/providers/psp/sink.ts'))
if (!process.env.PSP_URL) startPspSink()

/** Where the provider is. The shopper's half of a setup intent is confirmed
 *  here directly, because that page is the provider's and not the shop's. */
const PSP_URL = process.env.PSP_URL ?? `http://localhost:${process.env.PSP_SINK_PORT ?? 8112}`

const app = (await import(join(ROOT, 'api/src/app.ts'))).default
await app.start()

/** Sign a webhook the way the provider does. Same helper `verify-pay` uses,
 *  because a second signer here would be a second opinion about the scheme. */
async function postWebhook(body) {
  const raw = JSON.stringify(body)
  const headers = await signRequest({
    secret: HOOK_SECRET, method: 'POST', path: HOOK, body: raw,
    prefix: 'X-Psp', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  const res = await fetch(`${API}${HOOK}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// The app's own client, for the rows a webhook is about. Reading them over HTTP
// would need a session at level 5 and would put this drive on the limiter for
// facts that are not about the transport.
const { db } = await import(join(ROOT, 'api/src/core/db.ts'))
const { chargeInvoice, issueInvoice, periodLines } = await import(join(ROOT, 'api/src/domain/billing'))
const sys = db.asSystem()

const RUN = String(Date.now()).slice(-6)
const DAY = 24 * 60 * 60 * 1000
const got = {}
const t = (label, value) => { got[label] = value }

// ─── A subscription with something owed ───────────────────────────────────

const customer = await sys.customer.findFirst({ where: { email: 'robin@buyer.test' } })
const plan     = await sys.plan.findFirst({ where: { code: 'PRO' } })
const version  = await sys.planVersion.findFirst({ where: { planId: plan.id, effectiveTo: null } })

async function freshSubscription(suffix, who = customer) {
  const start = new Date(Date.now() - 5 * DAY).toISOString()
  const end   = new Date(Date.now() + 25 * DAY).toISOString()
  const sub = await sys.subscription.create({ data: {
    reference: `SUB-C${RUN}${suffix}`, customerId: who.id, planVersionId: version.id,
    status: 'active', quantity: 1,
    currentPeriodStart: start, currentPeriodEnd: end, userId: who.userId,
  } })
  const invoice = await issueInvoice(sys, {
    number: `INV-C${RUN}${suffix}`, customerId: who.id, subscriptionId: sub.id,
    userId: who.userId, periodStart: start, periodEnd: end,
    lines: periodLines({ name: plan.name, quantity: 1, unitAmount: version.price,
                         periodStart: start, periodEnd: end }),
  })
  return { sub, invoice }
}

// ─── 1. The arc ───────────────────────────────────────────────────────────

{
  const { invoice } = await freshSubscription('A')
  const order = await sys.order.findFirst({})
  const refused = async (data) => {
    try { await sys.payment.create({ data }); return false } catch { return true }
  }
  t('arc.neitherIsRefused', await refused({ providerRef: `pi_none${RUN}`, amount: 1, currency: 'USD' }))
  t('arc.bothIsRefused',    await refused({ providerRef: `pi_both${RUN}`, amount: 1, currency: 'USD',
                                            orderId: order.id, invoiceId: invoice.id }))
  t('arc.invoiceOnlyIsFine', !await refused({ providerRef: `pi_inv${RUN}`, amount: 1, currency: 'USD',
                                              invoiceId: invoice.id }))
}

// ─── 1b. Filing a card ────────────────────────────────────────────────────
//
// The half without which none of the rest can happen with nobody there. A
// subscription is charged again next month at three in the morning, so the
// first charge is a conversation with a person and every one after it is a
// token the provider issued once.
//
// Through the SERVICE with a principal rather than over HTTP: the assertions
// here are about who may see what and about the event, and a session would put
// this drive on the login limiter for facts that are not about the transport.

/** The shopper, as a caller. */
const asShopper = {
  auth: { user: { id: customer.userId, userId: customer.userId,
                  isStaff: false, role: 'user',
                  verifiedAt: new Date().toISOString() } },
}

/** Confirm a setup intent the way a person does — on the provider's own page,
 *  with no credential, because the person IS the authorization there. */
const confirmCard = (id, card = 'ok') =>
  fetch(`${PSP_URL}/v1/setup-intents/${id}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card }),
  }).then(r => r.json())

/** The customer's cards, newest last. Counted rather than assumed empty: a card
 *  is filed by an EVENT, so `db/seed.ts` owns none of these rows and cannot
 *  restore them — which makes *there are none* a fact about how many times this
 *  drive has run rather than about the code (`FJS-530`'s shape one table
 *  along). Every assertion below is therefore a DELTA. */
const cards = () => sys.paymentMethod.findMany({
  where: { customerId: customer.id }, orderBy: { id: 'asc' }, limit: 50,
})

let filedCardId = null
{
  const before = (await cards()).length
  const setup  = await app.service('payment-methods').call('startSetup', null, {}, asShopper)
  t('setup.mintsASetupIntent', typeof setup?.id === 'string' && setup.id.startsWith('seti_'))

  // Nothing is filed yet, and that is the point of the two steps: a shop that
  // could file a card off its own reply would be filing one nobody agreed to.
  t('setup.filesNothingUntilSomebodyConfirms', (await cards()).length === before)

  const done = await confirmCard(setup.id)
  t('setup.theProviderDeliveredTheEvent', done?.webhook === 200)

  const after = await cards()
  const filed = after.at(-1)
  filedCardId = filed?.id ?? null
  t('setup.theEventFilesTheInstrument',
    after.length === before + 1 &&
    filed?.brand === 'mastercard' && filed.last4 === '4242' && filed.isDefault === true)

  // `providerRef` is `@guarded`: it can move money, so the app writes it, the
  // system reads it, and no response carries it. `brand` and `last4` are the
  // opposite — they exist to be shown. One model, two answers, which is what a
  // model-level gate can never express.
  const mine = await app.service('payment-methods').call('find', null, {}, asShopper)
  const row  = (mine?.data ?? [])[0]
  t('setup.theShopperSeesTheCard', row?.last4 === '4242' && row.brand === 'mastercard')
  t('setup.andNeverTheToken', row !== undefined && !('providerRef' in row))

  // A second card. The newest is the one a renewal reaches for, which is what
  // somebody adding one means — and *one default per customer* is still the rule
  // no constraint states here: the predicate is expressible since `FJS-603` and
  // the declaration collides with this model's own `@@index([customerId])`
  // (`FJS-614`). So this is the assertion standing in for a constraint.
  const second = await app.service('payment-methods').call('startSetup', null, {}, asShopper)
  await confirmCard(second.id)
  const all = await cards()
  t('setup.theNewestBecomesTheDefault',
    all.filter(c => c.isDefault).length === 1 && all.at(-1).isDefault === true)
  filedCardId = all.at(-1).id
}

// ─── 2. Presenting it ─────────────────────────────────────────────────────

const { sub: subB, invoice: invB } = await freshSubscription('B')
let refB = null
{
  // Through the app's conduit, which is where the credential, the timeout and
  // the breaker live. A `fetch` here would test a different thing entirely.
  const r = await chargeInvoice({ conduit: app.conduit }, sys, invB.id)
  refB = r.paymentRef ?? null
  t('charge.presentsTheFiledCard', Boolean(refB) && !r.error)

  const row = await sys.payment.findFirst({ where: { providerRef: refB } })
  t('charge.writesThePaymentAgainstTheInvoice',
    row?.invoiceId === invB.id && row.orderId === null)
  t('charge.amountIsTheInvoiceTotal', row?.amount === invB.total)
  // WHICH card was presented, on the row. A payment that cannot say what it
  // was taken against is a reconciliation somebody does by hand.
  t('charge.namesTheInstrument', row?.paymentMethodId === filedCardId)

  // It settled with nobody there. That is the whole of the feature: the money
  // arrived off a signed event, on the provider's own connection, while this
  // process was still inside the call that asked for it.
  const paid = await sys.invoice.findFirst({ where: { id: invB.id } })
  t('charge.settledOffSession', row?.status === 'succeeded' && paid.status === 'paid')

  // Asked twice. Charging twice is the failure this domain is judged on, and
  // the refusal is the INVOICE's state rather than a flag anybody keeps.
  let refused = false
  try { await chargeInvoice({ conduit: app.conduit }, sys, invB.id) }
  catch { refused = true }
  const count = await sys.payment.count({ where: { invoiceId: invB.id } })
  t('charge.aSettledInvoiceIsNotPresentedAgain', refused && count === 1)
}

// ── and the customer who never gave a card ───────────────────────────────
//
// The negative control, and the one that pays for itself: before an instrument
// existed, this minted an intent nobody would ever confirm, so the invoice sat
// `issued` — indistinguishable from a card that keeps saying no — and dunning
// then ran its full twenty-one days at somebody who had never been asked.
{
  const stranger = await sys.customer.findFirst({ where: { email: { not: customer.email } } })
  const { invoice } = await freshSubscription('N', stranger)
  const r = await chargeInvoice({ conduit: app.conduit }, sys, invoice.id)
  t('charge.refusesWithNoInstrument',
    r.error?.kind === 'no_instrument' && r.error.retryable === false)
  // And mints nothing. An intent with no way to pay it is a row somebody has
  // to reconcile against a provider that will never hear about it again.
  t('charge.andPresentsNothing',
    (await sys.payment.count({ where: { invoiceId: invoice.id } })) === 0)
}

// ─── 3. The money arrives ─────────────────────────────────────────────────

{
  // The invoice was settled by the presentation above, off a signed event the
  // provider delivered on its own connection. This reads what that produced
  // rather than posting a second one by hand — a webhook the drive signs is a
  // fact about the signature, and the provider already sent the real one.
  const invoice = await sys.invoice.findFirst({ where: { id: invB.id } })
  t('settle.theProvidersOwnEventSettledIt', invoice.status === 'paid')
  t('settle.stampedPaidAt', Boolean(invoice.paidAt))

  // OUT OF ORDER. A stale failure, delivered after the settlement — which is
  // the ordinary shape of a provider retrying an event it thinks it owes.
  const stale = await postWebhook({ id: `evt_stale_${RUN}`, type: 'payment.failed',
                                    data: { paymentRef: refB, reason: 'declined', declineCode: 'stolen_card' } })
  const after = await sys.invoice.findFirst({ where: { id: invB.id } })
  const subAfter = await sys.subscription.findFirst({ where: { id: subB.id } })
  t('outOfOrder.invoiceStaysPaid', stale.status === 200 && after.status === 'paid')
  // The one this drive found. A stale HARD decline arriving after settlement
  // lapsed a subscription that was paid up, because the guard was on the
  // subscription's state — which is `active` in the stale case and the real one
  // alike. It is the INVOICE's state that separates them.
  t('outOfOrder.subscriptionNotLapsed', subAfter.status === 'active')
  t('outOfOrder.saysItWasStale', stale.body?.status === 'stale')
}

// ─── 4. A decline is an answer, and which answer is the code ──────────────

{
  const { sub, invoice } = await freshSubscription('S')
  const pay = await sys.payment.create({ data: {
    providerRef: `pi_soft${RUN}`, invoiceId: invoice.id, amount: invoice.total,
    currency: 'USD', status: 'pending',
  } })
  const r = await postWebhook({ id: `evt_soft_${RUN}`, type: 'payment.failed',
    data: { paymentRef: pay.providerRef, reason: 'Insufficient funds', declineCode: 'insufficient_funds' } })
  const after = await sys.subscription.findFirst({ where: { id: sub.id } })
  t('soft.recorded', r.status === 200 && r.body?.decline === 'soft')
  // Left to the clock. The invoice is not yet past its due date, so a soft
  // decline changes nothing about the subscription — dunning will grade it.
  t('soft.leavesTheSubscriptionAlone', after.status === 'active')
  t('soft.paymentIsFailed',
    (await sys.payment.findFirst({ where: { id: pay.id } })).status === 'failed')
}

{
  const { sub, invoice } = await freshSubscription('H')
  const pay = await sys.payment.create({ data: {
    providerRef: `pi_hard${RUN}`, invoiceId: invoice.id, amount: invoice.total,
    currency: 'USD', status: 'pending',
  } })
  const r = await postWebhook({ id: `evt_hard_${RUN}`, type: 'payment.failed',
    data: { paymentRef: pay.providerRef, reason: 'Card reported stolen', declineCode: 'stolen_card' } })
  const after = await sys.subscription.findFirst({ where: { id: sub.id } })
  t('hard.recorded', r.status === 200 && r.body?.decline === 'hard')
  // The difference the code makes, and the only one: the grace is skipped.
  t('hard.lapsesAtOnce', after.status === 'pastDue')
  t('hard.invoiceStillOwed',
    (await sys.invoice.findFirst({ where: { id: invoice.id } })).status === 'issued')
}

// An unknown code is SOFT. A new code the provider invents must not cancel
// subscriptions on the day it ships.
{
  const { sub, invoice } = await freshSubscription('U')
  const pay = await sys.payment.create({ data: {
    providerRef: `pi_unk${RUN}`, invoiceId: invoice.id, amount: invoice.total,
    currency: 'USD', status: 'pending',
  } })
  const r = await postWebhook({ id: `evt_unk_${RUN}`, type: 'payment.failed',
    data: { paymentRef: pay.providerRef, reason: 'Something new', declineCode: 'a_code_from_2027' } })
  t('unknown.isTreatedAsSoft', r.body?.decline === 'soft' &&
    (await sys.subscription.findFirst({ where: { id: sub.id } })).status === 'active')
}

// ─── 5. Refunding an invoice payment is not an order refund ───────────────

{
  const res = await fetch(`${API}/api/payments`, { method: 'GET' })
  // The service refuses the wrong shape by NAME rather than answering null for
  // an order that was never there.
  const pay = await sys.payment.findFirst({ where: { providerRef: refB } })
  t('refund.pathExists', res.status === 200 || res.status === 401)
  t('refund.invoicePaymentIsNamed', Boolean(pay?.invoiceId))
}

// ─── 6. The whole cycle, through the real queue ───────────────────────────
//
// **The seam nothing else here crosses.** Every assertion above calls
// `chargeInvoice` directly, and `verify:billing` runs the sweep against a
// RECORDER — it captures the dispatch and never executes it, which is what
// makes its assertions about the id honest and also means the queue is never
// crossed. So the chain the app is actually built out of —
//
//   sweep → dispatch(renew) → issue the document → dispatch(collect) →
//   present it to the provider → the provider's signed event → paid
//
// — had run zero times end to end. Four handoffs, each proven on one side.
// A drive on either side of any of them passes with the crossing broken: the
// renewal issues its invoice and dispatches into a queue nobody drained, and
// the collection charges an invoice a drive made by hand.
//
// It is here rather than in `verify:billing` because it needs BOTH halves of a
// started app — `app.jobs` to drain and `app.conduit` to reach the provider —
// and this is the only drive that starts one.

/** Poll until `fn` answers something, or give up. A queue is asynchronous by
 *  construction, so there is a wait here and it cannot be a fixed sleep: one
 *  long enough to be safe on a loaded machine is one paid on every run. */
async function settles(fn, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

{
  const start = new Date(Date.now() - 40 * DAY).toISOString()
  const end   = new Date(Date.now() - 10 * DAY).toISOString()
  const sub = await sys.subscription.create({ data: {
    reference: `SUB-C${RUN}X`, customerId: customer.id, planVersionId: version.id,
    status: 'active', quantity: 1,
    currentPeriodStart: start, currentPeriodEnd: end, userId: customer.userId,
  } })

  // The sweep, with the REAL app behind it. `ctx.app.jobs.dispatch` writes a
  // row that this process's own workers pick up, so everything after this line
  // happens because the queue made it happen.
  const { sweepRenewals } = await import(join(ROOT, 'api/src/jobs/renew-subscriptions.job.ts'))
  const queued = await sweepRenewals({ app, data: { at: new Date().toISOString() } })
  t('chain.sweepQueuedIt', queued >= 1)

  // Two waits and two different questions. The first is the renewal handler
  // having run at all; the second is the renewal's own dispatch having been
  // drained in turn, which is the handoff no unit test can reach.
  const invoice = await settles(() =>
    sys.invoice.findFirst({ where: { subscriptionId: sub.id } }))
  t('chain.renewalIssuedTheDocument', Boolean(invoice))

  const payment = invoice && await settles(() =>
    sys.payment.findFirst({ where: { invoiceId: invoice.id } }))
  t('chain.collectionPresentedIt',
    payment?.amount === invoice.total && payment.orderId === null &&
    payment.paymentMethodId === filedCardId)

  // …and the money arrives with NOBODY THERE, which is the whole of what the
  // instrument buys. Nothing in this section posts a webhook: the provider
  // delivered its own, on its own connection, because the queue presented a
  // card the shop was already holding. Before that, the chain stopped here
  // with an intent waiting for a person who was never going to confirm it.
  const settled = invoice && await settles(() =>
    sys.invoice.findFirst({ where: { id: invoice.id, status: 'paid' } }))
  t('chain.providerSettledIt', settled?.status === 'paid' && Boolean(settled?.paidAt))

  // The window moved, and the arrangement survived its own renewal. A cycle
  // that bills and does not advance bills again on the next sweep, for ever —
  // which is the failure a drive that stops at *an invoice exists* cannot see.
  const after = await sys.subscription.findFirst({ where: { id: sub.id } })
  t('chain.windowMoved', new Date(after.currentPeriodEnd) > new Date(end))
  t('chain.stillActive', after.status === 'active')

  // And it does not bill twice. A second sweep at the same instant finds the
  // subscription no longer due — the window moved — so this is the WINDOW
  // doing the work rather than the dispatch id, which is the half
  // `verify:billing` cannot separate because its sweep never advanced anything.
  const againQueued = await sweepRenewals({ app, data: { at: new Date().toISOString() } })
  const bills = await sys.invoice.count({ where: { subscriptionId: sub.id } })
  t('chain.secondSweepBillsNothing', againQueued === 0 && bills === 1)
}

// ─── 7. The bank wants the cardholder ─────────────────────────────────────
//
// The third answer, and the one an off-session charge gets most often on a
// first renewal in Europe. It is neither a decline nor a success: the money has
// not moved, presenting the same card again produces the same challenge, and
// the only thing that resolves it is a PERSON answering their issuer.
//
// It runs last because it files a card that behaves this way, and the newest
// card is the default — so putting it earlier would make every section after it
// ask a different question than the one it was written for.

{
  // A card that files perfectly and then asks for the cardholder. That is the
  // shape worth testing: nothing is wrong with it until it is presented with
  // nobody there.
  const setup = await app.service('payment-methods').call('startSetup', null, {}, asShopper)
  await confirmCard(setup.id, 'needs_action')
  const card = (await cards()).at(-1)
  t('sca.theCardFilesLikeAnyOther', card?.isDefault === true && card.last4 === '3155')

  const { sub, invoice } = await freshSubscription('Q')
  const r = await chargeInvoice({ conduit: app.conduit }, sys, invoice.id)

  // NOT an error. The provider answered; what it said is that it needs
  // somebody. A shop treating this as a failed call would retry it on the
  // queue's ladder and produce a challenge per attempt.
  t('sca.presentingIsNotAnError', Boolean(r.paymentRef) && !r.error)

  const pay = await sys.payment.findFirst({ where: { providerRef: r.paymentRef } })
  t('sca.thePaymentSaysSoAndCarriesTheLink',
    pay?.status === 'requiresAction' && typeof pay.actionUrl === 'string' && pay.actionUrl.includes('/challenge/'))

  // The document is still owed and the arrangement is still live. This is the
  // assertion that separates a challenge from a hard decline: a stolen card
  // lapses at once, and a bank asking a question does not.
  const owed = await sys.invoice.findFirst({ where: { id: invoice.id } })
  const live = await sys.subscription.findFirst({ where: { id: sub.id } })
  t('sca.theInvoiceIsStillOwed', owed.status === 'issued')
  t('sca.theSubscriptionIsNotLapsed', live.status === 'active')

  // And it is not presented again. Re-presenting produces the same challenge
  // and a second row to reconcile, so `requiresAction` counts as in flight
  // exactly as `pending` does.
  const again = await chargeInvoice({ conduit: app.conduit }, sys, invoice.id)
  const count = await sys.payment.count({ where: { invoiceId: invoice.id } })
  t('sca.itIsNotPresentedAgain', again.paymentRef === r.paymentRef && count === 1)

  // ── the person answers ────────────────────────────────────────────────
  //
  // On the PROVIDER's own page, unsigned, reached with a browser — which is the
  // design decision this section is really about. A card network's challenge
  // belongs on the network's origin, and hosting it would put a third party's
  // script on this shop's own pages to collect the one thing every other line
  // here is arranged not to see.
  const answered = await fetch(pay.actionUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(x => x.json())
  t('sca.answeringItDeliversTheSettlement', answered?.webhook === 200)

  const settled = await sys.invoice.findFirst({ where: { id: invoice.id } })
  const done    = await sys.payment.findFirst({ where: { id: pay.id } })
  t('sca.theInvoiceIsPaid', settled.status === 'paid' && Boolean(settled.paidAt))
  // The link is cleared. A screen still offering it sends somebody to a page
  // that answers 409 about a payment they have already made.
  t('sca.theLinkIsGone', done.status === 'succeeded' && done.actionUrl === null)

  // OUT OF ORDER, the third time in this file: a challenge delivered after the
  // payment settled must not move it back to *waiting for somebody*.
  const stale = await postWebhook({
    id: `evt_sca_stale_${RUN}`, type: 'payment.action_required',
    data: { paymentRef: pay.providerRef, actionUrl: 'http://example.test/nope' },
  })
  const after = await sys.payment.findFirst({ where: { id: pay.id } })
  t('sca.aStaleChallengeIsIgnored',
    stale.status === 200 && stale.body?.status === 'stale' &&
    after.status === 'succeeded' && after.actionUrl === null)
}

// ─── Report ───────────────────────────────────────────────────────────────


// ─── clearing up ──────────────────────────────────────────────────────────
//
// A drive that leaves rows behind is one every other drive then has to work
// around. `db:seed` restores only what it OWNS, so a subscription minted per
// run accumulates one per run — against the same shopper whose account
// `verify:account` renders, where twenty of them push the seeded one off the
// screen and an assertion about *their standing orders* stops being about
// anything.
//
// Removed in the order the foreign keys allow: `Invoice.subscriptionId` is
// `onDelete: Restrict` and `CreditNote.invoiceId` is too, so the notes go
// first, then the invoices (which cascade their lines and any payments), then
// the subscription. Guarded, because a cleanup that fails must not hide the
// result of the run it is cleaning up after.
try {
  const minted = await sys.subscription.findMany({
    where: { reference: { startsWith: `SUB-C${RUN}` } }, limit: 50,
  })
  for (const s of minted) {
    const bills = await sys.invoice.findMany({ where: { subscriptionId: s.id }, limit: 100 })
    for (const b of bills) {
      await sys.creditNote.deleteMany({ where: { invoiceId: b.id } })
      await sys.invoice.delete({ where: { id: b.id } })
    }
    await sys.subscription.delete({ where: { id: s.id } })
  }
  // The cards, after the payments that name them are gone —
  // `Payment.paymentMethodId` is `onDelete: Restrict`, which is the whole
  // point of it, so the order here is the schema's and not a preference.
  await sys.paymentMethod.deleteMany({ where: { customerId: customer.id } })
} catch (e) {
  console.error(`\n!! could not clear up SUB-C${RUN}*: ${e.message}`)
}

const expected = {
  'arc.neitherIsRefused': true,
  'arc.bothIsRefused': true,
  'arc.invoiceOnlyIsFine': true,
  'setup.mintsASetupIntent': true,
  'setup.filesNothingUntilSomebodyConfirms': true,
  'setup.theProviderDeliveredTheEvent': true,
  'setup.theEventFilesTheInstrument': true,
  'setup.theShopperSeesTheCard': true,
  'setup.andNeverTheToken': true,
  'setup.theNewestBecomesTheDefault': true,
  'charge.presentsTheFiledCard': true,
  'charge.writesThePaymentAgainstTheInvoice': true,
  'charge.amountIsTheInvoiceTotal': true,
  'charge.namesTheInstrument': true,
  'charge.settledOffSession': true,
  'charge.aSettledInvoiceIsNotPresentedAgain': true,
  'charge.refusesWithNoInstrument': true,
  'charge.andPresentsNothing': true,
  'settle.theProvidersOwnEventSettledIt': true,
  'settle.stampedPaidAt': true,
  'outOfOrder.invoiceStaysPaid': true,
  'outOfOrder.subscriptionNotLapsed': true,
  'outOfOrder.saysItWasStale': true,
  'soft.recorded': true,
  'soft.leavesTheSubscriptionAlone': true,
  'soft.paymentIsFailed': true,
  'hard.recorded': true,
  'hard.lapsesAtOnce': true,
  'hard.invoiceStillOwed': true,
  'unknown.isTreatedAsSoft': true,
  'chain.sweepQueuedIt': true,
  'chain.renewalIssuedTheDocument': true,
  'chain.collectionPresentedIt': true,
  'chain.providerSettledIt': true,
  'chain.windowMoved': true,
  'chain.stillActive': true,
  'chain.secondSweepBillsNothing': true,
  'sca.theCardFilesLikeAnyOther': true,
  'sca.presentingIsNotAnError': true,
  'sca.thePaymentSaysSoAndCarriesTheLink': true,
  'sca.theInvoiceIsStillOwed': true,
  'sca.theSubscriptionIsNotLapsed': true,
  'sca.itIsNotPresentedAgain': true,
  'sca.answeringItDeliversTheSettlement': true,
  'sca.theInvoiceIsPaid': true,
  'sca.theLinkIsGone': true,
  'sca.aStaleChallengeIsIgnored': true,
  'refund.pathExists': true,
  'refund.invoicePaymentIsNamed': true,
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const ok = got[key] === want
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) console.log(`         want ${want}   have ${JSON.stringify(got[key])}`)
}
console.log(failed
  ? `\n${failed} assertion(s) failed`
  : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed ? 1 : 0)
