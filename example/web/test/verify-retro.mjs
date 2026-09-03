/**
 * web/test/verify-retro.mjs — a backdated raise, and the three periods it
 * makes wrong.
 *
 * **bun, and no server.** Every claim here is about the Data boundary,
 * `api/src/domain/payroll` and `api/src/domain/payroll` — `IDEAS/payroll.md` phase 6.
 *
 * ─── What only this drive can ask ─────────────────────────────────────────
 *
 * **`frozen.everyClosedPayslipIsUnchanged`** — the whole phase in one line. A
 * raise agreed in June and effective from March makes three already-paid
 * periods wrong, and the correction lands as extra lines on a LATER payslip.
 * The closed ones are compared byte for byte, header and lines, before and
 * after everything else here happens.
 *
 * **`backdate.theCoveringWindowAtAPastDateIsNowTheNewOne`** — the other half of
 * the same fact, and it is the one that looks like a bug until you see it
 * beside the first. `verify:employment` asserts that reading a past instant
 * gives the same answer across a raise; a BACKDATE deliberately makes it give a
 * different one. The schema holds VALID time and no transaction time, so *what
 * did we believe in March* survives only where a document froze it.
 *
 * **`settled.revertingAndRecalculatingGivesTheSameArrearsOnce`** and
 * **`compose.aSecondBackdateCorrectsOnlyTheRemainder`** — the two shapes that
 * pay somebody twice if the third term of the comparison is forgotten. Nothing
 * declares that writing a pay window invalidated three payslips, so *has this
 * already been put right* is a query somebody remembered to write.
 *
 * **`refund.theJournalStillBalances`** — a backdated pay CUT produces a tax
 * refund, which is a positive `incomeTax` line and a DEBIT to the PAYE control
 * account. `payPayRun` took `Math.abs` of each kind until this drive existed,
 * so the journal was out by twice the refund.
 *
 * ─── How the writes are made ──────────────────────────────────────────────
 *
 * Close-then-open is spelled by hand here exactly as `verify:employment`
 * spells it, because a service method needs an app and every claim here is
 * below one. The REFUSALS are asserted against `assertEffectiveFrom`, which is
 * the rule `employees.setPay` calls — the four steps are duplicated on purpose
 * (`employment.ts` says why) and the rule is not.
 *
 * Both employees and every run are minted under a run prefix (`FJS-530`,
 * `FJS-546`) and the payslips are driven per person rather than through
 * `planPayRun`, so nothing this drive does touches the seeded roster or the
 * runs another drive left behind.
 */

import { db }                                    from '../../api/src/core/db.ts'
import { instant, payAsAt, assertEffectiveFrom } from '../../api/src/domain/payroll'
import { calculatePayslipFor, payPayRun, revertPayRun } from '../../api/src/domain/payroll'
import { arrearsFor }                            from '../../api/src/domain/payroll'
import { sweepPayroll }                          from './payroll-sweep.mjs'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const DAY = 86_400_000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()

const got = {}
const t   = (label, value) => { got[label] = value }
const refused = async (fn) => { try { await fn(); return false } catch { return true } }
const refusedSync = (fn) => { try { fn(); return false } catch { return true } }

const fixtures = { runIds: [], employeeIds: [] }

// ─── the two people ───────────────────────────────────────────────────────
//
// A gets a backdated RAISE, which is the ordinary case. B gets a backdated CUT,
// which is the same mechanism with every sign reversed and is the only way to
// reach a refund — the branch a magnitude quietly got wrong.

const hire = async (suffix, name, rate) => {
  const employee = await sys.employee.create({ data: {
    reference: `RET-${RUN}${suffix}`, name, email: `ret-${RUN}${suffix}@shop.test`,
    startedOn: ago(400),
  } })
  const window = await sys.payWindow.create({ data: {
    employeeId: employee.id, basis: 'salary', rate, hoursPerWeek: 40,
    effectiveFrom: ago(400),
  } })
  fixtures.employeeIds.push(employee.id)
  return { employee, window }
}

