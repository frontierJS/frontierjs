// api/src/domain/payroll/payroll.ts — one period, everybody, and the run that produces it.
//
// This is where `payslip.ts` (what one person is owed), `arrears.ts` (what an
// earlier period still owes them) and `ledger.ts` (what the books record) meet.
// Nothing here decides an amount on its own: every figure is read as at the
// period END through the one as-at read, and every rate through the one band
// walk, so a run recalculated in June produces March's numbers.
//
// The two documents are the payslip — one per person, immutable — and the
// journal — one per RUN, because the books record a payroll rather than a
// person.

import { occurrenceKey }                  from '@frontierjs/toolbelt/history'
import { employedAt, payAsAtMany, instant } from './employment.ts'
import { allRatesAsAt }                   from './payrates.ts'
import { postJournal }                    from '../ledger.ts'
import { arrearsFor }                     from './arrears.ts'
import { draftPayslip, withArrears, assertPayslipAddsUp } from './payslip.ts'

/** A Litestone client of some flavour — `inventory.ts`'s reason, unchanged. */
type Client = Record<string, any>

// ─── the batch ────────────────────────────────────────────────────────────
//
// A pay run is five thousand people, and that is a different program from the
// one that pays three.
//
//   * ONE TRANSACTION IS WRONG. Five thousand payslips in a single write holds
//     a lock for minutes and rolls the whole month back because one person has
//     a gap in their pay history.
//   * PARTIAL FAILURE IS NORMAL, so the run has to be RESUMABLE — able to be
//     started again over the same period and do only what is left.
//   * AND RE-RUNNABLE WITHOUT PAYING ANYBODY TWICE, which is a different
//     property from resumable and is the one that costs real money.
//
// The unit of work is therefore ONE PERSON, not one run and not a chunk. That
// is what makes the idempotency key natural — `occurrenceKey('payslip', runId,
// employeeId)` names a fact rather than a position — and a chunk index does
// not: a roster that changes between two dispatches puts different people in
// chunk 7, so the key stops meaning anything. The cost is N dispatches, which
// is what a queue is for.
//
// `@@unique([payRunId, employeeId])` is the floor under all of it. Even if
// every guard above failed, the database refuses the second payslip.

/**
 * Decide who is in the run, and stamp how many that is.
 *
 * Cheap and synchronous, and it happens BEFORE any payslip exists. `headcount`
 * is what lets a worker holding one employee decide whether it just finished
 * the run — nothing else in a batch of five thousand knows how big the batch
 * was.
 *
 * `at` is the period END, so somebody hired after the run was planned does not
 * move the finish line half way through.
 */
export async function planPayRun(client: Client, runId: number): Promise<{ run: any, employeeIds: number[] }> {
  const run = await client.payRun.findFirst({ where: { id: runId } })
  if (!run) throw payrollError('No such pay run', 404)
  if (run.status !== 'draft') throw payrollError(`${run.reference} is ${run.status}; only a draft can be planned`)

  const at      = instant(run.periodEnd)
  const staff   = await employedAt(client, at)
  const windows = await payAsAtMany(client, staff.map((e: any) => e.id), at)

  // Employed with no pay window in force is a gap somebody left, and it is
  // excluded from the headcount rather than counted and skipped later — a run
  // whose headcount can never be reached never finishes.
  const employeeIds = staff.filter((e: any) => windows.has(e.id)).map((e: any) => e.id)

  await client.payRun.update({
    where: { id: run.id }, data: { headcount: employeeIds.length }, system: ['headcount'],
  })
  return { run: { ...run, headcount: employeeIds.length }, employeeIds }
}

/**
 * One person's payslip. **The unit of work, and it is idempotent.**
 *
 * Answers `false` where the payslip already exists rather than throwing,
 * because *this was already done* is the normal answer on a resume and on a
 * redelivered job — the queue is at-least-once by design, so a handler that
 * threw on a duplicate would fail a fifth of a re-run.
 */
