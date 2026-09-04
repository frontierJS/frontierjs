/**
 * web/test/verify-payrun.mjs — one period, everybody, and the two documents.
 *
 * **bun, and no server.** Every claim here is about the Data boundary and
 * `api/src/domain/payroll`; a transport would add nothing and would put this on the
 * login limiter (`verify:billing` and `verify:employment` run under bun for the
 * same reason).
 *
 * ─── The three things only this drive can ask ─────────────────────────────
 *
 * **`share.twelveMonthsSumToTheYear`** — a band table is annual and a payroll
 * is monthly, so something divides, and twelve roundings of `annual / 12` do
 * not sum to `annual`. The negative control is written out: the naive division
 * is short by real money on a salary that does not divide evenly. This is
 * `allocate`'s second caller (`FJS-D154`) and the first one that splits a YEAR
 * across periods rather than a period across seats.
 *
 * **`reprint.aRaiseAfterwardsChangesNothing`** — revert a calculated run, give
 * somebody a raise, recalculate the SAME period, and every figure has to come
 * back identical. That is the whole of what effective dating buys, and it is
 * the one assertion that fails if `calculatePayRun` ever reads `now` instead of
 * the period end.
 *
 * **`invariant.theEmployerLinesDoNotCountTowardNet`** — the complication phase 0
 * found in a real payroll. The rule is *the lines that COUNT sum to net*, not
 * *the lines sum to net*, so whatever spelling the language grows for a
 * cross-row invariant has to admit a predicate over the child.
 *
 * Fixtures are minted per run (`FJS-530`, `FJS-546`): `PayRun.reference` and
 * `Payslip.reference` are both `@unique`.
 */

import { db }                              from '../../api/src/core/db.ts'
import { calculatePayRun, payPayRun, revertPayRun } from '../../api/src/domain/payroll'
import { periodShare }                 from '../../api/src/domain/payroll'
import { allRatesAsAt }                    from '../../api/src/domain/payroll'
import { instant }                         from '../../api/src/domain/payroll'

import { sweepPayroll }                from './payroll-sweep.mjs'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const DAY = 86_400_000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()

const got = {}
const t   = (label, value) => { got[label] = value }
const refused = async (fn) => { try { await fn(); return false } catch { return true } }

// Everything this drive makes is registered here as it is made and swept in the
// `finally` below — **on the failure path too**, which is the run whose
// leftovers are hardest to recognize later. `payroll-sweep.mjs` owns the order
// and the one hatch under the boundary the books need.
const fixtures = { runIds: [], employeeIds: [] }

// **What this drive CHANGES on a row it did not make, so the `finally` can put
// it back.** Declared out here on purpose: a `finally` block is a scope of its
// own and cannot see a `const` declared inside its `try` — `typeof open` there
// answers `'undefined'` and the restore is skipped in silence, which is how
// Dana ended up permanently on twice her salary.
let raised = null
let failedEarly = null

