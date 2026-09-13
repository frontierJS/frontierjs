/**
 * web/test/verify-proration.mjs — a change mid-cycle, and the penny.
 *
 * **bun, no server**, for `verify-billing.mjs`'s reason: everything here is a
 * fact about arithmetic and the Data boundary, and standing an API up would add
 * a transport that none of it is about.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * Three roundings happen in one change — the credit for time not used, the
 * charge for time not yet used, and the split of that charge across the units
 * being paid for — and the third is the one nobody writes correctly by hand.
 * Dividing a charge by the seat count and writing the same number on every line
 * gives numbers that are each plausible and that do not add up to what was
 * taken. So the assertions here are SUMS, not lines: a drive that checked each
 * line against a hand-computed figure would agree with the bug.
 *
 * The headline is `proration.naiveSplitWouldBeShort` — a real case, found by
 * sweeping seat counts and prices, where the obvious implementation is two
 * minor units out. If `allocate` is ever replaced by a division, that assertion
 * is what fails.
 *
 * Fixtures are per-run (`FJS-530`, `FJS-546`).
 */

import { db }         from '../../api/src/core/db.ts'
import { prorate, changePlan, issueInvoice, periodLines } from '../../api/src/domain/billing'
import { allocate }   from '@frontierjs/toolbelt/units'
import { results, report } from './lib/report.mjs'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const DAY = 24 * 60 * 60 * 1000

const { got, t } = results()

// ─── The pure half ────────────────────────────────────────────────────────

{
  // 19 days left of a 30-day period, six seats at 9.99. The charge is 3796 and
  // 3796/6 is 632.67 — six lines of 633 is 3798, six of 632 is 3792, and the
  // shop has taken 3796.
  const p = prorate({
    periodStart: '2026-03-01T00:00:00Z',
    periodEnd:   '2026-03-31T00:00:00Z',
    at:          '2026-03-12T00:00:00Z',
    name: 'Pro',
    from: { unitAmount: 0,   quantity: 0 },
    to:   { unitAmount: 999, quantity: 6 },
  })

  const lines = p.lines.reduce((n, l) => n + l.amount, 0)
  const naive = Math.round(p.charge / 6) * 6

  t('proration.linesSumToTheCharge', lines === p.charge)
  t('proration.naiveSplitWouldBeShort', naive !== p.charge)
  // Every seat within one unit of every other — a split that summed correctly
  // by putting the whole remainder on one line would pass the line above.
  const seats = p.lines.map(l => l.amount)
  t('proration.everySeatWithinOneUnit', Math.max(...seats) - Math.min(...seats) <= 1)
  t('proration.fractionIsByInstant', Math.abs(p.fraction - 19 / 30) < 1e-9)
}

{
  // The credit and the charge are the two other roundings, and a change that
  // swaps one price for another at the same quantity is where they meet.
  const p = prorate({
    periodStart: '2026-03-01T00:00:00Z',
    periodEnd:   '2026-03-31T00:00:00Z',
    at:          '2026-03-19T00:00:00Z',
    name: 'Pro',
    from: { unitAmount: 1900, quantity: 2 },
    to:   { unitAmount: 2400, quantity: 3 },
  })
  t('proration.netIsChargeMinusCredit', p.net === p.charge - p.credit)
  t('proration.everyLineSumsToNet', p.lines.reduce((n, l) => n + l.amount, 0) === p.net)
  t('proration.creditLineIsNegative', p.lines[0].amount < 0)
}

{
  // The clamps. A change dated outside the period is a data error somewhere
  // upstream, and the answer has to be a bounded one rather than a negative
  // fraction quietly inverting every figure.
  const base = { periodStart: '2026-03-01T00:00:00Z', periodEnd: '2026-03-31T00:00:00Z',
                 name: 'Pro', from: { unitAmount: 0, quantity: 0 }, to: { unitAmount: 1000, quantity: 1 } }
  t('proration.beforeTheStartIsAWholePeriod', prorate({ ...base, at: '2026-01-01T00:00:00Z' }).fraction === 1)
  t('proration.afterTheEndIsNothing',        prorate({ ...base, at: '2026-12-01T00:00:00Z' }).fraction === 0)
}

{
  // `allocate` is asked directly for the property the whole file rests on,
  // because a drive that only ever sees one split proves one split.
  let worst = 0
  for (let charge = 1; charge <= 400; charge++) {
    for (let seats = 1; seats <= 9; seats++) {
      const parts = allocate(charge, Array.from({ length: seats }, () => 1))
      if (parts.reduce((a, b) => a + b, 0) !== charge) worst++
    }
  }
  t('proration.allocateNeverLosesAUnit', worst === 0)
}

// ─── Through the Data boundary ────────────────────────────────────────────

const customer = await sys.customer.findFirst({ where: { email: 'robin@buyer.test' } })
const plan     = await sys.plan.findFirst({ where: { code: 'PRO' } })
const versions = await sys.planVersion.findMany({ where: { planId: plan.id }, orderBy: { price: 'asc' } })
const cheap    = versions[0]
const dear     = versions[versions.length - 1]

