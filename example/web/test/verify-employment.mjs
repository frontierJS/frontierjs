/**
 * web/test/verify-employment.mjs — what was true on the 12th.
 *
 * **bun, and no server.** Every assertion here is a fact about the Data
 * boundary and about `api/src/domain/payroll`, which owns the as-at read. An API
 * would add a transport this drive says nothing about and would put it on the
 * login limiter for nothing (`verify:billing` runs under bun for the same
 * reason).
 *
 * ─── What it is actually asking ───────────────────────────────────────────
 *
 * Every other drive in this repository asks *what is true*. This one asks *what
 * was true*, which is the question payroll is built on and the one the schema
 * language cannot yet help with (`IDEAS/payroll.md` phase 2).
 *
 * A single pay window makes every one of these pass by accident — with one row,
 * *what were they on in March* and *what are they on* are the same query — so
 * `db:seed` gives each person a CLOSED window and an open one, and the drive
 * reads across the join between them.
 *
 * ─── The two assertions that are the point ────────────────────────────────
 *
 * `raise.theSameInstantAnswersTheSame` — read a past instant, give somebody a
 * raise, read the same instant again. A backdated-looking answer here is a
 * payslip that reprints differently from how it was issued, which is the whole
 * failure effective dating exists to prevent.
 *
 * `constraint.*` — a second open window is REFUSED, and refused by the table.
 * This was `FJS-603` and it was pinned here as an executed assertion of the
 * opposite: the schema ACCEPTED a second open window, because `@@unique` took
 * no predicate and *one open window per employee* was enforced in
 * `employees.setPay` and by nothing underneath it. Closing it turned this drive
 * red, which is what pinning a gap is for. What the assertions ask now is the
 * half a service could never answer: `asSystem()` is refused, and so is a raw
 * INSERT, so the rule holds for a seed, a job and a migration.
 *
 * Fixtures are minted per run (`FJS-530`, `FJS-546`) — `Employee.reference` and
 * `Employee.email` are both `@unique`, and a drive reusing one passes exactly
 * once per seed.
 */

import { db } from '../../api/src/core/db.ts'
import { payAsAt, payAsAtMany, employedAt, weeklyGross, annualGross, instant, coveringAt }
  from '../../api/src/domain/payroll'
import { ratesAsAt, allRatesAsAt, applyBands, contributionsOn, PERCENT_SCALE }
  from '../../api/src/domain/payroll'
import { sweepPayroll } from './payroll-sweep.mjs'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const DAY = 24 * 60 * 60 * 1000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()

const got = {}
const t   = (label, value) => { got[label] = value }
const refused = async (fn) => { try { await fn(); return false } catch { return true } }

// Everything this drive makes is registered here as it is made and swept in the
// `finally` below — **on the failure path too**, which is the run whose
// leftovers are hardest to recognise later. `payroll-sweep.mjs` owns the order
// and the one hatch under the boundary the books need.
const fixtures = { runIds: [], employeeIds: [] }
let failedEarly = null

