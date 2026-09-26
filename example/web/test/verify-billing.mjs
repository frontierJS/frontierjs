/**
 * web/test/verify-billing.mjs — the recurring half: the clock, the document
 * and the deadline.
 *
 * **bun, and no server.** Everything here is a fact about the Data boundary and
 * the commitments that drive it, reached the way the queue reaches them. A
 * renewal is a period CLOSING (`FJS-D367`): `SubscriptionPeriod`'s
 * `@@commitment(close, on: endsOn)` owes the move, and the hook in
 * `api/src/core/commitments.ts` issues the invoice and opens the next period in
 * the same transaction (`FJS-D368`). Standing an API up would add a transport
 * to a drive that asserts nothing about one, and would put this on the login
 * limiter for no reason (`verify:tenants` runs under bun for the same reason).
 *
 * ─── What it is actually asking ───────────────────────────────────────────
 *
 * A billing cycle is unobservable in a normal test run: the interesting instant
 * is a month away. So the fixtures are STARTED in the past — a first period
 * two hundred days back — and every renewal it asks for is already due on the
 * real clock. Nothing here passes a fake instant, so there is no second path.
 *
 * ─── The one thing that is stubbed, and why ───────────────────────────────
 *
 * A period is fired through junction's own `fireCommitment` — the plugin's
 * path, re-derivation and transaction included — on a client scoped to the
 * shop's `SYSTEM` principal, which is what `commitments()` hands it. The hook
 * dispatches the collection after the commit into `app.jobs`, and there is no
 * app here, so a recorder stands in for the queue and the collection itself is
 * `verify:collect`'s, which runs the whole chain against a started app.
 *
 * Every fixture is minted under a per-run prefix (`FJS-530`, `FJS-546`): a
 * subscription reference and an invoice number are both `@unique`, and a drive
 * that reuses one passes exactly once per seed.
 */

import { db }              from '../../api/src/core/db.ts'
import { SYSTEM }          from '../../api/src/core/gate.ts'
import { commitmentHooks } from '../../api/src/core/commitments.ts'
import { advancePeriod, settleInvoice, voidInvoice, startSubscription, DUNNING_DAYS, GRACE_DAYS, TERMS_DAYS } from '../../api/src/domain/billing'
import { fireCommitment }  from '@frontierjs/junction'
import { plainDateIn, addToDate, daysBetween, startOfDay } from '@frontierjs/toolbelt/datetime'
import { results, report } from './lib/report.mjs'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)

const { got, t } = results()

/** The queue the hook dispatches the collection into, recording. See the header. */
const queued = []
const hooks  = commitmentHooks(() => ({ dispatch: (_job, payload) => { queued.push(payload) } }))

/** The shop's own principal, as `commitments()` scopes a fire. */
const shop = db.$setAuth(SYSTEM)

/** Fire one period's close, exactly as the plugin does. Answers 'fired' or
 *  'lapsed' — or says there was no period, so a renewal that failed to open one
 *  fails the assertions after it by name rather than crashing the report. */
const fire = async (period) => !period ? 'no open period' : fireCommitment(shop, {
  accessor: 'subscriptionPeriod', transition: 'close', id: period.id, dueAt: period.endsOn, timeZone: 'UTC',
}, { hooks })

const openPeriod = (subscriptionId) =>
  sys.subscriptionPeriod.findFirst({ where: { subscriptionId, status: 'open' } })

// ─── A subscription of this run's own ─────────────────────────────────────

const customer = await sys.customer.findFirst({ where: { email: 'robin@buyer.test' } })
const plan     = await sys.plan.findFirst({ where: { code: 'PRO' } })
const version  = await sys.planVersion.findFirst({ where: { planId: plan.id, effectiveTo: null } })

// Its first period ended long ago, so it and the four after it are due the
// moment anything looks — which is how months are crossed in a test that takes
// a second. A period is DAYS in the shop's calendar (`FJS-D143`), so the
// fixtures are plain dates and the instants below are built from them.
const TODAY       = plainDateIn(Date.now(), 'UTC')
const dayOf       = (date) => new Date(startOfDay(date, 'UTC')).toISOString()
const periodStart = addToDate(TODAY, { days: -230 })
const periodEnd   = addToDate(TODAY, { days: -200 })

const sub = await startSubscription(sys, {
  reference:  `SUB-B${RUN}`,
  customerId: customer.id,
  planVersionId: version.id,
  status:     'trialing',
  quantity:   3,
  userId:     customer.userId,
}, { startsOn: periodStart, endsOn: periodEnd })