const periodStart = new Date(Date.now() - 10 * DAY).toISOString()
const periodEnd   = new Date(Date.now() + 20 * DAY).toISOString()

const sub = await sys.subscription.create({ data: {
  reference:  `SUB-P${RUN}`,
  customerId: customer.id,
  planVersionId: cheap.id,
  status:     'active',
  quantity:   2,
  currentPeriodStart: periodStart,
  currentPeriodEnd:   periodEnd,
  userId:     customer.userId,
} })

// It needs a document to correct before a downgrade can credit anything.
await issueInvoice(sys, {
  number:         `INV-P${RUN}`,
  customerId:     customer.id,
  subscriptionId: sub.id,
  userId:         customer.userId,
  periodStart, periodEnd,
  lines: periodLines({ name: plan.name, quantity: 2, unitAmount: cheap.price, periodStart, periodEnd }),
})

const invoicesFor = () => sys.invoice.findMany({ where: { subscriptionId: sub.id }, orderBy: { id: 'asc' } })
const notesFor    = async () => {
  const ids = (await invoicesFor()).map(i => i.id)
  return await sys.creditNote.findMany({ where: { invoiceId: { in: ids } } })
}

const periodOf = async (id) => {
  const s = await sys.subscription.findFirst({ where: { id } })
  return [Date.parse(s.currentPeriodStart), Date.parse(s.currentPeriodEnd)]
}

// UPGRADE — more seats, dearer plan. Owes money, so it is an invoice.
{
  const before = (await invoicesFor()).length
  const window = await periodOf(sub.id)
  const r = await changePlan(sys, sub.id, { planVersionId: dear.id, quantity: 5 })
  // The control for `interval.*` below: a same-interval change is a slice of the
  // period it happens in and must leave that period where it was.
  t('upgrade.periodDoesNotMove', String(await periodOf(sub.id)) === String(window))
  const after = await invoicesFor()
  const doc   = after[after.length - 1]
  const lines = await sys.invoiceLine.findMany({ where: { invoiceId: doc.id } })

  t('upgrade.issuesAnInvoice', r.kind === 'invoice' && after.length - before === 1)
  t('upgrade.linesSumToSubtotal', lines.reduce((n, l) => n + l.amount, 0) === doc.subtotal)
  t('upgrade.subtotalIsTheNet', doc.subtotal === r.net)
  t('upgrade.movedTheArrangement', await (async () => {
    const s = await sys.subscription.findFirst({ where: { id: sub.id } })
    return s.planVersionId === dear.id && s.quantity === 5
  })())
  // A seat line per seat, plus the credit for the two seats already paid for.
  t('upgrade.oneLinePerSeatPlusCredit', lines.filter(l => l.amount > 0).length === 5 && lines.some(l => l.amount < 0))
}

// DOWNGRADE — fewer seats. Owed money, so it is a credit note, and the reason
// is the SCHEMA: `Invoice.subtotal` is `@gte(0)`.
{
  const beforeNotes = (await notesFor()).length
  const beforeInv   = (await invoicesFor()).length
  const r = await changePlan(sys, sub.id, { quantity: 1 })
  t('downgrade.writesACreditNote', r.kind === 'credit-note' && (await notesFor()).length - beforeNotes === 1)
  t('downgrade.writesNoInvoice', (await invoicesFor()).length === beforeInv)
  t('downgrade.creditIsPositiveOnTheNote', (await notesFor()).every(n => n.amount > 0))
  t('downgrade.stillMovedTheArrangement',
    (await sys.subscription.findFirst({ where: { id: sub.id } })).quantity === 1)
}

// A negative document is refused by the boundary and not by a branch — the
// assertion that keeps the rule above honest if somebody ever "simplifies" it.
{
  let refused = false
  try {
    await sys.invoice.create({ data: {
      number: `INV-NEG${RUN}`, customerId: customer.id, subtotal: -100, tax: 0, total: -100,
      periodStart, periodEnd,
    } })
  } catch { refused = true }
  t('document.negativeSubtotalRefused', refused)
}

// A change worth nothing writes nothing. A zero invoice is a document saying a
// customer was charged nothing, which is a different claim from no charge.
{
  const before = (await invoicesFor()).length + (await notesFor()).length
  const r = await changePlan(sys, sub.id, { quantity: 1 })
  t('noop.writesNoDocument', r.kind === 'none' && (await invoicesFor()).length + (await notesFor()).length === before)
}

// INTERVAL — monthly to yearly, mid-period (`FJS-1103`). Prorating the yearly
// price over the rest of the month charges half a year for half a month, and
// renewal at the old end charges the year again. A change of interval is a new
// period: credit the unused month, charge one whole year from the change.
const yearlyPlan = await sys.plan.findFirst({ where: { code: 'PROYEAR' } })
const yearly     = await sys.planVersion.findFirst({ where: { planId: yearlyPlan.id } })