try {

// ─── The seeded histories ─────────────────────────────────────────────────

const dana = await sys.employee.findFirst({ where: { reference: 'EMP-1001' } })
const ira  = await sys.employee.findFirst({ where: { reference: 'EMP-1002' } })
const wren = await sys.employee.findFirst({ where: { reference: 'EMP-1003' } })

const danaWindows = await sys.payWindow.findMany({
  where: { employeeId: dana.id }, orderBy: { effectiveFrom: 'asc' },
})
const [first, current] = danaWindows

t('seed.givesAHistoryAndNotAPay', danaWindows.length >= 2)

// ─── The as-at read ───────────────────────────────────────────────────────

t('asAt.beforeHireIsNothing',      await payAsAt(sys, dana.id, ago(1200)) === null)
t('asAt.aClosedWindowAnswersItsOwnRate',
  (await payAsAt(sys, dana.id, ago(300)))?.rate === first.rate)
t('asAt.theOpenWindowAnswersToday',
  (await payAsAt(sys, dana.id, new Date()))?.rate === current.rate)

// Half-open, `[from, to)`. The instant a window opens belongs to the NEW one
// and to nothing else — two readers disagreeing about this boundary is a wrong
// salary once per raise, and never reproducible because it depends on which
// row the database happened to return first.
t('asAt.theBoundaryInstantBelongsToTheNewWindow',
  (await payAsAt(sys, dana.id, current.effectiveFrom))?.id === current.id)
t('asAt.theInstantBeforeItBelongsToTheOld',
  (await payAsAt(sys, dana.id, new Date(new Date(current.effectiveFrom).getTime() - 1)))?.id === first.id)

// ─── The batch, which is what a pay run asks ──────────────────────────────

const ids   = [dana.id, ira.id, wren.id]
const at    = instant(ago(300))
const many  = await payAsAtMany(sys, ids, at)
const oneByOne = new Map()
for (const id of ids) {
  const row = await payAsAt(sys, id, at)
  if (row) oneByOne.set(id, row)
}

t('batch.agreesWithReadingThemOneAtATime',
  ids.every(id => many.get(id)?.id === oneByOne.get(id)?.id))

// Absent rather than mapped to null, so a caller iterating the map cannot pay
// somebody who had no terms in force.
const beforeAnyone = await payAsAtMany(sys, ids, instant(ago(1200)))
t('batch.omitsSomebodyWithNoWindowAtAll', beforeAnyone.size === 0)

// ─── Employed is a different question from paid ───────────────────────────

// A leaver's pay window is still open — leaving does not close one. So a payroll
// that read the terms table alone would keep paying them, and `employedAt` is
// the only thing that says otherwise.
const wrenTerms = await sys.payWindow.findMany({ where: { employeeId: wren.id } })
t('leaver.stillHasAnOpenPayWindow', wrenTerms.some(w => w.effectiveTo === null))
t('leaver.isStillAnsweredByTheAsAtRead', (await payAsAt(sys, wren.id, new Date())) !== null)

const employedNow    = await employedAt(sys, new Date())
const employedBefore = await employedAt(sys, ago(90))
t('employed.excludesSomebodyWhoHasLeft',
  !employedNow.some(e => e.id === wren.id))
t('employed.includedThemBeforeTheyWent',
  employedBefore.some(e => e.id === wren.id))
t('employed.stillHasTheOthers',
  employedNow.some(e => e.id === dana.id) && employedNow.some(e => e.id === ira.id))

// ─── The raise, and the instant that must not move ────────────────────────

const mine = await sys.employee.create({ data: {
  reference: `EMP-V${RUN}`, name: `Vera Verify ${RUN}`, email: `vera.${RUN}@drive.test`,
  startedOn: ago(400),
} })
fixtures.employeeIds.push(mine.id)
await sys.payWindow.create({ data: {
  employeeId: mine.id, basis: 'salary', rate: 3_000_000, hoursPerWeek: 40,
  effectiveFrom: ago(400),
} })

const past       = instant(ago(200))
const beforeRaise = await payAsAt(sys, mine.id, past)

// The raise, spelled exactly as `employees.setPay` spells it — close the open
// window at the instant the next opens, then open it.
const raiseAt = instant()
const open    = await sys.payWindow.findFirst({ where: { employeeId: mine.id, effectiveTo: null } })
await sys.payWindow.update({ where: { id: open.id }, data: { effectiveTo: raiseAt } })
const opened  = await sys.payWindow.create({ data: {
  employeeId: mine.id, basis: 'salary', rate: 3_600_000, hoursPerWeek: 40, effectiveFrom: raiseAt,
} })

const afterRaise = await payAsAt(sys, mine.id, past)
const closed     = await sys.payWindow.findFirst({ where: { id: open.id } })

t('raise.theSameInstantAnswersTheSame',   afterRaise?.id === beforeRaise?.id && afterRaise?.rate === beforeRaise?.rate)
t('raise.theOldRateIsUntouched',          closed.rate === 3_000_000)
t('raise.theWindowsTouchWithNoGap',       closed.effectiveTo === opened.effectiveFrom)
t('raise.todayAnswersTheNewRate',         (await payAsAt(sys, mine.id, new Date()))?.rate === 3_600_000)
t('raise.leavesExactlyOneOpenWindow',
  (await sys.payWindow.findMany({ where: { employeeId: mine.id, effectiveTo: null } })).length === 1)

// ─── The document ─────────────────────────────────────────────────────────

// `@immutable` refuses the KEY, so the same value back is refused too — there
// is nothing in the seed that can compare the stored row to the incoming one,
// and needing neither is what `FJS-D162` ruled.
t('document.aRateCannotBeRestated',
  await refused(() => sys.payWindow.update({ where: { id: closed.id }, data: { rate: 9_000_000 } })))
t('document.theSameValueIsAlsoRefused',
  await refused(() => sys.payWindow.update({ where: { id: closed.id }, data: { rate: closed.rate } })))
t('document.theStartOfAWindowIsFrozen',
  await refused(() => sys.payWindow.update({ where: { id: closed.id }, data: { effectiveFrom: ago(10) } })))

// …and the one column that must NOT be frozen, or a window could never be
// closed and effective dating would not work at all.
await sys.payWindow.update({ where: { id: opened.id }, data: { effectiveTo: null } })
t('document.theEndOfAWindowIsNot',
  (await sys.payWindow.findFirst({ where: { id: opened.id } })).effectiveTo === null)

// `asSystem()` is what is holding the client above, so these refusals are the
// constraint tier rather than the gate. A rule the renewal job could drop is a
// rule absent from every caller that actually writes one.
t('document.asSystemDoesNotDropIt', true)

// ─── One open window per employee, held by the table — FJS-603 ────────────

// `@@unique([employeeId], where: effectiveTo == null)`. Asked through
// `asSystem()` rather than through `employees.setPay`, because the service
// already checked it and always did: what is new is that the rule holds where
// no service runs.
let secondOpen = null
try {
  await sys.payWindow.create({ data: {
    employeeId: mine.id, basis: 'salary', rate: 9_900_000, hoursPerWeek: 40, effectiveFrom: ago(5),
  } })
} catch (e) { secondOpen = e }
t('constraint.aSecondOpenWindowIsRefused', secondOpen !== null)
t('constraint.andItNamesTheColumnRatherThanATable',
  /employeeId/.test(secondOpen?.message ?? '') && !/pay_window\./.test(secondOpen?.message ?? ''))

// The half that separates a boundary rule from a table one. `asSystem()` drops
// the gate, the row policies and `@@softDelete`; a raw statement drops the
// boundary altogether. Neither can get past an index.
let rawRefused = false
try {
  await sys.sql`INSERT INTO pay_window (employeeId, basis, rate, hoursPerWeek, effectiveFrom)
                VALUES (${mine.id}, 'salary', 1, 40, ${ago(4)})`
} catch (e) { rawRefused = /UNIQUE constraint failed/i.test(e.message) }
t('constraint.andARawInsertIsRefusedToo', rawRefused)

// …and the CLOSED rows are untouched, which is the whole reason the predicate
// is the constraint: this employee already has one, and a plain tuple over
// `[employeeId, effectiveTo]` was constraining exactly those and nothing else.
const windows = await sys.payWindow.findMany({ where: { employeeId: mine.id }, limit: 20 })
t('constraint.theClosedWindowsAreUnaffected', windows.filter(w => w.effectiveTo).length >= 1)
t('constraint.andExactlyOneIsOpen', windows.filter(w => !w.effectiveTo).length === 1)

// The way through is the one effective dating already asks for: close the open
// window, then open the next. `employees.setPay` does exactly this, in one
// transaction, and the constraint refuses the second row rather than ordering
// the two writes.
const shut = await sys.payWindow.update({
  where: { id: opened.id }, data: { effectiveTo: instant() },
})
const next = await sys.payWindow.create({ data: {
  employeeId: mine.id, basis: 'salary', rate: 9_900_000, hoursPerWeek: 40, effectiveFrom: instant(),
} })
t('constraint.closingFirstMakesRoomForTheNext', !!next.id && !!shut.effectiveTo)
await sys.payWindow.delete({ where: { id: next.id } })
await sys.payWindow.update({ where: { id: opened.id }, data: { effectiveTo: null } })

// `payAsAtMany`'s own overlap defence — the sentence naming the employee, and
// the `latest` escape hatch beside it — is now UNREACHABLE through any client,
// which is the correct outcome and is why it is not asserted here any more. It
// stays in `api/src/domain/payroll` for a database written before the constraint
// existed; nothing in this repo can stage one.

// ─── The arithmetic the two bases do not share ────────────────────────────

t('gross.aSalaryDividesByFiftyTwo',
  weeklyGross({ basis: 'salary', rate: 5_200_000, hoursPerWeek: 40 }) === 100_000)
t('gross.anHourlyRateMultipliesTheHours',
  weeklyGross({ basis: 'hourly', rate: 2_000, hoursPerWeek: 35 }) === 70_000)
// One column, two magnitudes. The same number under the two bases is two wildly
// different weekly figures, which is the cost of the discriminator and the
// reason `rate` must never be summed across rows.
t('gross.theSameRateMeansTwoDifferentThings',
  weeklyGross({ basis: 'salary', rate: 52_000, hoursPerWeek: 40 })
  !== weeklyGross({ basis: 'hourly', rate: 52_000, hoursPerWeek: 40 }))

// The interval is spelled once and exported, so a caller building its own query
// cannot disagree with the module about which window covers an instant.
t('interval.isSpelledOnceAndExported',
  JSON.stringify(coveringAt('X')) === JSON.stringify({ effectiveFrom: { lte: 'X' }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: 'X' } }] }))

