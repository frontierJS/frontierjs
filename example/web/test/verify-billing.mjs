/**
 * web/test/verify-billing.mjs — the recurring half: the clock, the document
 * and the deadline.
 *
 * **bun, and no server.** Everything here is a fact about the Data boundary and
 * the two jobs that drive it, and both are reached the way the queue reaches
 * them — by calling the exported handler with a payload. Standing an API up
 * would add a transport to a drive that asserts nothing about one, and would
 * put this on the login limiter for no reason (`verify:tenants` runs under bun
 * for the same kind of reason: it imports the app's own registry).
 *
 * ─── What it is actually asking ───────────────────────────────────────────
 *
 * A billing cycle is unobservable in a normal test run: the interesting instant
 * is a month away. So the clock is a PARAMETER — `sweepRenewals({ at })` and
 * `dunSubscriptions({ at })` take the instant to grade at, and the drive stands
 * at one. That is the same code path the cron fires, not a second one: the cron
 * passes no `at` and gets `now()`.
 *
 * ─── The one thing that is stubbed, and why ───────────────────────────────
 *
 * `sweepRenewals` dispatches into `app.jobs`, and there is no app here. Its
 * contract is *which ids get queued* — the id IS the idempotency, so that is
 * the whole of what the sweep decides — and the recorder below asserts exactly
 * that. The WORK is then run for real, against the real client, by calling
 * `renewSubscription` with the payload the sweep produced.
 *
 * Every fixture is minted under a per-run prefix (`FJS-530`, `FJS-546`): a
 * subscription reference and an invoice number are both `@unique`, and a drive
 * that reuses one passes exactly once per seed.
 */

import { db }              from '../../api/src/core/db.ts'
import { advancePeriod, settleInvoice, DUNNING_DAYS, GRACE_DAYS, TERMS_DAYS } from '../../api/src/domain/billing'
import { sweepRenewals }   from '../../api/src/jobs/renew-subscriptions.job.ts'
import { renewSubscription } from '../../api/src/jobs/renew-subscription.job.ts'
import { dunSubscriptions }  from '../../api/src/jobs/dun-subscriptions.job.ts'
import { occurrenceKey }   from '@frontierjs/toolbelt/history'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const DAY = 24 * 60 * 60 * 1000

const got = {}
const t = (label, value) => { got[label] = value }

/** The sweep's dispatcher, recording rather than queueing. See the header. */
function recorder() {
  const seen = []
  return {
    seen,
    ctx: { app: { jobs: { dispatch: async (_job, payload, opts) => {
      // A second dispatch under an id already taken is a no-op, which is what
      // caravan's `dispatch({ id })` does with a taken primary key. Modeling
      // that here is the difference between asserting the sweep is idempotent
      // and asserting it merely runs.
      if (seen.some(s => s.id === opts?.id)) return false
      seen.push({ id: opts?.id, payload })
      return true
    } } } },
  }
}

// ─── A subscription of this run's own ─────────────────────────────────────

const customer = await sys.customer.findFirst({ where: { email: 'robin@buyer.test' } })
const plan     = await sys.plan.findFirst({ where: { code: 'PRO' } })
const version  = await sys.planVersion.findFirst({ where: { planId: plan.id, effectiveTo: null } })

// Its period ends in the past, so it is due the moment the sweep looks — which
// is how a month is crossed in a test that takes a second.
const periodStart = new Date(Date.now() - 40 * DAY).toISOString()
const periodEnd   = new Date(Date.now() - 10 * DAY).toISOString()

const sub = await sys.subscription.create({ data: {
  reference:  `SUB-B${RUN}`,
  customerId: customer.id,
  planVersionId: version.id,
  status:     'trialing',
  quantity:   3,
  currentPeriodStart: periodStart,
  currentPeriodEnd:   periodEnd,
  userId:     customer.userId,
} })