const A = await hire('A', 'Marlo Vance',  3_600_000)
const B = await hire('B', 'Sasha Iyer',   6_000_000)

// ─── six monthly periods ──────────────────────────────────────────────────

const PERIODS = [
  { i: 0, from: 120, to:  90 },
  { i: 1, from:  90, to:  60 },
  { i: 2, from:  60, to:  30 },
  { i: 3, from:  30, to:  15 },   // the one the correction lands on
  { i: 4, from:  15, to:  10 },
  { i: 5, from:  10, to:   1 },
]

const newRun = async (n, tag = '') => {
  const p   = PERIODS[n]
  const run = await sys.payRun.create({ data: {
    reference:   `RETR-${RUN}-${n}${tag}`,
    periodStart: ago(p.from), periodEnd: ago(p.to), payDate: ago(p.to),
    periodsPerYear: 12, periodIndex: p.i,
  } })
  fixtures.runIds.push(run.id)
  return run
}

/** Calculate for these two people alone, then close the run. `planPayRun`
 *  would sweep the whole roster, which is every other drive's fixtures. */
const calcFor = async (run) => {
  for (const who of [A, B]) await calculatePayslipFor(sys, run.id, who.employee.id)
  await sys.payRun.transition(run.id, 'calculate')
}

const linesOf = async (payslipId) =>
  sys.payslipLine.findMany({ where: { payslipId }, orderBy: { id: 'asc' }, limit: 200 })

const slipOf = async (runId, employeeId) =>
  sys.payslip.findFirst({ where: { payRunId: runId, employeeId } })

/** A payslip and its lines as a comparable string. */
const snapshot = async (runId, employeeId) => {
  const slip  = await slipOf(runId, employeeId)
  const lines = await linesOf(slip.id)
  return JSON.stringify({
    slip:  { ...slip, id: undefined },
    lines: lines.map(l => ({ ...l, id: undefined, payslipId: undefined })),
  })
}

// The three periods that get paid at the ORIGINAL rate.
const closed = []
for (let n = 0; n < 3; n++) {
  const run = await newRun(n)
  await calcFor(run)
  await sys.payRun.transition(run.id, 'approve')
  await payPayRun(sys, run.id)
  closed.push(run)
}

const before = {
  A: await Promise.all(closed.map(r => snapshot(r.id, A.employee.id))),
  B: await Promise.all(closed.map(r => snapshot(r.id, B.employee.id))),
}

// ─── the backdate ─────────────────────────────────────────────────────────

const RAISE_AT = ago(125)   // before the first period opened — clean
const CUT_AT   = ago(105)   // inside the first period — the gap below

const backdate = async (who, at, rate) => {
  const open = await sys.payWindow.findFirst({
    where: { employeeId: who.employee.id, effectiveTo: null },
  })
  assertEffectiveFrom(who.employee.reference, at, instant(),
    await sys.payWindow.findMany({ where: { employeeId: who.employee.id }, limit: 100 }))
  await sys.payWindow.update({ where: { id: open.id }, data: { effectiveTo: at } })
  const next = await sys.payWindow.create({ data: {
    employeeId: who.employee.id, basis: 'salary', rate, hoursPerWeek: 40,
    effectiveFrom: at,
  } })
  return next
}

const raised = await backdate(A, RAISE_AT, 4_200_000)
await backdate(B, CUT_AT, 5_400_000)

const oldA = await sys.payWindow.findFirst({ where: { id: A.window.id } })

t('backdate.itOpensAWindowAtTheStatedInstant', raised.effectiveFrom === RAISE_AT)
t('backdate.andClosesTheOldOneThere',          oldA.effectiveTo    === RAISE_AT)