try {

const newRun = async (suffix, extra = {}) => {
  const run = await sys.payRun.create({ data: {
    reference:   `PR-${RUN}${suffix}`,
    periodStart: ago(30), periodEnd: ago(1), payDate: instant(),
    periodsPerYear: 12, periodIndex: 3, ...extra,
  } })
  fixtures.runIds.push(run.id)
  return run
}

// ─── The period share, and `allocate`'s property ──────────────────────────

// The headline. Every share is floored and the leftover units go to the largest
// fractional parts, so the twelve months sum to the year EXACTLY — which a
// division cannot promise and which is real money when it fails.
const AWKWARD = 5_000_000 + 7      // a salary that does not divide by twelve
const shares  = Array.from({ length: 12 }, (_, i) => periodShare(AWKWARD, 12, i))
t('share.twelveMonthsSumToTheYear', shares.reduce((a, b) => a + b, 0) === AWKWARD)
t('share.andTheNaiveDivisionDoesNot',  Math.round(AWKWARD / 12) * 12 !== AWKWARD)
t('share.everyShareIsAWholeMinorUnit', shares.every(Number.isInteger))
// Deterministic: which month carries the extra unit is decided by the ratios,
// not by whichever ran first, so two calculations of one year agree.
t('share.itIsDeterministic',
  JSON.stringify(shares) === JSON.stringify(Array.from({ length: 12 }, (_, i) => periodShare(AWKWARD, 12, i))))
t('share.aCleanSalaryStillDividesCleanly',
  Array.from({ length: 12 }, (_, i) => periodShare(4_800_000, 12, i)).every(s => s === 400_000))

// ─── Calculating a run ────────────────────────────────────────────────────

const runA  = await newRun('A')
const calcA = await calculatePayRun(sys, runA.id)
const rowA  = await sys.payRun.findFirst({ where: { id: runA.id } })

t('run.calculatingMovesItToCalculated', rowA.status === 'calculated')
t('run.itMadePayslips',                 calcA.payslips >= 2)

// The leaver is not paid. `employedAt` is what separates *employed* from
// *having an open pay window* — phase 2's finding, met here where it matters.
const wren  = await sys.employee.findFirst({ where: { reference: 'EMP-1003' } })
const slips = await sys.payslip.findMany({ where: { payRunId: runA.id } })
t('run.somebodyWhoHasLeftIsNotPaid', !slips.some(s => s.employeeId === wren.id))
t('run.onePayslipPerPersonPerRun',
  new Set(slips.map(s => s.employeeId)).size === slips.length)

// A second calculation is refused rather than doubling the payslips — the
// transition is `draft -> calculated`, so the state machine is what stops it
// and no code here checks anything.
t('run.aSecondCalculationIsRefused', await refused(() => calculatePayRun(sys, runA.id)))

// ─── The arithmetic, per payslip ──────────────────────────────────────────

const slipA  = slips[0]
const linesA = await sys.payslipLine.findMany({ where: { payslipId: slipA.id }, orderBy: { id: 'asc' } })
const counting = linesA.filter(l => l.counts)
const employer = linesA.filter(l => !l.counts)

t('invariant.theCountedLinesSumToNet',
  counting.reduce((n, l) => n + l.amount, 0) === slipA.net)
t('invariant.theEmployerLinesSumToTheEmployerCost',
  employer.reduce((n, l) => n + l.amount, 0) === slipA.employerCost)
// The complication a designed payroll does not have. If every line counted,
// the sum would be net PLUS the employer's contributions — a number nobody is
// paid and nobody owes.
t('invariant.theEmployerLinesDoNotCountTowardNet',
  employer.length > 0 && linesA.reduce((n, l) => n + l.amount, 0) !== slipA.net)
t('invariant.andTheEmployerCostIsNotInTheNet',
  slipA.net === slipA.gross - slipA.deductions && slipA.employerCost > 0)

// Every line traces back to the row that decided it: a band id where a band
// produced it, null for basic pay, which comes from a pay window.
t('lines.aBandLineNamesItsRate',   linesA.filter(l => l.kind === 'incomeTax').every(l => l.rateId != null))
t('lines.basicPayNamesNoRate',     linesA.find(l => l.kind === 'basicPay')?.rateId === null)

// The declarable half of the invariant, asked at the boundary. `@@check` sees
// three columns of one row, so SQLite holds it — against `asSystem()` too.
t('document.theSingleRowCheckIsHeldByTheDatabase',
  await refused(() => sys.payslip.create({ data: {
    reference: `PS-BAD-${RUN}`, payRunId: runA.id, employeeId: slipA.employeeId,
    payWindowId: slipA.payWindowId, periodStart: ago(30), periodEnd: ago(1),
    gross: 1000, deductions: 100, net: 999, employerCost: 0,
  } })))

// ─── The document ─────────────────────────────────────────────────────────

t('document.aPayslipCannotBeRestated',
  await refused(() => sys.payslip.update({ where: { id: slipA.id }, data: { net: 1 } })))
// Delete is `8`, not `9`, and the difference is exactly what `revert` costs:
// the SYSTEM may remove a payslip line because taking a calculated run back to
// draft has to, and no caller may, at any level this shop has. What stops a
// PAID run's payslips being removed is not the gate — it cannot be, since a
// gate is per model — but `revertPayRun` refusing on state.
t('document.noCallerMayDeleteALine',
  await refused(() => db.$setAuth({ id: 'drive-admin', role: 'admin' })
    .payslipLine.delete({ where: { id: linesA[0].id } })))
t('document.norMayOneUpdateAPayslipAtAnyLevel',
  await refused(() => db.$setAuth({ id: 'drive-admin', role: 'admin' })
    .payslip.update({ where: { id: slipA.id }, data: { net: 1 } })))
t('document.aPaidRunCannotBeTakenBack', true) // asserted below, once one is paid
t('document.aLineForNothingIsRefused',
  await refused(() => sys.payslipLine.create({ data: {
    payslipId: slipA.id, kind: 'bonus', description: 'nothing', amount: 0,
  } })))

// ─── Reprinting the past ──────────────────────────────────────────────────

// Revert, raise, recalculate the SAME period. Every figure must come back
// identical, because the run reads its own period end and not `now`.
const before = { gross: slipA.gross, deductions: slipA.deductions, net: slipA.net, window: slipA.payWindowId }

// `revertPayRun` and not a hand-rolled delete: the rule that only a CALCULATED
// run may be taken back is not a gate — a gate is per model and this is per
// state — so it lives in one function and every caller goes through it.
const reverted = await revertPayRun(sys, runA.id)
t('revert.itRemovesThePayslipsItMade', reverted.removed === slips.length)
t('revert.andLeavesNoneBehind',
  (await sys.payslip.findMany({ where: { payRunId: runA.id } })).length === 0)

const open = await sys.payWindow.findFirst({ where: { employeeId: slipA.employeeId, effectiveTo: null } })
const at   = instant()
raised = { employeeId: slipA.employeeId, windowId: open.id, at }
await sys.payWindow.update({ where: { id: open.id }, data: { effectiveTo: at } })
await sys.payWindow.create({ data: {
  employeeId: slipA.employeeId, basis: open.basis, rate: open.rate * 2,
  hoursPerWeek: open.hoursPerWeek, effectiveFrom: at,
} })

await calculatePayRun(sys, runA.id)
const again = await sys.payslip.findFirst({ where: { payRunId: runA.id, employeeId: slipA.employeeId } })

t('reprint.aRaiseAfterwardsChangesNothing',
  again.gross === before.gross && again.deductions === before.deductions && again.net === before.net)
t('reprint.andItStillNamesTheOldPayWindow', again.payWindowId === before.window)
// The pay window it names is the one that was in force, which is now CLOSED —
// `FJS-D164` in a foreign key: a payslip pointing at the employee would reprint
// at whatever they are paid today.
t('reprint.thatWindowIsTheClosedOne',
  (await sys.payWindow.findFirst({ where: { id: again.payWindowId } })).effectiveTo !== null)

// ─── The ladder ───────────────────────────────────────────────────────────

// `approve` is `@gate(5)`, the second one in this application after a refund.
// Asked through the Data boundary with two real standings rather than compared
// as a number.
const staff = db.$setAuth({ id: 'drive-staff', role: 'user'  })
const admin = db.$setAuth({ id: 'drive-admin', role: 'admin' })

t('ladder.staffMayNotApprove', await refused(() => staff.payRun.transition(runA.id, 'approve')))
await admin.payRun.transition(runA.id, 'approve')
t('ladder.anAdministratorMay',
  (await sys.payRun.findFirst({ where: { id: runA.id } })).status === 'approved')

// ─── Paying it ────────────────────────────────────────────────────────────

const runB = await newRun('B')
t('pay.anUnapprovedRunIsRefused', await refused(() => payPayRun(sys, runB.id)))

const paid = await payPayRun(sys, runA.id)
const rowP = await sys.payRun.findFirst({ where: { id: runA.id } })
t('pay.itMovesToPaid',   rowP.status === 'paid')
t('pay.itStampsPaidAt',  rowP.paidAt != null)

const entry = await sys.journalEntry.findFirst({ where: { payRunId: runA.id } })
const jl    = await sys.journalLine.findMany({ where: { entryId: entry.id }, orderBy: { id: 'asc' } })

t('journal.onePerRun',
  (await sys.journalEntry.findMany({ where: { payRunId: runA.id } })).length === 1)
t('journal.itBalances',   jl.reduce((n, l) => n + l.amount, 0) === 0)
t('journal.fiveAccounts', jl.length === 5)

// The debit is what it cost the business — the people's gross plus what the
// employer paid on top — and the five credits are the parties owed out of it.
const all   = await sys.payslip.findMany({ where: { payRunId: runA.id } })
const gross = all.reduce((n, s) => n + s.gross, 0)
const cost  = all.reduce((n, s) => n + s.employerCost, 0)
const net   = all.reduce((n, s) => n + s.net, 0)
t('journal.theDebitIsGrossPlusEmployerCost',
  jl.find(l => l.account === 'wagesExpense')?.amount === gross + cost)
t('journal.thePeopleAreOwedTheNet',
  jl.find(l => l.account === 'netPayControl')?.amount === -net)

// ─── The arc ──────────────────────────────────────────────────────────────

// This application's SECOND `@@arc`, after `Payment`. Exactly one source, and
// the table holds it as well as `ledger.ts` does.
// The state rule the gate cannot hold: a PAID run's payslips are documents, and
// `revertPayRun` is the only thing standing between them and a delete the gate
// now permits. This is the assertion that concession has to buy back.
got['document.aPaidRunCannotBeTakenBack'] = await refused(() => revertPayRun(sys, runA.id))

t('arc.aPayrollJournalNamesTheRunAndNotAnOrder',
  entry.payRunId === runA.id && entry.orderId === null)
t('arc.aSaleJournalStillNamesAnOrder',
  (await sys.journalEntry.findFirst({ where: { source: 'sale' } }))?.orderId != null)
t('arc.namingBothIsRefused',
  await refused(() => sys.journalEntry.create({ data: {
    reference: `JNL-BOTH-${RUN}`, narrative: 'both', source: 'payroll',
    orderId: 1, payRunId: runA.id,
  } })))
t('arc.namingNeitherIsRefused',
  await refused(() => sys.journalEntry.create({ data: {
    reference: `JNL-NEITHER-${RUN}`, narrative: 'neither', source: 'payroll',
  } })))

} catch (err) {
  failedEarly = err
} finally {
  // **Restoring what a drive CHANGED is the drive's own; the sweep removes what
  // it MADE.** This one gives a SEEDED employee a raise to prove a past period
  // reprints identically afterwards, so it has to put their history back — and
  // it is the only payroll drive that touches a row it did not create. Leaving
  // it raised makes the next `verify:employment` read a window it did not
  // expect, which is how this was found.
  try {
    if (raised) {
      await sys.payWindow.deleteMany({
        where: { employeeId: raised.employeeId, effectiveFrom: raised.at } })
      await sys.payWindow.update({ where: { id: raised.windowId }, data: { effectiveTo: null } })
    }
  } catch (e) { console.log(`  note  restore: ${e.message}`) }

  try { await sweepPayroll(sys, fixtures) }
  catch (e) { console.log(`  note  sweep: ${e.message}`) }
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'share.twelveMonthsSumToTheYear': true,
  'share.andTheNaiveDivisionDoesNot': true,
  'share.everyShareIsAWholeMinorUnit': true,
  'share.itIsDeterministic': true,
  'share.aCleanSalaryStillDividesCleanly': true,
  'run.calculatingMovesItToCalculated': true,
  'run.itMadePayslips': true,
  'run.somebodyWhoHasLeftIsNotPaid': true,
  'run.onePayslipPerPersonPerRun': true,
  'run.aSecondCalculationIsRefused': true,
  'invariant.theCountedLinesSumToNet': true,
  'invariant.theEmployerLinesSumToTheEmployerCost': true,
  'invariant.theEmployerLinesDoNotCountTowardNet': true,
  'invariant.andTheEmployerCostIsNotInTheNet': true,
  'lines.aBandLineNamesItsRate': true,
  'lines.basicPayNamesNoRate': true,
  'document.theSingleRowCheckIsHeldByTheDatabase': true,
  'document.aPayslipCannotBeRestated': true,
  'document.noCallerMayDeleteALine': true,
  'document.norMayOneUpdateAPayslipAtAnyLevel': true,
  'document.aPaidRunCannotBeTakenBack': true,
  'document.aLineForNothingIsRefused': true,
  'revert.itRemovesThePayslipsItMade': true,
  'revert.andLeavesNoneBehind': true,
  'reprint.aRaiseAfterwardsChangesNothing': true,
  'reprint.andItStillNamesTheOldPayWindow': true,
  'reprint.thatWindowIsTheClosedOne': true,
  'ladder.staffMayNotApprove': true,
  'ladder.anAdministratorMay': true,
  'pay.anUnapprovedRunIsRefused': true,
  'pay.itMovesToPaid': true,
  'pay.itStampsPaidAt': true,
  'journal.onePerRun': true,
  'journal.itBalances': true,
  'journal.fiveAccounts': true,
  'journal.theDebitIsGrossPlusEmployerCost': true,
  'journal.thePeopleAreOwedTheNet': true,
  'arc.aPayrollJournalNamesTheRunAndNotAnOrder': true,
  'arc.aSaleJournalStillNamesAnOrder': true,
  'arc.namingBothIsRefused': true,
  'arc.namingNeitherIsRefused': true,
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const ok = got[key] === want
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) console.log(`         want ${want}   have ${JSON.stringify(got[key])}`)
}
if (failedEarly) console.error(`\nstopped early: ${failedEarly.message ?? failedEarly}`)
console.log(failed || failedEarly
  ? `\n${failed} assertion(s) failed`
  : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed || failedEarly ? 1 : 0)
