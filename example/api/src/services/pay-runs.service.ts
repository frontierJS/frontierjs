// A period's payroll.
//
// Three of the four moves are the engine's and one is a person's, so this
// service is mostly a read surface with one button on it. `calculate` and `pay`
// are custom methods rather than transitions a caller states, because each of
// them WRITES documents before it moves the row — a caller who could state the
// transition directly would mark a run calculated with no payslips under it.
//
// `approve` is deliberately NOT a method here. It is a declared transition at
// `@gate(5)`, so a caller moves it with an ordinary patch and the Data boundary
// grades them — which is the whole point of putting the level in the schema
// rather than in a hook.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'
import { calculatePayRun, planPayRun, payPayRun, revertPayRun } from '../domain/payroll'
import { occurrenceKey }                  from '@frontierjs/toolbelt/history'
import calculatePayslip                   from '../jobs/calculate-payslip.job.ts'
import sendPayslip                        from '../jobs/send-payslip.job.ts'

export function createPayRunsService() {
  return createBaseService({
    model:   'PayRun',
    channel: 'pay-runs',

    /**
     * Plan the run and queue a worker per person.
     *
     * It does NOT compute anything. Five thousand payslips in one request is a
     * request that times out, holds a write lock for minutes, and rolls the
     * whole month back because one person has a gap in their pay history — so
     * what this answers is *the work is queued*, and the run finishes when the
     * last worker notices it was the last.
     *
     * `unique` and not `id` on the dispatch: the work is resumable, so a second
     * `calculate` after a crash has to REACH the handler rather than being
     * swallowed by a taken primary key. The handler is idempotent instead
     * (`api/src/jobs/calculate-payslip.job.ts` says why at length).
     */
    calculate: async () => {
      const db  = $.db as any
      const run = await db.payRun.findFirst({ where: { id: Number($.id) } })
      if (!run) throw new NotFound('No such pay run')

      // The SYSTEM client: `calculate` is `@system` on the transition and every
      // figure on a payslip is a `@system` column, so this is the shop
      // recording its own act. What the CALLER may do is graded above — the
      // model's own `@@gate` refused them before this line ran.
      const { employeeIds } = await planPayRun(db.asSystem(), run.id)

      let queued = 0
      for (const employeeId of employeeIds) {
        await ($.app as any)?.jobs?.dispatch?.(
          calculatePayslip, { runId: run.id, employeeId },
          { unique: occurrenceKey('payslip', String(run.id), String(employeeId)) },
        )
        queued++
      }
      return { headcount: employeeIds.length, queued }
    },

    /**
     * The synchronous driver, for a shop small enough not to need a queue.
     *
     * Same unit of work, in a loop. It exists because a three-person shop
     * should not have to run a worker to be paid, and because two
     * implementations of *what a payslip is* is how they drift.
     */
    calculateNow: async () => {
      const run = await ($.db as any).payRun.findFirst({ where: { id: Number($.id) } })
      if (!run) throw new NotFound('No such pay run')
      return await calculatePayRun(($.db as any).asSystem(), run.id)
    },

    /**
     * Post the journal, move it to `paid`, and queue the payslips going out.
     *
     * The send goes through `$.enqueue` and not `$.app.jobs.dispatch`, and the
     * difference is the whole reason the outbox exists: this method is
     * `transactional:`, so the intent to send commits with the journal or rolls
     * back with it. A dispatch straight into the queue would send payslips for
     * a run whose journal failed to post.
     */
    pay: async () => {
      const run = await ($.db as any).payRun.findFirst({ where: { id: Number($.id) } })
      if (!run) throw new NotFound('No such pay run')
      return await payPayRun(($.db as any).asSystem(), run.id, {
        dispatchSend: (payslipId) => $.enqueue(sendPayslip, { payslipId }),
      })
    },

    /** Back to draft, taking the payslips with it. See `revertPayRun`: the
     *  rule that only a CALCULATED run may be taken back cannot be a gate,
     *  because a gate is per model and this is per state. */
    revert: async () => {
      const run = await ($.db as any).payRun.findFirst({ where: { id: Number($.id) } })
      if (!run) throw new NotFound('No such pay run')
      return await revertPayRun(($.db as any).asSystem(), run.id)
    },

    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove',
      'calculate', 'calculateNow', 'revert', 'pay',
    ],

    // Each of these writes documents and then moves a row. A crash between the
    // two would leave a draft with payslips under it, or an approved run with
    // no journal — both states somebody has to unpick by hand.
    transactional: ['calculateNow', 'revert', 'pay'],
  })
}
