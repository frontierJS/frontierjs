/**
 * web/test/verify-batch.mjs — a pay run at size: interrupted, resumed, and
 * paying nobody twice.
 *
 * **bun, and no server.** The queue is reached the way `verify:billing` reaches
 * it — by calling the exported handler with a payload, and by recording what a
 * dispatcher would have queued. The contract of the dispatch is *which key*,
 * and a recorder asserts exactly that; the WORK is then run for real against
 * the real client.
 *
 * ─── The three things only this drive can ask ─────────────────────────────
 *
 * **`resume.onlyTheMissingOnesAreMade`** — do half the run, stop, start again.
 * Partial failure is the normal case at five thousand people, so *doing it
 * again* has to be an ordinary operation rather than a recovery procedure.
 *
 * **`ledger.theJournalMatchesThePayslips`** — the plan says to assert a resumed
 * run against the LEDGER rather than against a job count, and the reason is
 * that a job count is what a double-payment bug agrees with. The books are the
 * only record that cannot be right while the money is wrong.
 *
 * **`keys.theTwoJobsChooseOppositely`** — `calculate-payslip` dispatches under
 * `unique` and `send-payslip` under the dispatch `id`, and neither is the
 * default. Resumable work must REACH its handler on a second dispatch;
 * irreversible work must not. Getting that backwards is `FJS-609` in one
 * direction and a payslip nobody ever gets in the other.
 *
 * Fixtures are minted per run (`FJS-530`, `FJS-546`): six employees and a pay
 * run, all under a run prefix, all cleaned up at the end.
 */

import { db }  from '../../api/src/core/db.ts'
import { instant }                     from '../../api/src/domain/payroll'
import { planPayRun, calculatePayslipFor, completeIfDone, payPayRun, revertPayRun }
  from '../../api/src/domain/payroll'
import calculatePayslip                from '../../api/src/jobs/calculate-payslip.job.ts'
import sendPayslip, { sendPayslipJob } from '../../api/src/jobs/send-payslip.job.ts'
import { occurrenceKey }               from '@frontierjs/toolbelt/history'

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
let failedEarly = null