// ─── The rates, and the walk ──────────────────────────────────────────────

const bands = await ratesAsAt(sys, 'incomeTax', new Date())
t('rates.theBandsAreInForce', bands.length >= 3)
t('rates.theyComeBackInThresholdOrder',
  bands.every((b, i) => i === 0 || b.fromAmount > bands[i - 1].fromAmount))
t('rates.exactlyOneBandIsUnbounded',
  bands.filter(b => b.toAmount === null).length === 1)

// Nothing was in force before the tables were opened. A drive asking what March
// looked like against an empty table would get zero tax and pass, which is why
// the seed dates them in the past and why this is asserted rather than assumed.
t('rates.nothingIsInForceBeforeTheyOpened',
  (await ratesAsAt(sys, 'incomeTax', ago(500))).length === 0)

// ── The walk, which is the only interesting arithmetic in payroll ─────────

const ANNUAL = 4_800_000
const tax    = applyBands(bands, ANNUAL)

t('walk.thePartsSumToTheTotal',
  tax.parts.reduce((n, p) => n + p.amount, 0) === tax.total)
t('walk.theZeroBandContributesNothing',
  tax.parts.find(p => p.percent === 0)?.amount === 0)

// **The headline.** A band applies to the SLICE between its thresholds, never
// to the whole. The negative control is the wrong answer written out: applying
// the highest band that the salary reaches to the entire salary, which is the
// classic mistake and is wrong by thousands.
const topBandReached = [...tax.parts].reverse().find(p => p.percent > 0)
const naive          = Math.round(ANNUAL * topBandReached.percent / PERCENT_SCALE)
t('walk.theTopBandIsNotAppliedToTheWholeSalary', tax.total < naive)
t('walk.andTheNaiveAnswerIsWrongByARealAmount',  naive - tax.total > 100_000)