const invoicesFor = () => sys.invoice.findMany({ where: { subscriptionId: sub.id }, orderBy: { id: 'asc' } })
const reread      = () => sys.subscription.findFirst({ where: { id: sub.id } })

// ─── 1. The sweep finds it, and the id is the occurrence key ──────────────

{
  const r = recorder()
  const queued = await sweepRenewals({ ...r.ctx, data: { at: new Date().toISOString() } })
  const mine   = r.seen.find(s => s.payload?.subscriptionId === sub.id)
  t('sweep.queuedMine', Boolean(mine))
  t('sweep.idIsOccurrenceKey', mine?.id === occurrenceKey('renew', String(sub.id), periodEnd))
  t('sweep.countedIt', queued >= 1)

  // The same sweep again, same minute, same period. A cron fires in every
  // replica and an operator re-runs a half-finished sweep; both land here.
  const again = await sweepRenewals({ ...r.ctx, data: { at: new Date().toISOString() } })
  t('sweep.secondPassQueuesNothingNew', again === 0)
}

// ─── 2. The renewal issues one document and moves the window ──────────────

const before = (await invoicesFor()).length
const number = await renewSubscription({ data: {
  subscriptionId: sub.id, periodEnd, at: new Date().toISOString(),
} })
const after = await invoicesFor()

t('renew.issuedOne', after.length - before === 1)
t('renew.trialConverted', (await reread()).status === 'active')

const invoice = after[after.length - 1]
const lines   = await sys.invoiceLine.findMany({ where: { invoiceId: invoice.id } })

// The cross-row invariant, which no @@check can see (`FJS-D162`).
t('renew.linesSumToSubtotal', lines.reduce((n, l) => n + l.amount, 0) === invoice.subtotal)
t('renew.headerIdentity', invoice.total === invoice.subtotal + invoice.tax)
// The subscriber is on the version they were sold at, and that is what they are
// charged — which is the whole reason a price is a row with a window.
t('renew.chargedTheSoldPrice', lines[0].unitAmount === version.price && lines[0].quantity === sub.quantity)
t('renew.windowMoved', (await reread()).currentPeriodEnd === advancePeriod(periodEnd, plan.interval).toISOString())
t('renew.dueDateFromTerms',
  Math.round((Date.parse(invoice.dueAt) - Date.parse(invoice.issuedAt)) / DAY) === TERMS_DAYS)

// Running the SAME period again — a queue retry after the transaction committed.
const dup = await renewSubscription({ data: { subscriptionId: sub.id, periodEnd } })
t('renew.replayIssuesNothing', dup === null && (await invoicesFor()).length === after.length)

// ─── 3. The document does not move, for anybody ───────────────────────────

const refused = async (fn) => { try { await fn(); return false } catch { return true } }
// A refusal that cannot be shown to come from the rule it names proves nothing
// (`FJS-351`). Every seal assertion below asks for the CLASS, because a foreign
// key, a gate and a typo in the payload all throw here too — and two of the four
// are operations that were legal until `FJS-D167`, so `refused()` alone would
// have gone green against a version of this that changed nothing.
const refusedBy = async (name, fn) => {
  try { await fn(); return false } catch (e) { return e?.name === name || e?.data?.name === name }
}
t('document.systemCannotRestateTotal',
  await refused(() => sys.invoice.update({ where: { id: invoice.id }, data: { total: 1 } })))
t('document.sameValueAlsoRefused',
  await refused(() => sys.invoice.update({ where: { id: invoice.id }, data: { total: invoice.total } })))
t('document.lineIsFrozenToo',
  await refused(() => sys.invoiceLine.update({ where: { id: lines[0].id }, data: { amount: 1 } })))