const invoicesFor = () => sys.invoice.findMany({ where: { subscriptionId: sub.id }, orderBy: { id: 'asc' } })
const reread      = () => sys.subscription.findFirst({ where: { id: sub.id } })

// A refusal that cannot be shown to come from the rule it names proves nothing
// (`FJS-351`), so the seal and constraint assertions below ask for the CLASS:
// a foreign key, a gate and a typo in the payload all throw here too.
const refusedBy = async (name, fn) => {
  try { await fn(); return false } catch (e) { return e?.name === name || e?.data?.name === name }
}

// ─── 1. The period is owed its close, at its end ──────────────────────────

const first = await openPeriod(sub.id)
{
  const owed = await sys.subscriptionPeriod.due({ timeZone: 'UTC', where: { id: first.id } })
  t('close.owedAtItsEnd', owed.length === 1 && owed[0].dueAt === periodEnd)

  // The database, not the code that happens to write periods, says one open
  // period per subscription — so a replay or a crash between two writes cannot
  // leave a stretch of days billed twice.
  t('period.oneOpenPerSubscription', await refusedBy('UniqueConflictError', () =>
    sys.subscriptionPeriod.create({ data: { subscriptionId: sub.id, startsOn: periodEnd, endsOn: TODAY } })))
}

// ─── 2. Closing it issues one document and opens the next period ──────────

const before = (await invoicesFor()).length
t('close.fired', await fire(first) === 'fired')
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
t('renew.windowMoved', (await reread()).currentPeriodEnd === advancePeriod(periodEnd, plan.interval))
{
  const periods = await sys.subscriptionPeriod.findMany({ where: { subscriptionId: sub.id }, orderBy: { startsOn: 'asc' } })
  t('renew.periodClosedAndNextOpened',
    periods.length === 2 && periods[0].status === 'closed' && periods[1].status === 'open' && periods[1].startsOn === periodEnd)
}
// Presented AFTER the commit, as its own job — once.
t('renew.collectionQueuedOnce', queued.filter(q => q.invoiceId === after[after.length - 1].id).length === 1)
t('renew.dueDateFromTerms',
  daysBetween(plainDateIn(invoice.issuedAt, 'UTC'), invoice.dueOn) === TERMS_DAYS)
// The period is a pair of DAYS, and the invoice charges for the one the
// subscription had reached. A row holding an instant here reads as a date to
// every screen and to `describeSpan` and is one somewhere else.
t('renew.periodIsPlainDates',
  invoice.periodStart === periodEnd && invoice.periodEnd === advancePeriod(periodEnd, plan.interval))

// Firing the SAME period again — a queue retry after the transaction
// committed. The period is `closed`, so it owes nothing: the state machine is
// the once-ness, with no key.
t('renew.replayIssuesNothing', await fire(first) === 'lapsed' && (await invoicesFor()).length === after.length)

// ─── 3. The document does not move, for anybody ───────────────────────────

const refused = async (fn) => { try { await fn(); return false } catch { return true } }
// Two of the four seal refusals below are operations that were legal until
// `FJS-D167`, so `refused()` alone would have gone green against a version of
// this that changed nothing — they ask `refusedBy` for the class.
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

// ─── 4. The deadline, and the way back ────────────────────────────────────
//
// The deadline is DECLARED — `@@commitment(subscription.lapse, …)` and
// `subscription.cancel` on `Invoice` — and junction's `commitments()` makes the
// move. That needs an app and a queue, so `verify:jobs` runs the sweep against
// the live API. What is asked here is the half no clock is needed for: that the
// terms are frozen onto the document, that `due()` answers the deadline from
// them, and that a ledger coming clean brings a lapsed subscription back the
// moment it clears (`FJS-D363`) — with nothing run afterwards.
//
// Where a lapse or a cancel is needed to stand on, it is made the way the fire
// makes it, `{ system: true }` on the move, and says so.

const at   = (days) => dayOf(addToDate(invoice.dueOn, { days }))
// The subscription's moves. The invoice's own `remind` is graded on its own.
const owed = async (inv, by) =>
  (await sys.invoice.due({ by, where: { id: inv.id } }))
    .map(d => d.transition).filter(n => n !== 'remind').sort().join(',')
const reminds = async (inv, by) =>
  (await sys.invoice.due({ by, transition: 'remind', where: { id: inv.id } })).length === 1