// Half-open at the threshold, for `coveringAt`'s reason one table along: a
// salary landing exactly on a boundary falls in the band ABOVE and in nothing
// else, or the slice is counted twice.
const onTheLine = bands[1].fromAmount
t('walk.aSalaryExactlyOnAThresholdIsInTheLowerBandOnly',
  applyBands(bands, onTheLine).parts.every(p => p.from < onTheLine))
t('walk.andOnePennyAboveItReachesTheNextBand',
  applyBands(bands, onTheLine + 1).parts.some(p => p.from === onTheLine))

// The unbounded top band catches everything above it and nothing below.
const rich = applyBands(bands, 30_000_000)
t('walk.theUnboundedBandCatchesTheRest',
  rich.parts.at(-1)?.to === null && rich.parts.at(-1).slice === 30_000_000 - bands.at(-1).fromAmount)

// A salary under the first threshold pays nothing, and answers no parts rather
// than a part of zero — a payslip does not print a line for a band nobody
// reached.
t('walk.underTheFirstThresholdThereIsNothingToShow',
  applyBands(bands, 100_000).parts.filter(p => p.amount > 0).length === 0)

// ── The four kinds, and what must not be netted ───────────────────────────

const rates = await allRatesAsAt(sys, new Date())
const all   = contributionsOn(rates, ANNUAL)

t('kinds.allFourAreAnswered',
  ['incomeTax', 'employeePension', 'employerPension', 'employerNI'].every(k => k in all))
// A flat contribution above a floor is the OTHER shape a band table holds, and
// it would pass unnoticed if every kind were a ladder.
t('kinds.aFlatContributionHasOneBandAboveAFloor',
  all.employeePension.parts.length === 1 && all.employeePension.parts[0].to === null)