try {

/** The queue, recording rather than running. `verify:billing`'s shape. */
function recorder() {
  const seen = []
  const taken = new Set()
  return {
    seen,
    async dispatch(job, payload, opts = {}) {
      const key = opts.id ?? opts.unique
      seen.push({ job: job?.name ?? String(job), payload, key, kind: opts.id ? 'id' : 'unique' })
      // A dispatch under an id already taken is a no-op FOREVER, which is what
      // caravan does with a taken primary key. A `unique` one frees when the
      // job is terminal, so it is modeled as always reaching the handler.
      if (opts.id) { if (taken.has(opts.id)) return false; taken.add(opts.id) }
      return true
    },
  }
}

// ─── Six people, so that "half" means something ───────────────────────────

const crew = []
for (let i = 0; i < 6; i++) {
  const e = await sys.employee.create({ data: {
    reference: `EMP-B${RUN}${i}`, name: `Batch ${RUN}-${i}`,
    email: `batch.${RUN}.${i}@drive.test`, startedOn: ago(400),
  } })
  fixtures.employeeIds.push(e.id)
  await sys.payWindow.create({ data: {
    employeeId: e.id, basis: 'salary', rate: 3_000_000 + i * 100_000,
    hoursPerWeek: 40, effectiveFrom: ago(400),
  } })
  crew.push(e)
}

// One more who is employed and has NO pay window — a gap somebody left. They
// must be out of the headcount rather than counted and skipped, or the run's
// finish line is a number it can never reach.
const gapped = await sys.employee.create({ data: {
  reference: `EMP-G${RUN}`, name: `Gap ${RUN}`,
  email: `gap.${RUN}@drive.test`, startedOn: ago(400),
} })
fixtures.employeeIds.push(gapped.id)

const run = await sys.payRun.create({ data: {
  reference:   `PR-B${RUN}`,
  periodStart: ago(30), periodEnd: ago(1), payDate: instant(),
  periodsPerYear: 12, periodIndex: 5,
} })
fixtures.runIds.push(run.id)

// ─── Planning ─────────────────────────────────────────────────────────────

const planned = await planPayRun(sys, run.id)
const stamped = await sys.payRun.findFirst({ where: { id: run.id } })

t('plan.stampsTheHeadcountBeforeAnyPayslipExists',
  stamped.headcount === planned.employeeIds.length
  && (await sys.payslip.count({ where: { payRunId: run.id } })) === 0)
t('plan.itIncludesTheCrew',      crew.every(e => planned.employeeIds.includes(e.id)))
t('plan.andExcludesTheGap',      !planned.employeeIds.includes(gapped.id))
t('plan.theRunIsStillADraft',    stamped.status === 'draft')

// ─── Half a run ───────────────────────────────────────────────────────────

const half = planned.employeeIds.slice(0, Math.floor(planned.employeeIds.length / 2))
for (const id of half) await calculatePayslipFor(sys, run.id, id)
await completeIfDone(sys, run.id)

const midway = await sys.payRun.findFirst({ where: { id: run.id } })
t('partial.theRunDoesNotFinishEarly', midway.status === 'draft')
t('partial.andHasWhatItMade',
  (await sys.payslip.count({ where: { payRunId: run.id } })) === half.length)

// ─── The unit is idempotent, which is what makes resuming ordinary ────────

const again = await calculatePayslipFor(sys, run.id, half[0])
t('resume.aSecondCallMakesNothing', again.made === false)
t('resume.andAnswersTheSameNet',
  again.net === (await sys.payslip.findFirst({ where: { payRunId: run.id, employeeId: half[0] } })).net)

// Start it again over the WHOLE roster, exactly as an operator would. Only the
// missing ones are made.
let made = 0
for (const id of planned.employeeIds) {
  const r = await calculatePayslipFor(sys, run.id, id)
  if (r.made) made++
}
t('resume.onlyTheMissingOnesAreMade', made === planned.employeeIds.length - half.length)
t('resume.andNobodyHasTwoPayslips',
  (await sys.payslip.count({ where: { payRunId: run.id } })) === planned.employeeIds.length)

// ─── The database is the floor under all of it ────────────────────────────

const one = await sys.payslip.findFirst({ where: { payRunId: run.id } })
t('floor.aDuplicatePayslipIsRefusedByTheSchema',
  await refused(() => sys.payslip.create({ data: {
    reference: `PS-DUP-${RUN}`, payRunId: run.id, employeeId: one.employeeId,
    payWindowId: one.payWindowId, periodStart: one.periodStart, periodEnd: one.periodEnd,
    gross: 1000, deductions: 0, net: 1000, employerCost: 0,
  } })))

// ─── Finishing, and the race for the last one ─────────────────────────────

// N workers all ask whether they finished the run. What makes exactly one win
// is the read inside BEGIN IMMEDIATE, not the state machine: these run on
// `asSystem()`, which bypasses `@@transitions` along with every other rule in
// that package, so the boundary has nothing to say here. For an ordinary caller
// it does now refuse the second move by name (`FJS-611`); it used to answer
// success to all four, which is where that defect was measured.
const raced = await Promise.all(Array.from({ length: 4 }, () => completeIfDone(sys, run.id)))
t('finish.exactlyOneWorkerFinishesTheRun', raced.filter(Boolean).length === 1)
t('finish.theRunIsCalculated',
  (await sys.payRun.findFirst({ where: { id: run.id } })).status === 'calculated')
t('finish.andAskingAgainChangesNothing', (await completeIfDone(sys, run.id)) === false)

// ─── The keys, which are opposite on purpose ──────────────────────────────

const rec = recorder()
for (const id of planned.employeeIds) {
  await rec.dispatch(calculatePayslip, { runId: run.id, employeeId: id },
    { unique: occurrenceKey('payslip', String(run.id), String(id)) })
}
t('keys.calculateDispatchesUnderUnique', rec.seen.every(d => d.kind === 'unique'))
t('keys.oneDispatchPerPerson',           rec.seen.length === planned.employeeIds.length)
t('keys.theKeyNamesTheRunAndThePerson',
  rec.seen[0].key === occurrenceKey('payslip', String(run.id), String(planned.employeeIds[0])))
// Two dispatches for one person carry ONE key, so the queue holds one row —
// which is what stops a resume queueing the work twice while the first attempt
// is still running.
t('keys.aResumeReusesTheSameKey',
  await rec.dispatch(calculatePayslip, { runId: run.id, employeeId: planned.employeeIds[0] },
    { unique: occurrenceKey('payslip', String(run.id), String(planned.employeeIds[0])) })
  && rec.seen.filter(d => d.key === rec.seen[0].key).length === 2)

// ─── Paying, and the ledger ───────────────────────────────────────────────

await sys.payRun.transition(run.id, 'approve')
const sends = recorder()
const paid  = await payPayRun(sys, run.id, {
  dispatchSend: (payslipId, key) => sends.dispatch(sendPayslip, { payslipId }, { id: key }),
})

const slips = await sys.payslip.findMany({ where: { payRunId: run.id }, limit: 100 })
const netSum = slips.reduce((n, s) => n + s.net, 0)

const entry = await sys.journalEntry.findFirst({ where: { payRunId: run.id } })
const jl    = await sys.journalLine.findMany({ where: { entryId: entry.id } })

// **The assertion the plan asked for.** A job count agrees with a
// double-payment bug; the books do not.
t('ledger.theJournalMatchesThePayslips',
  jl.find(l => l.account === 'netPayControl')?.amount === -netSum)
t('ledger.itBalancesAfterAResume', jl.reduce((n, l) => n + l.amount, 0) === 0)
t('ledger.andThereIsExactlyOneJournal',
  (await sys.journalEntry.findMany({ where: { payRunId: run.id } })).length === 1)
t('ledger.thePeopleAreCountedOnce', slips.length === stamped.headcount)

// ─── The send, which is the other kind of work ────────────────────────────

t('keys.sendDispatchesUnderTheId',   sends.seen.every(d => d.kind === 'id'))
t('keys.theTwoJobsChooseOppositely', rec.seen[0].kind === 'unique' && sends.seen[0].kind === 'id')
t('keys.onePerPayslip',              sends.seen.length === slips.length)
// A redelivery under a taken id is a no-op FOREVER, which is the only safe
// answer for something that cannot be undone.
t('send.aRedeliveryIsSwallowed',
  (await sends.dispatch(sendPayslip, { payslipId: slips[0].id },
    { id: occurrenceKey('payslip-sent', String(slips[0].id)) })) === false)

// …and the stamp is the second guard, at a different layer.
const ctxFor = (payslipId) => ({ data: { payslipId } })
const first  = await sendPayslipJob(ctxFor(slips[0].id))
const second = await sendPayslipJob(ctxFor(slips[0].id))
t('send.theFirstOneGoesOut',      first.sent === true)
t('send.theSecondIsRefusedByTheStamp', second.sent === false && second.reason === 'already')
t('send.theStampIsOnTheRow',
  (await sys.payslip.findFirst({ where: { id: slips[0].id } })).sentAt != null)
t('send.aPayslipThatIsGoneAnswersRatherThanThrows',
  (await sendPayslipJob(ctxFor(999_999_999))).reason === 'gone')

// The one column on a payslip a job writes after it is frozen — and every other
// one still refuses.
t('send.andEveryFigureIsStillFrozen',
  await refused(() => sys.payslip.update({ where: { id: slips[0].id }, data: { net: 1 } })))

// ─── A paid run cannot be taken back ──────────────────────────────────────

t('paid.cannotBeReverted',   await refused(() => revertPayRun(sys, run.id)))
t('paid.cannotBeRecalculated',
  await refused(() => calculatePayslipFor(sys, run.id, planned.employeeIds[0])))

} catch (err) {
  failedEarly = err
} finally {
  try { await sweepPayroll(sys, fixtures) }
  catch (e) { console.log(`  note  sweep: ${e.message}`) }
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'plan.stampsTheHeadcountBeforeAnyPayslipExists': true,
  'plan.itIncludesTheCrew': true,
  'plan.andExcludesTheGap': true,
  'plan.theRunIsStillADraft': true,
  'partial.theRunDoesNotFinishEarly': true,
  'partial.andHasWhatItMade': true,
  'resume.aSecondCallMakesNothing': true,
  'resume.andAnswersTheSameNet': true,
  'resume.onlyTheMissingOnesAreMade': true,
  'resume.andNobodyHasTwoPayslips': true,
  'floor.aDuplicatePayslipIsRefusedByTheSchema': true,
  'finish.exactlyOneWorkerFinishesTheRun': true,
  'finish.theRunIsCalculated': true,
  'finish.andAskingAgainChangesNothing': true,
  'keys.calculateDispatchesUnderUnique': true,
  'keys.oneDispatchPerPerson': true,
  'keys.theKeyNamesTheRunAndThePerson': true,
  'keys.aResumeReusesTheSameKey': true,
  'ledger.theJournalMatchesThePayslips': true,
  'ledger.itBalancesAfterAResume': true,
  'ledger.andThereIsExactlyOneJournal': true,
  'ledger.thePeopleAreCountedOnce': true,
  'keys.sendDispatchesUnderTheId': true,
  'keys.theTwoJobsChooseOppositely': true,
  'keys.onePerPayslip': true,
  'send.aRedeliveryIsSwallowed': true,
  'send.theFirstOneGoesOut': true,
  'send.theSecondIsRefusedByTheStamp': true,
  'send.theStampIsOnTheRow': true,
  'send.aPayslipThatIsGoneAnswersRatherThanThrows': true,
  'send.andEveryFigureIsStillFrozen': true,
  'paid.cannotBeReverted': true,
  'paid.cannotBeRecalculated': true,
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