// History rewritten, and this is the assertion that looks like a bug on its
// own. `verify:employment` asserts a past read is STABLE across a raise; a
// backdate is the act that deliberately moves it, and the two together are the
// whole of what the missing axis costs.
const nowAtMarch = await payAsAt(sys, A.employee.id, ago(90))
t('backdate.theCoveringWindowAtAPastDateIsNowTheNewOne', nowAtMarch.id === raised.id)
t('backdate.andItAnswersTheNewRate',                     nowAtMarch.rate === 4_200_000)

// **Where the previous belief actually is.** The row was overwritten in place:
// `effectiveTo` said null and now says March, and nothing on it records that.
// What holds the old value is the audit log — `@@log(audit)`, a `logger`
// database — so the second axis is not absent, it is a FILE.
//
// That is the distinction worth pinning. *What did we believe about March* is
// answerable, and answering it means scanning an append-only log, decoding two
// JSON strings and matching a stringified array of ids. It is a record, not a
// dimension: no read of `PayWindow` can be asked to stand at a past moment of
// KNOWLEDGE the way `coveringAt` stands at a past moment of validity.
await new Promise(r => setTimeout(r, 50))   // the logger defers one tick
const trail = await sys.auditLogs.findMany({
  where: { model: 'pay_window', operation: 'update' },
  orderBy: { createdAt: 'desc' }, limit: 50,
})
const closing = trail.find(r => String(r.records).includes(`[${A.window.id}]`))
const was     = closing && JSON.parse(closing.before)
const became  = closing && JSON.parse(closing.after)

t('gap.theRowKeepsNoTraceOfWhatItUsedToSay',
  oldA.effectiveTo === RAISE_AT && !('effectiveToWas' in oldA))
t('gap.butTheAuditLogDoes',        was?.effectiveTo === null)
t('gap.andItRecordsWhatItBecame',  became?.effectiveTo === RAISE_AT)
t('gap.thoughOnlyAsAJsonStringInALog',
  typeof closing.before === 'string' && typeof closing.records === 'string')

// The refusals, asserted against the rule the service calls.
const NOW = instant()
t('backdate.aFutureDateIsRefused',
  refusedSync(() => assertEffectiveFrom('X', ago(-5), NOW, [oldA, raised])))
t('backdate.andSoIsBackdatingAcrossAnEarlierChange',
  refusedSync(() => assertEffectiveFrom('X', ago(200), NOW, [oldA, raised])))
// Into a closed history with nothing open: two windows would cover one instant,
// which is the thing `payAsAtMany` cannot resolve and has to report by name.
t('backdate.andSoIsOpeningInsideAClosedHistory',
  refusedSync(() => assertEffectiveFrom('X', ago(300), NOW, [oldA])))
// **A FIRST window may start whenever they did.** Nothing to close, nothing to
// cross — and refusing it meant a new hire's pay could only start at the
// instant somebody typed it, so the first run for anybody hired last month was
// wrong. Found by the console drive, which could not build its own fixture.
t('backdate.butAFirstWindowMayStartInThePast',
  !refusedSync(() => assertEffectiveFrom('X', ago(400), NOW, [])))
t('backdate.anOrdinaryRaiseIsNotGradedAtAll',
  !refusedSync(() => assertEffectiveFrom('X', NOW, NOW, [])))

// A correction AT the instant the current window opened would need a window of
// zero length, and the database refuses it — so putting right a correction is
// not the same act as making one.
t('gap.correctingAtTheSameInstantIsRefusedByTheDatabase',
  await refused(() => sys.payWindow.update({
    where: { id: raised.id }, data: { effectiveTo: RAISE_AT } })))

// ─── the closed documents did not move ────────────────────────────────────

const after = {
  A: await Promise.all(closed.map(r => snapshot(r.id, A.employee.id))),
  B: await Promise.all(closed.map(r => snapshot(r.id, B.employee.id))),
}
t('frozen.everyClosedPayslipIsUnchanged',
  JSON.stringify(before.A) === JSON.stringify(after.A))