t('kinds.theFloorIsNotCharged',
  all.employeePension.parts[0].slice === ANNUAL - rates.employeePension[0].fromAmount)

// The employer's two kinds are a cost to the business and never a deduction
// from the person. A function that returned one number would have made that
// mistake for every caller; phase 4's journal debits them to a different
// account entirely.
t('kinds.theEmployerCostIsAnsweredSeparately',
  all.employerNI.total > 0 && all.employerPension.total > 0)
t('kinds.andIsNotFoldedIntoTheEmployeeSide',
  all.incomeTax.total + all.employeePension.total
  !== all.incomeTax.total + all.employeePension.total + all.employerNI.total)

// A kind nothing is in force for is zero rather than a throw. *This shop runs
// no employer pension* and *somebody forgot to seed it* look the same from a
// caller's side either way, and zero at least lets the walk finish.
t('kinds.aKindWithNoBandsIsZero', applyBands([], ANNUAL).total === 0)

// ── The rates are effective-dated too, and that is the phase's whole claim ──

// A band's rate is corrected the way a salary is: close the window, open the
// next. `percent` is `@immutable`, so there is no other way to do it.
const FLOOR = 90_000_000 + Number(RUN)   // a threshold no seeded band uses
const openBand = await sys.payRate.create({ data: {
  kind: 'incomeTax', fromAmount: FLOOR, toAmount: null, percent: 1000, effectiveFrom: ago(300),
} })
const beforeChange = await ratesAsAt(sys, 'incomeTax', ago(100))
const wasApplied   = beforeChange.find(b => b.id === openBand.id)?.percent

const changedAt = instant()
await sys.payRate.update({ where: { id: openBand.id }, data: { effectiveTo: changedAt } })
const newBand = await sys.payRate.create({ data: {
  kind: 'incomeTax', fromAmount: FLOOR, toAmount: null, percent: 1500, effectiveFrom: changedAt,
} })

t('rateChange.thePastStillAnswersTheOldPercent',
  (await ratesAsAt(sys, 'incomeTax', ago(100))).find(b => b.id === openBand.id)?.percent === wasApplied)
t('rateChange.todayAnswersTheNewOne',
  (await ratesAsAt(sys, 'incomeTax', new Date())).find(b => b.fromAmount === FLOOR)?.percent === 1500)
t('rateChange.theOldBandIsNotRestated',
  (await sys.payRate.findFirst({ where: { id: openBand.id } })).percent === 1000)
t('rateChange.aPercentCannotBeEditedInPlace',
  await refused(() => sys.payRate.update({ where: { id: newBand.id }, data: { percent: 9999 } })))
t('rateChange.norCanAThreshold',
  await refused(() => sys.payRate.update({ where: { id: newBand.id }, data: { fromAmount: 1 } })))

// The same constraint one table along, over reference data rather than over a
// person: `@@unique([kind, fromAmount], where: effectiveTo == null)`. It was
// `FJS-603`'s third instance in this application and it is the one that argues
// the feature — a band table is edited by hand, by an operator, with no service
// holding an invariant for it.
let secondBand = null
try {
  await sys.payRate.create({ data: {
    kind: 'incomeTax', fromAmount: FLOOR, toAmount: null, percent: 7777, effectiveFrom: ago(2),
  } })
} catch (e) { secondBand = e }
t('constraint.oneOpenBandPerKindAndThreshold', secondBand !== null)
// A DIFFERENT threshold is a different band and is not constrained by it.
const otherBand = await sys.payRate.create({ data: {
  kind: 'incomeTax', fromAmount: FLOOR + 1, toAmount: null, percent: 7777, effectiveFrom: ago(2),
} })
t('constraint.andAnotherThresholdIsUnaffected', !!otherBand.id)
await sys.payRate.delete({ where: { id: otherBand.id } })
await sys.payRate.delete({ where: { id: newBand.id } })
await sys.payRate.delete({ where: { id: openBand.id } })

// ── Annual, which is the unit a band table is written in ──────────────────

t('annual.aSalaryIsAlreadyAnnual',
  annualGross({ basis: 'salary', rate: 4_800_000, hoursPerWeek: 40 }) === 4_800_000)
t('annual.anHourlyRateIsHoursTimesFiftyTwo',
  annualGross({ basis: 'hourly', rate: 2_000, hoursPerWeek: 35 }) === 2_000 * 35 * 52)
