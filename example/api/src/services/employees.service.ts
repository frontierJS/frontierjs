// The people this shop employs.
//
// Two custom methods and they are the two halves of effective dating: `setPay`
// WRITES a window and `payOn` READS one. Both go through
// `api/src/domain/payroll`, which owns the half-open interval — a where-clause
// spelled a second way here is a wrong salary once per raise.
//
// **This file is one of the two crossings** (`FJS-D288`). A pay window is dated
// in DAYS and a request arrives with a clock behind it, so `plainDateIn` turns
// *now* into a day in the shop's own calendar — `$.config.timeZone`, which
// resolves the calling shop's answer over the app's floor — and everything past
// that point is a `YYYY-MM-DD` with no zone attached to it. A shop in Auckland
// and a shop in Los Angeles setting pay in the same minute get the day each of
// them is actually having.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'
import { plainDateIn }                    from '@frontierjs/toolbelt/datetime'
import { payAsAt, assertEffectiveFrom }   from '../domain/payroll'

export function createEmployeesService() {
  return createBaseService({
    model:   'Employee',
    channel: 'employees',

    /**
     * Open a new pay window, closing the one that is open.
     *
     * **This is the second copy of `plans.reprice` in this application**, over
     * an unrelated noun, and the duplication is the finding rather than an
     * oversight (`IDEAS/shipped/payroll.md` phase 2). The four steps are identical:
     * find the open window, refuse two, close it at `now`, open the next.
     *
     * The schema says *one open window per parent* now
     * (`@@unique([employeeId], where: effectiveTo == null)`, `FJS-603`), so this
     * is no longer where the rule LIVES — it is where the rule is worded. The
     * boundary answers a 409 naming a column; this names the employee and says
     * what to do about it.
     *
     * Not factored into a shared helper on purpose: the two are the same four
     * steps over two different models, and a helper would hide that the second
     * write is what the constraint refuses rather than what it orders.
     */
    setPay: async () => {
      const db         = $.db as any
      const employeeId = Number($.id)
      const pay        = $.data as {
        basis: string, rate: number, hoursPerWeek?: number, effectiveFrom?: string
      }   // `effectiveFrom` is a plain date; the input type validates it
      const today = plainDateIn(Date.now(), $.config.timeZone)
      const at    = pay.effectiveFrom ?? today

      const employee = await db.employee.findFirst({ where: { id: employeeId } })
      if (!employee) throw new NotFound('No such employee')

      // Every window, not just the open one: `assertEffectiveFrom` needs the
      // closed ones to tell a FIRST window starting in the past — which is an
      // ordinary new hire — from one opening inside a history that is already
      // accounted for, which would put two windows over one day.
      const windows = await db.payWindow.findMany({
        where: { employeeId }, orderBy: { effectiveFrom: 'desc' }, limit: 100,
      })
      const open = windows.filter((w: { effectiveTo: string | null }) => !w.effectiveTo)

      // Two open windows is a person with two current salaries. It cannot be
      // put right from here — picking one would be this method inventing what
      // they were actually paid for the overlap.
      if (open.length > 1) {
        throw conflict(
          `${employee.reference} has ${open.length} open pay windows; close all but one before setting pay`)
      }

      // ─── the backdate ───────────────────────────────────────────────────
      //
      // A stated day in the PAST is a correction to what we believed, and it
      // reaches the same four steps with a different `at`. **That the two acts
      // are one write is the finding rather than a convenience**: the schema
      // holds VALID time and nothing records when we LEARNT something, so *this
      // is what they earn from today* and *this is what they should have been
      // earning since March* are indistinguishable afterwards.
      //
      // Which days are legal is `employment.ts`'s, not this file's — the rule
      // has one owner even though the four steps deliberately do not.
      assertEffectiveFrom(employee.reference, at, today, windows)

      // Closed on the day the next one opens, so the windows touch with no gap
      // and no overlap. A gap is a date on which somebody is paid nothing, and
      // it is silent — `payAsAt` answers null and a pay run skips them.
      //
      // Under a backdate this MOVES an end date backwards, and the row keeps no
      // trace of what it used to say. That is the second axis missing, said as
      // a write: the audit log holds the previous value and nothing can join
      // against it (`api/src/domain/payroll` § Bitemporality).
      if (open.length === 1) {
        await db.payWindow.update({ where: { id: open[0].id }, data: { effectiveTo: at } })
      }

      return await db.payWindow.create({ data: {
        employeeId,
        basis:        pay.basis,
        rate:         Number(pay.rate),
        hoursPerWeek: Number(pay.hoursPerWeek ?? 40),
        effectiveFrom: at,
      } })
    },

    /**
     * What they were on, on a day somebody states.
     *
     * The read half, over the wire. It exists so the as-at question is
     * answerable by a screen and a report rather than only by code holding a
     * client — and because a payslip reprinted in June has to come back with
     * March's number, which is the one assertion that separates this from an
     * ordinary read.
     *
     * `at` is REQUIRED by `AsAtQuery` and there is no fallback to today, which
     * is `employment.ts`'s rule at the wire: a caller who may omit the date is
     * a caller who will one day ask March's payroll what somebody earns now.
     */
    payOn: async () => {
      const employeeId = Number($.id)
      const { at }     = $.data as { at: string }
      const terms      = await payAsAt($.db as any, employeeId, at)
      if (!terms) throw new NotFound('Nothing was in force for that employee on that date')
      return terms
    },

    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove',
      { method: 'setPay',   input: 'EmploymentPay' },
      { method: 'payOn',    input: 'AsAtQuery'     },
    ],

    // Close-then-open is one statement about what somebody is paid. Under BEGIN
    // IMMEDIATE a second writer waits rather than reading the window this one is
    // halfway through closing.
    transactional: ['setPay'],
  })
}

/** 409: every refusal above is a state somebody can put right. */
function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 })
}