export async function calculatePayslipFor(
  client: Client, runId: number, employeeId: number,
): Promise<{ made: boolean, net: number }> {
  const run = await client.payRun.findFirst({ where: { id: runId } })
  if (!run) throw payrollError('No such pay run', 404)
  if (run.status !== 'draft') throw payrollError(`${run.reference} is ${run.status}; payslips are written while it is a draft`)

  const held = await client.payslip.findFirst({ where: { payRunId: runId, employeeId } })
  if (held) return { made: false, net: held.net }

  const person = await client.employee.findFirst({ where: { id: employeeId } })
  if (!person) throw payrollError('No such employee', 404)

  const at      = instant(run.periodEnd)
  const rates   = await allRatesAsAt(client, at)
  const windows = await payAsAtMany(client, [employeeId], at)
  const window  = windows.get(employeeId)
  if (!window) throw payrollError(`${person.reference} had no pay window in force on ${at}`)

  const period = draftPayslip(employeeId, window as any, rates, run.periodsPerYear, run.periodIndex)

  // What earlier PAID periods still owe them, folded on as ordinary lines.
  //
  // It is computed here rather than by a sweep somewhere, and that is forced
  // rather than chosen: nothing declares that writing a pay window invalidated
  // three payslips, so there is no moment at which a cascade could have been
  // triggered. What is left is to ask the question every time a payslip is
  // written, which is also the only formulation that survives a run being
  // reverted and recalculated (`arrears.ts` says why at length).
  const { lines: owed } = await arrearsFor(client, employeeId)
  const draft = withArrears(period, owed)
  assertPayslipAddsUp(draft, `${run.reference}/${person.reference}`)

  const slip = await client.payslip.create({ data: {
    reference:   `${run.reference}-${person.reference}`,
    payRunId:    run.id,
    employeeId:  draft.employeeId,
    payWindowId: draft.payWindowId,
    periodStart: run.periodStart,
    periodEnd:   run.periodEnd,
    gross:       draft.gross,
    deductions:  draft.deductions,
    net:         draft.net,
    employerCost: draft.employerCost,
  } })
  await client.payslipLine.createMany({ data: draft.lines.map(l => ({
    ...l, payslipId: slip.id, correctsPayRunId: l.correctsPayRunId ?? null,
  })) })

  return { made: true, net: draft.net }
}

/**
 * Move the run to `calculated` if every payslip is now written.
 *
 * Called by each worker, so N of them race for the last one — and the guard is
 * the STATE MACHINE rather than a lock. `calculate` is `draft -> calculated`,
 * so the second caller's transition is refused by the Data boundary and there
 * is nothing here to get wrong. Answers whether it was this call that finished
 * the run, which is what a worker logs.
 */
export async function completeIfDone(client: Client, runId: number): Promise<boolean> {
  // The whole check-and-move is one transaction, and what holds it is the
  // `status !== 'draft'` READ above rather than the transition below.
  //
  // Litestone opens a transaction with BEGIN IMMEDIATE, which takes the write
  // lock up front, so the second worker in waits and then reads the status the
  // first one wrote — and returns false. That is the same argument
  // `carts.checkout` makes about a discount redemption, one layer along, and it
  // is why `transactional:` is on every method in this domain that moves a run.
  //
  // The state machine is a second answer and NOT the one operating here: this
  // runs on `asSystem()` for the ledger's sake, and `asSystem()` bypasses
  // `@@transitions` like every other rule in this package. For an ordinary
  // caller the boundary now refuses the second move by name (`FJS-611`) — it
  // used to answer success, which is why the read is what this function
  // actually rests on.
  return await client.$transaction(async (tx: Client) => {
    const run = await tx.payRun.findFirst({ where: { id: runId } })
    if (!run || run.status !== 'draft' || run.headcount == null) return false

    const made = await tx.payslip.count({ where: { payRunId: runId } })
    if (made < run.headcount) return false

    await tx.payRun.transition(runId, 'calculate')
    return true
  })
}

/**
 * The synchronous driver, for a run small enough to do in one go.
 *
 * It is the SAME unit of work the queue drives, in a loop, which is the whole
 * point: two code paths for *what a payslip is* is how they drift, and this one
 * exists so a three-person shop and a five-thousand-person one produce
 * identical documents.
 */
export async function calculatePayRun(client: Client, runId: number): Promise<{ payslips: number, gross: number, net: number }> {
  const { run, employeeIds } = await planPayRun(client, runId)

  let made = 0, net = 0
  for (const employeeId of employeeIds) {
    const r = await calculatePayslipFor(client, runId, employeeId)
    if (r.made) made++
    net += r.net
  }
  await completeIfDone(client, runId)

  const slips = await client.payslip.findMany({ where: { payRunId: runId }, limit: 5000 })
  return { payslips: made, gross: slips.reduce((n: number, s: any) => n + s.gross, 0), net }
}

/**
 * Take a calculated run back to draft, removing what it produced.
 *
 * **This function is the rule the schema cannot state.** `Payslip` is
 * `@@gate("5.5.9.8")` — the system may delete one — because reverting has to
 * take the payslips with it or the recalculation collides on
 * `@@unique([payRunId, employeeId])`. What a gate cannot say is that removal is
 * only ordinary while the run is a DRAFT: a payslip under a paid run is a
 * document, and a gate is per model rather than per state.
 *
 * So the state check is here, and it is the fourth cross-row rule this
 * application enforces in application code — after `Invoice.subtotal`, the
 * journal balance, and *the lines that count sum to net*. It is a different
 * SHAPE from the other three, which is why it is worth counting separately:
 * they aggregate a child, this one reads a parent's state before touching one.
 */