t('frozen.andSoIsEveryLineOnThem',
  JSON.stringify(before.B) === JSON.stringify(after.B))

const march = await slipOf(closed[0].id, A.employee.id)
t('frozen.theyStillNameTheOldPayWindow', march.payWindowId === A.window.id)
t('frozen.andThatWindowIsTheClosedOne',  oldA.effectiveTo !== null)
t('frozen.restatingOneIsRefusedEvenBySystem',
  await refused(() => sys.payslip.update({
    where: { id: march.id }, data: { gross: march.gross + 1 } })))

// ─── the correction ───────────────────────────────────────────────────────

const runD = await newRun(3)
await calcFor(runD)

const slipD  = await slipOf(runD.id, A.employee.id)
const linesD = await linesOf(slipD.id)
const adj    = linesD.filter(l => l.correctsPayRunId != null)

t('arrears.theNextPayslipCarriesThem', adj.length > 0)
t('arrears.oneSetPerCorrectedRun',
  new Set(adj.map(l => l.correctsPayRunId)).size === 3)
t('arrears.everyOneOfThemNamesTheRunItCorrects',
  adj.every(l => closed.some(r => r.id === l.correctsPayRunId)))
t('arrears.anOrdinaryLineNamesNoRun',
  linesD.filter(l => l.correctsPayRunId == null).every(l => l.correctsPayRunId === null))

// 300,000 a period at 3,600,000 and 350,000 at 4,200,000, over three periods.
const backPay = adj.filter(l => l.kind === 'basicPay').reduce((n, l) => n + l.amount, 0)
t('arrears.backPayIsTheDifferenceTimesThree', backPay === 150_000)
t('arrears.andTheTaxOnItIsAdjustedToo',
  adj.filter(l => l.kind === 'incomeTax').reduce((n, l) => n + l.amount, 0) === -30_000)
t('arrears.theEmployerSideMovesToo',
  adj.some(l => l.kind === 'employerNI' || l.kind === 'employerPension'))

// No rate on an adjustment: it is the DIFFERENCE between two band walks, so no
// single band produced it. Provenance stated wrongly is worse than none.
t('arrears.theyNameNoRate', adj.every(l => l.rateId === null))
t('arrears.anOrdinaryBandLineStillDoes',
  linesD.some(l => l.correctsPayRunId == null && l.rateId != null))

// The payslip still adds up, on both rules — the one the database holds and the
// one it cannot see.
const counting = linesD.filter(l => l.counts)
t('arrears.thePayslipStillAddsUp',
  counting.reduce((n, l) => n + l.amount, 0) === slipD.net)
t('arrears.andTheDatabaseAgrees', slipD.net === slipD.gross - slipD.deductions)
t('arrears.theGrossRoseByTheBackPay',
  slipD.gross === 350_000 + 150_000)

// ─── the refund, which is the same thing with the signs reversed ──────────

const slipDB  = await slipOf(runD.id, B.employee.id)
const linesDB = await linesOf(slipDB.id)
const adjB    = linesDB.filter(l => l.correctsPayRunId != null)

t('refund.aBackdatedCutProducesNegativeBackPay',
  adjB.filter(l => l.kind === 'basicPay').reduce((n, l) => n + l.amount, 0) === -150_000)
t('refund.andAPositiveTaxLine',
  adjB.filter(l => l.kind === 'incomeTax').every(l => l.amount > 0))
const bClosed = await slipOf(closed[0].id, B.employee.id)
t('refund.theDeductionsFall',  slipDB.deductions < bClosed.deductions)
t('refund.andTheNetIsStillPositive', slipDB.net > 0)

// A cut backdated INTO a period moves the whole of it, because the as-at read
// stands at one instant — the period end. A change part way through a period is
// not prorated, and nothing says so.
const bMarch = adjB.filter(l => l.correctsPayRunId === closed[0].id && l.kind === 'basicPay')
t('gap.aMidPeriodBackdateMovesTheWholePeriod',
  bMarch.length === 1 && bMarch[0].amount === -50_000)

