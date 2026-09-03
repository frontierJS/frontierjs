// api/jobs/calculate-payslip.job.ts — one person's payslip, as a unit of work.
//
// A pay run is five thousand of these. The reason the unit is one PERSON rather
// than one run or one chunk is the idempotency key: `occurrenceKey('payslip',
// runId, employeeId)` names a fact, and a chunk index does not — a roster that
// changes between two dispatches puts different people in chunk 7.
//
// ─── `unique` and not `id`, and the reason is the opposite of FJS-609's ───
//
// `dispatch({ id })` is the jobs table's PRIMARY KEY, so it is a no-op for all
// time. That is exactly right for something irreversible (see
// `send-payslip.job.ts`) and exactly wrong here: a worker that crashed half way
// through the month has to be able to be told to do it again, and under `id`
// that dispatch would be swallowed and the payslip never written.
//
// So this uses `unique`, which is a lock on work IN FLIGHT and frees the moment
// the job is terminal — and the handler is idempotent instead, which is the
// half that actually stops double payment. `@@unique([payRunId, employeeId])`
// is the floor under both.

import { defineJob }       from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { db }              from '../core/db.ts'
import { calculatePayslipFor, completeIfDone } from '../domain/payroll'

export type CalculatePayslipPayload = { runId: number, employeeId: number }

/**
 * The work, exported so a drive can run it and read the answer.
 *
 * `JobHandler` returns void by contract, so the handler below awaits this and
 * discards — the same split `dun-subscriptions` makes, and for the same reason:
 * what the job DID is a fact worth asserting and the queue has no use for it.
 */
export async function calculatePayslipJob(
  ctx: JobContext<CalculatePayslipPayload>,
): Promise<{ made: boolean, finished: boolean }> {
  const sys = db.asSystem() as Record<string, any>
  const { runId, employeeId } = ctx.data

  const { made } = await calculatePayslipFor(sys, runId, employeeId)

  // Every worker asks, and one of them finishes the run. The guard is inside
  // `completeIfDone` and it is a TRANSACTION rather than the state machine —
  // `transition()` is read-then-write and four concurrent callers all succeed
  // (`FJS-611`), which is exactly the shape a batch produces.
  const finished = await completeIfDone(sys, runId)

  return { made, finished }
}

export default defineJob<CalculatePayslipPayload>(
  'calculate-payslip',
  async (ctx: JobContext<CalculatePayslipPayload>) => { await calculatePayslipJob(ctx) },
  // Three attempts: a payslip calculation reads four tables and writes two, so
  // the failures worth retrying are contention rather than arithmetic. An
  // arithmetic failure throws the same way three times and ends up on the dead
  // list, which is where somebody should be looking at it.
  { maxAttempts: 3 },
)