const lapse = () => sys.subscription.transition(sub.id, 'lapse', { system: true })

t('dunning.termsFrozenOnTheDocument',
  invoice.graceDays === GRACE_DAYS && invoice.dunningDays === DUNNING_DAYS)
// The reminder, three days before the due date and not a day sooner.
t('reminder.owedThreeDaysBefore', { before: await reminds(invoice, at(-4)), on: await reminds(invoice, at(-3)) })
t('dunning.insideGraceOwesNothing', await owed(invoice, at(GRACE_DAYS - 1)) === '')
t('dunning.pastGraceOwesTheLapse',  await owed(invoice, at(GRACE_DAYS + 1)) === 'subscription.lapse')
t('dunning.pastDeadlineOwesTheCancel',
  await owed(invoice, at(DUNNING_DAYS + 1)) === 'subscription.cancel,subscription.lapse')

// Once the subscription has moved, the same invoice owes it nothing — which is
// what lets the later of two unpaid invoices meet a lapse already made.
await lapse()
t('dunning.aMoveMadeIsNotOwedAgain', await owed(invoice, at(GRACE_DAYS + 1)) === '')

// The money arrives. Through `settleInvoice`, the one owner of the two writes a
// payment makes — and of what a clean ledger owes the subscription behind it.
await settleInvoice(sys, invoice.id)
{
  const paid = (await invoicesFor()).find(i => i.id === invoice.id)
  // A transition moves one column, and a payment is two facts. Settling with
  // the transition alone left every paid invoice in this app with no payment
  // date, in three separate copies of the same two lines.
  t('settle.stampsPaidAt', paid.status === 'paid' && Boolean(paid.paidAt))
  t('dunning.settleRecovers', (await reread()).status === 'active')
  t('dunning.aPaidInvoiceOwesNothing', await owed(invoice, at(DUNNING_DAYS + 1)) === '')
}

// Two periods go unpaid. *No issued invoice remains* is the rule, not *this
// invoice was paid*: settling one of two leaves the subscription where it is,
// and VOIDING the other clears the ledger as surely as a payment would.
const renewNow = async () => {
  await fire(await openPeriod(sub.id))
  return (await invoicesFor()).at(-1)?.number
}
{
  const second = await renewNow()
  const third  = await renewNow()
  await lapse()
  const byNumber = async (n) => (await invoicesFor()).find(i => i.number === n)

  await settleInvoice(sys, (await byNumber(second)).id)
  t('dunning.oneOfTwoPaidStaysPastDue', (await reread()).status === 'pastDue')

  await voidInvoice(sys, (await byNumber(third)).id)
  t('dunning.voidRecoversToo', (await reread()).status === 'active')
}

// A cancelled subscription still owes for the invoice already issued. The
// arrangement stopping and the debt vanishing are different things.
await renewNow()
await sys.subscription.transition(sub.id, 'cancel', { system: true })
t('dunning.cancellingLeavesTheDebt',
  (await invoicesFor()).some(i => i.status === 'issued'))