// ─── recalculating must not pay it twice ──────────────────────────────────

const arrearsOnce = JSON.stringify(adj.map(l => [l.kind, l.amount, l.correctsPayRunId]))
await revertPayRun(sys, runD.id)
t('settled.revertingRemovesThePayslipsAndTheirArrears',
  (await sys.payslip.count({ where: { payRunId: runD.id } })) === 0)

await calcFor(runD)
const again = (await linesOf((await slipOf(runD.id, A.employee.id)).id))
  .filter(l => l.correctsPayRunId != null)
t('settled.revertingAndRecalculatingGivesTheSameArrearsOnce',
  JSON.stringify(again.map(l => [l.kind, l.amount, l.correctsPayRunId])) === arrearsOnce)

// ─── the books ────────────────────────────────────────────────────────────

await sys.payRun.transition(runD.id, 'approve')
const paidD = await payPayRun(sys, runD.id)

const entry = await sys.journalEntry.findFirst({ where: { payRunId: runD.id } })
const jl    = await sys.journalLine.findMany({ where: { entryId: entry.id }, limit: 20 })

t('ledger.theArrearsRunPostsOneJournal',
  (await sys.journalEntry.count({ where: { payRunId: runD.id } })) === 1)
t('ledger.itBalances', jl.reduce((n, l) => n + l.amount, 0) === 0)

const slipsD = await sys.payslip.findMany({ where: { payRunId: runD.id }, limit: 10 })
const wages  = jl.find(l => l.account === 'wagesExpense')
t('ledger.theWagesExpenseIncludesTheBackPay',
  wages.amount === slipsD.reduce((n, s) => n + s.gross + s.employerCost, 0))
t('ledger.theDebitIsWhatTheRunReported', wages.amount === paidD.debit)

// The control account carries the SIGNED sum of the kind, adjustments and all
// — never its magnitude. See `floor.*` below for why the difference cannot
// currently be reached with a whole run.
const dLines = await sys.payslipLine.findMany({
  where: { payslipId: { in: slipsD.map(s => s.id) } }, limit: 500 })
const taxSum = dLines.filter(l => l.kind === 'incomeTax').reduce((n, l) => n + l.amount, 0)
const paye   = jl.find(l => l.account === 'payeControl')
t('ledger.payeControlIsTheSignedSumOfTheTaxLines', paye.amount === taxSum)
t('ledger.andSomeOfThoseLinesAreRefunds',
  dLines.some(l => l.kind === 'incomeTax' && l.amount > 0))

// ─── nothing left to correct ──────────────────────────────────────────────

const runE = await newRun(4)
await calcFor(runE)
const linesE = await linesOf((await slipOf(runE.id, A.employee.id)).id)
t('settled.aLaterRunCarriesNoArrears',
  linesE.every(l => l.correctsPayRunId == null))
t('settled.becauseTheyHaveAlreadyBeenPaid',
  (await arrearsFor(sys, A.employee.id)).lines.length === 0)

// ─── correcting the correction ────────────────────────────────────────────

await backdate(A, ago(120), 4_800_000)

const runF = await newRun(5)
await calcFor(runF)
const slipF  = await slipOf(runF.id, A.employee.id)
const adjF   = (await linesOf(slipF.id)).filter(l => l.correctsPayRunId != null)

// 350,000 a period at 4,200,000 and 400,000 at 4,800,000 — the REMAINDER, not
// the whole difference from where it started.
const backPayF = adjF.filter(l => l.kind === 'basicPay').reduce((n, l) => n + l.amount, 0)
t('compose.aSecondBackdateCorrectsOnlyTheRemainder', backPayF === 200_000)
t('compose.andNotTheWholeDifferenceAgain',           backPayF !== 350_000)