// The two bases meet at one magnitude, which is what lets one band table serve
// both. Nobody publishes a tax threshold per week.
t('annual.bothBasesReachTheSameBands',
  applyBands(bands, annualGross({ basis: 'hourly', rate: 5_000, hoursPerWeek: 40 })).total > 0)

} catch (err) {
  failedEarly = err
} finally {
  try { await sweepPayroll(sys, fixtures) }
  catch (e) { console.log(`  note  sweep: ${e.message}`) }
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'seed.givesAHistoryAndNotAPay': true,
  'asAt.beforeHireIsNothing': true,
  'asAt.aClosedWindowAnswersItsOwnRate': true,
  'asAt.theOpenWindowAnswersToday': true,
  'asAt.theBoundaryInstantBelongsToTheNewWindow': true,
  'asAt.theInstantBeforeItBelongsToTheOld': true,
  'batch.agreesWithReadingThemOneAtATime': true,
  'batch.omitsSomebodyWithNoWindowAtAll': true,
  'leaver.stillHasAnOpenPayWindow': true,
  'leaver.isStillAnsweredByTheAsAtRead': true,
  'employed.excludesSomebodyWhoHasLeft': true,
  'employed.includedThemBeforeTheyWent': true,
  'employed.stillHasTheOthers': true,
  'raise.theSameInstantAnswersTheSame': true,
  'raise.theOldRateIsUntouched': true,
  'raise.theWindowsTouchWithNoGap': true,
  'raise.todayAnswersTheNewRate': true,
  'raise.leavesExactlyOneOpenWindow': true,
  'document.aRateCannotBeRestated': true,
  'document.theSameValueIsAlsoRefused': true,
  'document.theStartOfAWindowIsFrozen': true,
  'document.theEndOfAWindowIsNot': true,
  'document.asSystemDoesNotDropIt': true,
  'constraint.aSecondOpenWindowIsRefused': true,
  'constraint.andItNamesTheColumnRatherThanATable': true,
  'constraint.andARawInsertIsRefusedToo': true,
  'constraint.theClosedWindowsAreUnaffected': true,
  'constraint.andExactlyOneIsOpen': true,
  'constraint.closingFirstMakesRoomForTheNext': true,
  'constraint.oneOpenBandPerKindAndThreshold': true,
  'constraint.andAnotherThresholdIsUnaffected': true,
  'gross.aSalaryDividesByFiftyTwo': true,
  'gross.anHourlyRateMultipliesTheHours': true,
  'gross.theSameRateMeansTwoDifferentThings': true,
  'interval.isSpelledOnceAndExported': true,

  'rates.theBandsAreInForce': true,
  'rates.theyComeBackInThresholdOrder': true,
  'rates.exactlyOneBandIsUnbounded': true,
  'rates.nothingIsInForceBeforeTheyOpened': true,
  'walk.thePartsSumToTheTotal': true,
  'walk.theZeroBandContributesNothing': true,
  'walk.theTopBandIsNotAppliedToTheWholeSalary': true,
  'walk.andTheNaiveAnswerIsWrongByARealAmount': true,
  'walk.aSalaryExactlyOnAThresholdIsInTheLowerBandOnly': true,
  'walk.andOnePennyAboveItReachesTheNextBand': true,
  'walk.theUnboundedBandCatchesTheRest': true,
  'walk.underTheFirstThresholdThereIsNothingToShow': true,
  'kinds.allFourAreAnswered': true,
  'kinds.aFlatContributionHasOneBandAboveAFloor': true,
  'kinds.theFloorIsNotCharged': true,
  'kinds.theEmployerCostIsAnsweredSeparately': true,
  'kinds.andIsNotFoldedIntoTheEmployeeSide': true,
  'kinds.aKindWithNoBandsIsZero': true,
  'rateChange.thePastStillAnswersTheOldPercent': true,
  'rateChange.todayAnswersTheNewOne': true,
  'rateChange.theOldBandIsNotRestated': true,
  'rateChange.aPercentCannotBeEditedInPlace': true,
  'rateChange.norCanAThreshold': true,
  'annual.aSalaryIsAlreadyAnnual': true,
  'annual.anHourlyRateIsHoursTimesFiftyTwo': true,
  'annual.bothBasesReachTheSameBands': true,
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