// The two operations `@immutable` cannot reach, and the whole of what `@seals`
// added (`FJS-D167`). Every writable column on `InvoiceLine` was already frozen,
// so a line could not be EDITED before this — but one could be ADDED to an
// issued invoice, and one could be taken away, and the header's frozen subtotal
// then disagreed with its own lines with nothing saying so.
//
// Both are asked through `asSystem()` on purpose. That is the client every
// writer in this domain uses — the renewal job has no session — so a rule it may
// drop is a rule absent from the only code that touches these rows.
t('document.noLineMayBeADDEDAfterTheSeal',
  await refusedBy('SealedDocumentError', () => sys.invoiceLine.create({ data: {
    invoiceId: invoice.id, description: 'smuggled', quantity: 1, unitAmount: 100, amount: 100,
  } })))
t('document.noLineMayBeREMOVEDAfterTheSeal',
  await refusedBy('SealedDocumentError', () => sys.invoiceLine.delete({ where: { id: lines[0].id } })))
// The negative control, and it is the one that makes the two above mean
// anything: a payment against an issued invoice is exactly the row that must
// keep arriving, and `payments` carries no `@sealed`.
t('document.aPaymentStillReachesASealedInvoice',
  !await refused(() => sys.payment.create({ data: {
    invoiceId: invoice.id, amount: invoice.total, currency: 'USD', status: 'pending',
    provider: 'dev', providerRef: `seal-${Date.now()}`,
  } })))
// And the subtotal still equals its lines, which is the invariant the seal
// exists to make checkable-once rather than checked-forever.
t('document.linesStillSumAfterAllThat',
  (await sys.invoiceLine.findMany({ where: { invoiceId: invoice.id } }))
    .reduce((n, l) => n + l.amount, 0) === invoice.subtotal)

// ─── 4. The deadline ──────────────────────────────────────────────────────
//
// Scoped to this run's own subscription. Without it the far-future instants
// below grade the whole book, so the drive cancels the seeded subscription as
// collateral and the shop's own screens change every time it runs. The
// parameter is an operator's before it is a drive's — see the job.
//
// Every step stands at an instant measured from the invoice's OWN due date,
// which is the only anchor dunning reads — no counter is kept anywhere, so
// running the job twice at the same instant has to be the same answer.

const at = (days) => new Date(Date.parse(invoice.dueAt) + days * DAY).toISOString()

{
  const r1 = await dunSubscriptions({ data: { subscriptionId: sub.id, at: at(GRACE_DAYS - 1) } })
  t('dunning.insideGraceDoesNothing',
    !r1.lapsed.includes(sub.reference) && (await reread()).status === 'active')

  const r2 = await dunSubscriptions({ data: { subscriptionId: sub.id, at: at(GRACE_DAYS + 1) } })
  t('dunning.pastGraceLapses', r2.lapsed.includes(sub.reference) && (await reread()).status === 'pastDue')

  // Twice at the same instant. A counter-based design gives a different answer
  // here, and that is the whole reason there is no counter.
  const r3 = await dunSubscriptions({ data: { subscriptionId: sub.id, at: at(GRACE_DAYS + 1) } })
  t('dunning.isIdempotent', r3.lapsed.length === 0 && (await reread()).status === 'pastDue')
}

// The money arrives. Nothing tells dunning — it reads the ledger.
// Through `settleInvoice`, which is the one owner of the two writes a payment
// makes: the transition, and the `@system` date beside it.
await settleInvoice(sys, invoice.id)
{
  const paid = (await invoicesFor()).find(i => i.id === invoice.id)
  // A transition moves one column, and a payment is two facts. Settling with
  // the transition alone left every paid invoice in this app with no payment
  // date, in three separate copies of the same two lines.
  t('settle.stampsPaidAt', paid.status === 'paid' && Boolean(paid.paidAt))

  const r = await dunSubscriptions({ data: { subscriptionId: sub.id, at: at(GRACE_DAYS + 2) } })
  t('dunning.recoversWhenLedgerIsClean',
    r.recovered.includes(sub.reference) && (await reread()).status === 'active')
}