const annual = await sys.subscription.create({ data: {
  reference:  `SUB-P${RUN}Y`,
  customerId: customer.id,
  planVersionId: cheap.id,
  status:     'active',
  quantity:   2,
  currentPeriodStart: periodStart,
  currentPeriodEnd:   periodEnd,
  userId:     customer.userId,
} })
await issueInvoice(sys, {
  number:         `INV-P${RUN}Y`,
  customerId:     customer.id,
  subscriptionId: annual.id,
  userId:         customer.userId,
  periodStart, periodEnd,
  lines: periodLines({ name: plan.name, quantity: 2, unitAmount: cheap.price, periodStart, periodEnd }),
})
const annualInvoices = () => sys.invoice.findMany({ where: { subscriptionId: annual.id }, orderBy: { id: 'asc' } })

{
  const at = new Date().toISOString()
  const r  = await changePlan(sys, annual.id, { planVersionId: yearly.id, at })
  const docs  = await annualInvoices()
  const doc   = docs[docs.length - 1]
  const lines = await sys.invoiceLine.findMany({ where: { invoiceId: doc.id } })

  // The oracle for the credit is the pure function over the SAME slice, with
  // nothing charged against it — so this row is about which slice, not rounding.
  const unused = prorate({ periodStart, periodEnd, at, name: plan.name,
    from: { unitAmount: cheap.price, quantity: 2 }, to: { unitAmount: 0, quantity: 2 } }).credit
  const end = new Date(at); end.setUTCFullYear(end.getUTCFullYear() + 1)

  t('interval.issuesAnInvoice', r.kind === 'invoice' && docs.length === 2)
  t('interval.linesSumToSubtotal', lines.reduce((n, l) => n + l.amount, 0) === doc.subtotal)
  t('interval.creditsTheUnusedMonth', lines.filter(l => l.amount < 0).reduce((n, l) => n + l.amount, 0) === -unused)
  // The bug charged `yearly.price × 2 × fraction` here — a fraction of a YEAR's
  // price over what was left of a MONTH.
  t('interval.chargesOneWholeYear', lines.filter(l => l.amount > 0).reduce((n, l) => n + l.amount, 0) === yearly.price * 2)
  t('interval.periodIsReanchored', String(await periodOf(annual.id)) === String([Date.parse(at), end.getTime()]))
  t('interval.documentCoversTheYear', Date.parse(doc.periodEnd) === end.getTime())
}

// And back again is refused until renewal, and refused BEFORE anything is
// written — paired with a same-interval change on the same yearly subscription,
// which must still go through, or a refusal of everything would pass.
{
  const before = (await annualInvoices()).length
  let refusal = null
  try { await changePlan(sys, annual.id, { planVersionId: cheap.id }) }
  catch (e) { refusal = e }
  const s = await sys.subscription.findFirst({ where: { id: annual.id } })

  t('interval.yearlyToMonthlyRefused', refusal?.status === 409)
  t('interval.refusalWritesNothing', s.planVersionId === yearly.id && (await annualInvoices()).length === before)

  const r = await changePlan(sys, annual.id, { quantity: 3 })
  t('interval.yearlySeatChangeStillAllowed', r.kind === 'invoice'
    && (await sys.subscription.findFirst({ where: { id: annual.id } })).quantity === 3)
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
    where: { reference: { startsWith: `SUB-P${RUN}` } }, limit: 50,
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
  console.error(`\n!! could not clear up SUB-P${RUN}*: ${e.message}`)
}

const expected = {
  'proration.linesSumToTheCharge': true,
  'proration.naiveSplitWouldBeShort': true,
  'proration.everySeatWithinOneUnit': true,
  'proration.fractionIsByInstant': true,
  'proration.netIsChargeMinusCredit': true,
  'proration.everyLineSumsToNet': true,
  'proration.creditLineIsNegative': true,
  'proration.beforeTheStartIsAWholePeriod': true,
  'proration.afterTheEndIsNothing': true,
  'proration.allocateNeverLosesAUnit': true,
  'upgrade.periodDoesNotMove': true,
  'upgrade.issuesAnInvoice': true,
  'upgrade.linesSumToSubtotal': true,
  'upgrade.subtotalIsTheNet': true,
  'upgrade.movedTheArrangement': true,
  'upgrade.oneLinePerSeatPlusCredit': true,
  'downgrade.writesACreditNote': true,
  'downgrade.writesNoInvoice': true,
  'downgrade.creditIsPositiveOnTheNote': true,
  'downgrade.stillMovedTheArrangement': true,
  'document.negativeSubtotalRefused': true,
  'noop.writesNoDocument': true,
  'interval.issuesAnInvoice': true,
  'interval.linesSumToSubtotal': true,
  'interval.creditsTheUnusedMonth': true,
  'interval.chargesOneWholeYear': true,
  'interval.periodIsReanchored': true,
  'interval.documentCoversTheYear': true,
  'interval.yearlyToMonthlyRefused': true,
  'interval.refusalWritesNothing': true,
  'interval.yearlySeatChangeStillAllowed': true,
}

process.exit(report(got, expected))