export async function revertPayRun(client: Client, runId: number): Promise<{ removed: number }> {
  const run = await client.payRun.findFirst({ where: { id: runId } })
  if (!run) throw payrollError('No such pay run', 404)
  if (run.status !== 'calculated') throw payrollError(
    `${run.reference} is ${run.status}; only a calculated run can be taken back to draft`)

  const slips = await client.payslip.findMany({ where: { payRunId: run.id }, limit: 5000 })
  if (slips.length) {
    await client.payslipLine.deleteMany({ where: { payslipId: { in: slips.map((s: any) => s.id) } } })
    await client.payslip.deleteMany({ where: { payRunId: run.id } })
  }
  await client.payRun.transition(run.id, 'revert')
  return { removed: slips.length }
}

/**
 * Pay the run: post one journal for the whole thing, then move it.
 *
 * ONE journal and not one per payslip, because a journal is what the books
 * record and the books record a payroll, not a person. The per-person detail is
 * the payslip, which is a document of its own.
 *
 *   DEBIT   wagesExpense     gross + employer cost   what it cost the business
 *   CREDIT  payeControl      income tax              owed to the state
 *   CREDIT  pensionControl   both pension sides      owed to the scheme
 *   CREDIT  niControl        employer NI             owed to the state
 *   CREDIT  netPayControl    net                     owed to the people
 *
 * It balances for the same reason phase 1's sale does — by identity rather than
 * by arithmetic luck. `net = gross − tax − employee pension` and
 * `employerCost = employer pension + employer NI`, so the debit is exactly the
 * sum of the five credits.
 */
export async function payPayRun(
  client: Client, runId: number,
  { dispatchSend }: { dispatchSend?: (payslipId: number, key: string) => Promise<unknown> } = {},
): Promise<{ journal: string, debit: number, queued: number }> {
  const run = await client.payRun.findFirst({ where: { id: runId } })
  if (!run) throw payrollError('No such pay run', 404)
  if (run.status !== 'approved') throw payrollError(`${run.reference} is ${run.status}; only an approved run can be paid`)

  const slips = await client.payslip.findMany({ where: { payRunId: run.id }, limit: 5000 })
  if (!slips.length) throw payrollError(`${run.reference} has no payslips to pay`)

  const ids   = slips.map((s: any) => s.id)
  const lines = await client.payslipLine.findMany({ where: { payslipId: { in: ids } }, limit: 50_000 })

  // SIGNED, never `Math.abs`. A deduction is carried negative and an employer
  // contribution positive, so the sign already says which side of the books a
  // kind belongs on, and the magnitude throws that away.
  //
  // It was written with `Math.abs` and the two agreed everywhere reachable —
  // and the reason they do is worth knowing rather than being lucky about. A
  // backdated pay CUT makes an individual `incomeTax` line positive, which is a
  // refund; for a whole RUN's tax to come out positive the refund would have to
  // exceed the period's own tax, which needs a gross reduction larger than the
  // period's own gross, which `Payslip.gross @gte(0)` refuses one step earlier
  // (`verify:retro`, § floor). So the magnitude was correct by a constraint
  // three tables away rather than by anything said here.
  const by = (kind: string) =>
    lines.filter((l: any) => l.kind === kind).reduce((n: number, l: any) => n + l.amount, 0)

  const gross        = slips.reduce((n: number, s: any) => n + s.gross, 0)
  const net          = slips.reduce((n: number, s: any) => n + s.net, 0)
  const employerCost = slips.reduce((n: number, s: any) => n + s.employerCost, 0)

  const entry = await postJournal(client, {
    reference: `JNL-${run.reference}`,
    narrative: `Payroll — ${run.reference}`,
    source:    'payroll',
    payRunId:  run.id,
    lines: [
      { account: 'wagesExpense',   amount:  gross + employerCost },
      { account: 'payeControl',    amount:  by('incomeTax') },
      { account: 'pensionControl', amount:  by('employeePension') - by('employerPension') },
      { account: 'niControl',      amount: -by('employerNI') },
      { account: 'netPayControl',  amount: -net },
    ],
  })

  await client.payRun.transition(run.id, 'pay')
  await client.payRun.update({ where: { id: run.id }, data: { paidAt: instant() }, system: ['paidAt'] })

  // The irreversible half, and it is handed out rather than done here.
  //
  // A payslip going out cannot be taken back, so it must not be a side effect
  // of this function succeeding — it must be a durable intent that commits with
  // the transition or not at all. The service passes `$.enqueue`, which writes
  // an outbox row inside the same transaction; a caller with no service context
  // (a script, a drive) passes its own dispatcher or none.
  //
  // The key is the DISPATCH ID and not a `unique` lock, which is the opposite
  // choice from `calculate-payslip` and for the opposite reason — see
  // `api/src/jobs/send-payslip.job.ts`.
  let queued = 0
  if (dispatchSend) {
    for (const slip of slips) {
      await dispatchSend(slip.id, occurrenceKey('payslip-sent', String(slip.id)))
      queued++
    }
  }

  return { journal: entry.reference, debit: gross + employerCost, queued }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** 409 by default: every one of these is a state somebody can put right. */
function payrollError(message: string, status = 409) {
  return Object.assign(new Error(message), { status })
}