// A second period goes unpaid, all the way past the deadline.
const second = await renewSubscription({ data: {
  subscriptionId: sub.id,
  periodEnd: (await reread()).currentPeriodEnd,
  at: new Date().toISOString(),
} })
{
  const unpaid = (await invoicesFor()).find(i => i.number === second)
  const late   = new Date(Date.parse(unpaid.dueAt) + (DUNNING_DAYS + 1) * DAY).toISOString()
  const r = await dunSubscriptions({ data: { subscriptionId: sub.id, at: late } })
  t('dunning.pastDeadlineCancels', r.cancelled.includes(sub.reference) && (await reread()).status === 'cancelled')
}

// A cancelled subscription still owes for the invoice already issued. The
// arrangement stopping and the debt vanishing are different things.
t('dunning.cancellingLeavesTheDebt',
  (await invoicesFor()).some(i => i.status === 'issued'))

// The sweep leaves a cancelled subscription alone.
{
  const r = recorder()
  await sweepRenewals({ ...r.ctx, data: { at: new Date(Date.now() + 400 * DAY).toISOString() } })
  t('sweep.skipsCancelled', !r.seen.some(s => s.payload?.subscriptionId === sub.id))
}

// ─── 5. The boundary ──────────────────────────────────────────────────────
//
// `cancelAtPeriodEnd` is what a person presses and the renewal job is the only
// thing that acts on it. Two subscriptions of this run's own, identical but for
// the flag, because a cancellation asserted alone cannot be told apart from a
// renewal that failed for some other reason — the control is what makes the
// first assertion mean anything.
//
// The flag is written through `asSystem()` here, which is the column's own
// declaration (`@system`) and not a shortcut past the service: what the service
// adds is the gate, the row policies and the refusal on an ended row, and those
// are asked over HTTP and in a browser by `verify:account`. This drive stands
// at an instant with no server, so what it can ask is what the JOB does when it
// arrives at the period end.

const boundaryPeriodEnd = new Date(Date.now() - 5 * DAY).toISOString()

const mkSub = (suffix, cancelAtPeriodEnd) => sys.subscription.create({ data: {
  reference:  `SUB-B${RUN}${suffix}`,
  customerId: customer.id,
  planVersionId: version.id,
  status:     'active',
  quantity:   1,
  currentPeriodStart: new Date(Date.now() - 35 * DAY).toISOString(),
  currentPeriodEnd:   boundaryPeriodEnd,
  userId:     customer.userId,
  cancelAtPeriodEnd,
} })