// Four runs now, not three: the period the first correction was PAID in is
// itself a paid period, and it was computed at a rate we no longer believe.
t('compose.thePeriodTheCorrectionWasPaidInIsCorrectedToo',
  new Set(adjF.map(l => l.correctsPayRunId)).size === 4)

// The already-issued adjustment lines did not move. A derived row is frozen
// like any other — nothing recomputes when its source does.
const stillD = (await linesOf((await slipOf(runD.id, A.employee.id)).id))
  .filter(l => l.correctsPayRunId != null)
t('compose.andTheFirstCorrectionIsNotMoved',
  JSON.stringify(stillD.map(l => [l.kind, l.amount, l.correctsPayRunId])) === arrearsOnce)

// Run E is CALCULATED and not paid, so it is not corrected — it is reverted and
// recalculated. That rule is in prose in `arrears.ts` and in nothing else.
t('gap.aCalculatedRunIsNotCorrected',
  !adjF.some(l => l.correctsPayRunId === runE.id))

// **The finding, measured rather than described.** After the second backdate,
// run C's payslip is stale — we no longer believe the figure on it — and it is
// byte-identical to what it was before anybody touched a pay window. So no
// read of the document can tell a stale one from a current one; the only way
// to find out is to recompute it and compare, which is what `arrearsFor` does
// and why it is O(every paid run) rather than O(what changed).
const stale = await snapshot(closed[2].id, A.employee.id)
t('gap.aStalePayslipIsIndistinguishableFromACurrentOne', stale === before.A[2])
t('gap.andTheOnlyWayToFindOutIsToRecomputeIt',
  adjF.some(l => l.correctsPayRunId === closed[2].id))

// ─── the floor, and where a correction has nowhere to go ──────────────────
//
// `Payslip.gross`, `deductions`, `net` and `employerCost` are each `@gte(0)`,
// so an adjustment can only ever be as large as the period carrying it. A cut
// backdated far enough is arithmetically fine — `arrearsFor` computes it — and
// the WRITE is refused by the boundary naming the column.
//
// Two things follow and both are honest limits rather than defects. A real
// payroll spreads a large recovery over several periods, and nothing here can
// express *this much of it, this month*. And it is why a run's total income tax
// can never come out positive: a refund big enough to exceed the period's own
// tax needs a gross reduction bigger than the period's own gross, which the
// floor refuses first. The signed sums in `payPayRun` are therefore correct by
// construction rather than by measurement.

const C = await hire('C', 'Nia Petrov', 3_000_000)
const runG = await newRun(0, 'G')
await calculatePayslipFor(sys, runG.id, C.employee.id)
await sys.payRun.transition(runG.id, 'calculate')
await sys.payRun.transition(runG.id, 'approve')
await payPayRun(sys, runG.id)

// Down to a fifth, backdated before the period that was paid.
const cOpen = await sys.payWindow.findFirst({
  where: { employeeId: C.employee.id, effectiveTo: null } })
await sys.payWindow.update({ where: { id: cOpen.id }, data: { effectiveTo: ago(130) } })
await sys.payWindow.create({ data: {
  employeeId: C.employee.id, basis: 'salary', rate: 600_000, hoursPerWeek: 40,
  effectiveFrom: ago(130),
} })

const owedC = await arrearsFor(sys, C.employee.id)
t('floor.theCorrectionItselfComputesFine',
  owedC.lines.filter(l => l.kind === 'basicPay').reduce((n, l) => n + l.amount, 0) === -200_000)

const runH = await newRun(1, 'H')
t('floor.butAPayslipItWouldMakeNegativeIsRefused',
  await refused(() => calculatePayslipFor(sys, runH.id, C.employee.id)))
t('floor.andNoPayslipWasWritten',
  (await sys.payslip.count({ where: { payRunId: runH.id } })) === 0)

// ─── clean up ─────────────────────────────────────────────────────────────