// A cancelled subscription's period still closes at its end — the days were
// paid for — and nothing follows it.
{
  const billed = (await invoicesFor()).length
  t('close.cancelledEndsTheChain', await fire(await openPeriod(sub.id)) === 'fired'
    && (await invoicesFor()).length === billed && !(await openPeriod(sub.id)))
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

const boundaryPeriodEnd = addToDate(TODAY, { days: -5 })

const mkSub = (suffix, cancelAtPeriodEnd) => startSubscription(sys, {
  reference:  `SUB-B${RUN}${suffix}`,
  customerId: customer.id,
  planVersionId: version.id,
  status:     'active',
  quantity:   1,
  userId:     customer.userId,
  cancelAtPeriodEnd,
}, { startsOn: addToDate(TODAY, { days: -35 }), endsOn: boundaryPeriodEnd })

{
  const stopping = await mkSub('K', true)
  const control  = await mkSub('R', false)

  // A flag is not a state. The row is `active` and running, and that is the
  // whole reason both screens have to SAY what is going to happen: nothing
  // about `status` betrays it, and a person who has just pressed the button
  // would otherwise see no change at all.
  t('boundary.stoppingIsStillActiveUntilTheBoundary',
    stopping.status === 'active' && stopping.cancelAtPeriodEnd === true)

  await fire(await openPeriod(stopping.id))
  const stoppedRow = await sys.subscription.findFirst({ where: { id: stopping.id } })
  t('boundary.flaggedEndsAtItsPeriodEnd', stoppedRow.status === 'cancelled')

  // And bills nothing on the way out. A cancellation that still issued the
  // document would be the same shape as no feature at all, one invoice later.
  const stoppedBills = await sys.invoice.findMany({ where: { subscriptionId: stopping.id }, limit: 5 })
  t('boundary.flaggedIsNotInvoiced', stoppedBills.length === 0 && !(await openPeriod(stopping.id)))

  // The control: same instant, same job, no flag.
  const controlFirst = await openPeriod(control.id)
  await fire(controlFirst)
  const keptRow   = await sys.subscription.findFirst({ where: { id: control.id } })
  const keptBills = await sys.invoice.findMany({ where: { subscriptionId: control.id }, limit: 5 })
  t('boundary.unflaggedRenews',
    keptBills.length === 1
    && keptRow.status === 'active'
    && keptRow.currentPeriodEnd > boundaryPeriodEnd)

  // ─── the guard ordering ───────────────────────────────────────────────
  //
  // The control has just renewed; flag it and replay the STALE fire — a retry
  // the queue delivers twice. The flag is read only by a period that is still
  // owed its close, and this one is closed, so a subscription whose next
  // period has already been issued, and possibly paid, is not ended by it.
  await sys.subscription.update({ where: { id: control.id }, data: { cancelAtPeriodEnd: true } })
  const replay      = await fire(controlFirst)
  const afterReplay = await sys.subscription.findFirst({ where: { id: control.id } })
  t('boundary.staleDispatchDoesNotEndIt', replay === 'lapsed' && afterReplay.status === 'active')

  // It comes back at the RIGHT boundary, which is the next one.
  const next = await openPeriod(control.id)
  const owed = await sys.subscriptionPeriod.due({
    by: dayOf(addToDate(afterReplay.currentPeriodEnd, { days: 1 })), timeZone: 'UTC', where: { id: next?.id ?? -1 } })
  t('boundary.itIsPickedUpAtTheNextOne', owed[0]?.dueAt === afterReplay.currentPeriodEnd)
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
    await sys.subscriptionPeriod.deleteMany({ where: { subscriptionId: s.id } })
    await sys.subscription.delete({ where: { id: s.id } })
  }
} catch (e) {
  console.error(`\n!! could not clear up SUB-B${RUN}*: ${e.message}`)
}

const expected = {
  'close.owedAtItsEnd': true,
  'period.oneOpenPerSubscription': true,
  'close.fired': true,
  'renew.issuedOne': true,
  'renew.trialConverted': true,
  'renew.linesSumToSubtotal': true,
  'renew.headerIdentity': true,
  'renew.chargedTheSoldPrice': true,
  'renew.windowMoved': true,
  'renew.periodClosedAndNextOpened': true,
  'renew.collectionQueuedOnce': true,
  'renew.dueDateFromTerms': true,
  'renew.periodIsPlainDates': true,
  'renew.replayIssuesNothing': true,
  'document.systemCannotRestateTotal': true,
  'document.sameValueAlsoRefused': true,
  'document.lineIsFrozenToo': true,
  'document.noLineMayBeADDEDAfterTheSeal': true,
  'document.noLineMayBeREMOVEDAfterTheSeal': true,
  'document.aPaymentStillReachesASealedInvoice': true,
  'document.linesStillSumAfterAllThat': true,
  'dunning.termsFrozenOnTheDocument': true,
  'reminder.owedThreeDaysBefore':     { before: false, on: true },
  'dunning.insideGraceOwesNothing': true,
  'dunning.pastGraceOwesTheLapse': true,
  'dunning.pastDeadlineOwesTheCancel': true,
  'dunning.aMoveMadeIsNotOwedAgain': true,
  'settle.stampsPaidAt': true,
  'dunning.settleRecovers': true,
  'dunning.aPaidInvoiceOwesNothing': true,
  'dunning.oneOfTwoPaidStaysPastDue': true,
  'dunning.voidRecoversToo': true,
  'dunning.cancellingLeavesTheDebt': true,
  'close.cancelledEndsTheChain': true,
  'boundary.stoppingIsStillActiveUntilTheBoundary': true,
  'boundary.flaggedEndsAtItsPeriodEnd': true,
  'boundary.flaggedIsNotInvoiced': true,
  'boundary.unflaggedRenews': true,
  'boundary.staleDispatchDoesNotEndIt': true,
  'boundary.itIsPickedUpAtTheNextOne': true,
}

process.exit(report(got, expected))