{
  const stopping = await mkSub('K', true)
  const control  = await mkSub('R', false)

  // A flag is not a state. The row is `active` and running, and that is the
  // whole reason both screens have to SAY what is going to happen: nothing
  // about `status` betrays it, and a person who has just pressed the button
  // would otherwise see no change at all.
  t('boundary.stoppingIsStillActiveUntilTheBoundary',
    stopping.status === 'active' && stopping.cancelAtPeriodEnd === true)

  const stoppedNumber = await renewSubscription({ data: {
    subscriptionId: stopping.id, periodEnd: boundaryPeriodEnd, at: new Date().toISOString(),
  } })
  const stoppedRow = await sys.subscription.findFirst({ where: { id: stopping.id } })
  t('boundary.flaggedEndsAtItsPeriodEnd', stoppedRow.status === 'cancelled')

  // And bills nothing on the way out. A cancellation that still issued the
  // document would be the same shape as no feature at all, one invoice later.
  const stoppedBills = await sys.invoice.findMany({ where: { subscriptionId: stopping.id }, limit: 5 })
  t('boundary.flaggedIsNotInvoiced', stoppedNumber === null && stoppedBills.length === 0)

  // The control: same instant, same job, no flag.
  const keptNumber = await renewSubscription({ data: {
    subscriptionId: control.id, periodEnd: boundaryPeriodEnd, at: new Date().toISOString(),
  } })
  const keptRow = await sys.subscription.findFirst({ where: { id: control.id } })
  t('boundary.unflaggedRenews',
    typeof keptNumber === 'string'
    && keptRow.status === 'active'
    && new Date(keptRow.currentPeriodEnd) > new Date(boundaryPeriodEnd))

  // ─── the guard ordering ───────────────────────────────────────────────
  //
  // The flag is read AFTER the *already advanced* guard, and this is what that
  // buys. The control has just renewed, so its window has moved; flag it and
  // replay the STALE dispatch — a retry the queue delivers twice, or an
  // operator re-running a half-finished sweep. Reading the flag first would
  // cancel a subscription whose next period has already been issued, and
  // possibly paid.
  await sys.subscription.update({ where: { id: control.id }, data: { cancelAtPeriodEnd: true } })
  const replay = await renewSubscription({ data: {
    subscriptionId: control.id, periodEnd: boundaryPeriodEnd, at: new Date().toISOString(),
  } })
  const afterReplay = await sys.subscription.findFirst({ where: { id: control.id } })
  t('boundary.staleDispatchDoesNotEndIt', replay === null && afterReplay.status === 'active')

  // The sweep will bring it back at the RIGHT boundary, which is the next one.
  const r = recorder()
  await sweepRenewals({ ...r.ctx, data: { at: new Date(Date.parse(afterReplay.currentPeriodEnd) + DAY).toISOString() } })
  const requeued = r.seen.find(x => x.payload?.subscriptionId === control.id)
  t('boundary.itIsPickedUpAtTheNextOne',
    requeued?.payload?.periodEnd === afterReplay.currentPeriodEnd)
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
    where: { reference: { startsWith: `SUB-B${RUN}` } }, limit: 50,
  })
  for (const s of minted) {
    const bills = await sys.invoice.findMany({ where: { subscriptionId: s.id }, limit: 100 })
    for (const b of bills) {
      await sys.creditNote.deleteMany({ where: { invoiceId: b.id } })
      await sys.invoice.delete({ where: { id: b.id } })
    }
    await sys.subscription.delete({ where: { id: s.id } })
  }
} catch (e) {
  console.error(`\n!! could not clear up SUB-B${RUN}*: ${e.message}`)
}

const expected = {
  'sweep.queuedMine': true,
  'sweep.idIsOccurrenceKey': true,
  'sweep.countedIt': true,
  'sweep.secondPassQueuesNothingNew': true,
  'renew.issuedOne': true,
  'renew.trialConverted': true,
  'renew.linesSumToSubtotal': true,
  'renew.headerIdentity': true,
  'renew.chargedTheSoldPrice': true,
  'renew.windowMoved': true,
  'renew.dueDateFromTerms': true,
  'renew.replayIssuesNothing': true,
  'document.systemCannotRestateTotal': true,
  'document.sameValueAlsoRefused': true,
  'document.lineIsFrozenToo': true,
  'document.noLineMayBeADDEDAfterTheSeal': true,
  'document.noLineMayBeREMOVEDAfterTheSeal': true,
  'document.aPaymentStillReachesASealedInvoice': true,
  'document.linesStillSumAfterAllThat': true,
  'dunning.insideGraceDoesNothing': true,
  'dunning.pastGraceLapses': true,
  'dunning.isIdempotent': true,
  'settle.stampsPaidAt': true,
  'dunning.recoversWhenLedgerIsClean': true,
  'dunning.pastDeadlineCancels': true,
  'dunning.cancellingLeavesTheDebt': true,
  'sweep.skipsCancelled': true,
  'boundary.stoppingIsStillActiveUntilTheBoundary': true,
  'boundary.flaggedEndsAtItsPeriodEnd': true,
  'boundary.flaggedIsNotInvoiced': true,
  'boundary.unflaggedRenews': true,
  'boundary.staleDispatchDoesNotEndIt': true,
  'boundary.itIsPickedUpAtTheNextOne': true,
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