try { await sweepPayroll(sys, fixtures) }
catch (err) { console.log(`  note  sweep: ${err.message}`) }

// ─── report ───────────────────────────────────────────────────────────────

const expected = {
  'backdate.itOpensAWindowAtTheStatedInstant': true,
  'backdate.andClosesTheOldOneThere': true,
  'backdate.theCoveringWindowAtAPastDateIsNowTheNewOne': true,
  'backdate.andItAnswersTheNewRate': true,
  'gap.theRowKeepsNoTraceOfWhatItUsedToSay': true,
  'gap.butTheAuditLogDoes': true,
  'gap.andItRecordsWhatItBecame': true,
  'gap.thoughOnlyAsAJsonStringInALog': true,
  'backdate.aFutureDateIsRefused': true,
  'backdate.andSoIsBackdatingAcrossAnEarlierChange': true,
  'backdate.andSoIsOpeningInsideAClosedHistory': true,
  'backdate.butAFirstWindowMayStartInThePast': true,
  'backdate.anOrdinaryRaiseIsNotGradedAtAll': true,
  'gap.correctingAtTheSameInstantIsRefusedByTheDatabase': true,
  'frozen.everyClosedPayslipIsUnchanged': true,
  'frozen.andSoIsEveryLineOnThem': true,
  'frozen.theyStillNameTheOldPayWindow': true,
  'frozen.andThatWindowIsTheClosedOne': true,
  'frozen.restatingOneIsRefusedEvenBySystem': true,
  'arrears.theNextPayslipCarriesThem': true,
  'arrears.oneSetPerCorrectedRun': true,
  'arrears.everyOneOfThemNamesTheRunItCorrects': true,
  'arrears.anOrdinaryLineNamesNoRun': true,
  'arrears.backPayIsTheDifferenceTimesThree': true,
  'arrears.andTheTaxOnItIsAdjustedToo': true,
  'arrears.theEmployerSideMovesToo': true,
  'arrears.theyNameNoRate': true,
  'arrears.anOrdinaryBandLineStillDoes': true,
  'arrears.thePayslipStillAddsUp': true,
  'arrears.andTheDatabaseAgrees': true,
  'arrears.theGrossRoseByTheBackPay': true,
  'refund.aBackdatedCutProducesNegativeBackPay': true,
  'refund.andAPositiveTaxLine': true,
  'refund.theDeductionsFall': true,
  'refund.andTheNetIsStillPositive': true,
  'gap.aMidPeriodBackdateMovesTheWholePeriod': true,
  'settled.revertingRemovesThePayslipsAndTheirArrears': true,
  'settled.revertingAndRecalculatingGivesTheSameArrearsOnce': true,
  'ledger.theArrearsRunPostsOneJournal': true,
  'ledger.itBalances': true,
  'ledger.theWagesExpenseIncludesTheBackPay': true,
  'ledger.theDebitIsWhatTheRunReported': true,
  'ledger.payeControlIsTheSignedSumOfTheTaxLines': true,
  'ledger.andSomeOfThoseLinesAreRefunds': true,
  'settled.aLaterRunCarriesNoArrears': true,
  'settled.becauseTheyHaveAlreadyBeenPaid': true,
  'compose.aSecondBackdateCorrectsOnlyTheRemainder': true,
  'compose.andNotTheWholeDifferenceAgain': true,
  'compose.thePeriodTheCorrectionWasPaidInIsCorrectedToo': true,
  'compose.andTheFirstCorrectionIsNotMoved': true,
  'gap.aCalculatedRunIsNotCorrected': true,
  'gap.aStalePayslipIsIndistinguishableFromACurrentOne': true,
  'gap.andTheOnlyWayToFindOutIsToRecomputeIt': true,
  'floor.theCorrectionItselfComputesFine': true,
  'floor.butAPayslipItWouldMakeNegativeIsRefused': true,
  'floor.andNoPayslipWasWritten': true,
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
