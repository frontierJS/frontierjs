// api/src/domain/payroll/payslip.ts — what ONE payslip is.
//
// Split out of `payroll.ts` when the correction landed, and the layering is the
// reason rather than the line count: a RUN is made of payslips, and ARREARS are
// about one — so a file that both of them import cannot be either of them.
// Everything here is pure apart from its inputs, which is what lets the drives
// assert the arithmetic with no database in the way.
//
// ─── The period share, and why `allocate` rather than a division ──────────
//
// A band table is annual and a payroll is monthly, so something divides. Twelve
// roundings of `annual / 12` do not sum to `annual` — a 48,000 salary at two
// places divides evenly, a 50,000 one does not, and the missing units are real
// money that has to land somewhere.
//
// `allocate(annual, [1 × periodsPerYear])` is the answer (`FJS-D154`): every
// share is floored and the leftover units go to the largest fractional parts,
// so the twelve months sum to the year EXACTLY and which month carries the
// extra unit is deterministic rather than whichever one happened to run first.
// `PayRun.periodIndex` is what picks this period's share out of that array,
// which is why it is a stored column and not a derived one.
//
// This is `allocate`'s second caller. The first is billing's proration, and the
// two are the same function for the same reason from opposite ends — one splits
// a period across seats, the other splits a year across periods.
//
// ─── The invariant that is not declarable, for the third time ─────────────
//
// *The lines that COUNT sum to net.* It reads a child table, so `@@check`
// cannot see it and it is enforced below — after `Invoice.subtotal = Σ lines`
// in `billing.ts` and `Σ journal lines = 0` in `ledger.ts`.
//
// And this one carries the thing phase 0 found in a real payroll and the
// designed version did not have: **the sum is not over every line**. The
// employer's contributions are on the payslip and are not deductions from the
// person, so the rule needs a PREDICATE over the child. A spelling that only
// admitted an aggregate would not serve the case this domain actually has.
//
// ─── What a payslip names ─────────────────────────────────────────────────
//
// The pay WINDOW, never the employee. A payslip pointing at a person reprints
// at whatever they are paid now, which is the failure effective dating exists
// to prevent, and it is `FJS-D164` said in a foreign key.

import { allocate }      from '@frontierjs/toolbelt/units'
import { annualGross }   from './employment.ts'
import { contributionsOn, allRatesAsAt } from './payrates.ts'
import type { BandPart } from './payrates.ts'

export type PayslipDraft = {
  employeeId:   number
  payWindowId:  number
  gross:        number
  deductions:   number
  net:          number
  employerCost: number
  lines: Array<{
    kind: string, description: string, amount: number, counts: boolean, rateId: number | null,
    /** Set only on an arrears line — see `arrears.ts`. Absent on a period's own. */
    correctsPayRunId?: number | null,
  }>
}

/**
 * This period's share of an annual figure.
 *
 * Exported because the drive asserts the property that makes it worth having —
 * that the shares over a whole year sum to the year — and a test that
 * re-implemented the split would be asserting itself.
 */
export function periodShare(annual: number, periodsPerYear: number, periodIndex: number): number {
  return allocate(annual, Array(periodsPerYear).fill(1))[periodIndex]
}

/** Band parts → payslip lines, with the sign and the `counts` flag applied. */
function linesFromBands(
  parts: BandPart[], kind: string, label: string, { deduction = true } = {},
): PayslipDraft['lines'] {
  return parts.filter(p => p.amount !== 0).map(p => ({
    kind,
    description: `${label} at ${(p.percent / 100).toFixed(2)}%`,
    // Positive is an earning, negative a deduction — and an employer
    // contribution is neither, so it is carried positive and marked as not
    // counting. `counts` is the whole reason the invariant needs a predicate.
    amount:  deduction ? -p.amount : p.amount,
    counts:  deduction,
    rateId:  p.rateId,
  }))
}

/**
 * Compute one payslip, from rows that were true at `at`.
 *
 * Pure apart from its inputs: everything it needs has already been read, which
 * is what lets the drive assert the arithmetic without a database and what
 * stops a per-employee query creeping into a loop over five thousand people.
 */
export function draftPayslip(
  employeeId: number,
  window: { id: number, basis: 'salary' | 'hourly', rate: number, hoursPerWeek: number },
  rates: Awaited<ReturnType<typeof allRatesAsAt>>,
  periodsPerYear: number,
  periodIndex: number,
): PayslipDraft {
  const annual  = annualGross(window)
  const gross   = periodShare(annual, periodsPerYear, periodIndex)
  const owed    = contributionsOn(rates, annual)

  // Every contribution is computed ANNUALLY and then split, never computed on
  // the period's gross. A band is an annual threshold: charging it against a
  // twelfth of a salary puts almost everybody in the zero band and collects no
  // tax at all, which is the wrong answer that looks like a working payroll.
  const share = (n: number) => periodShare(n, periodsPerYear, periodIndex)

  const lines: PayslipDraft['lines'] = [{
    kind: window.basis === 'hourly' ? 'basicPay' : 'basicPay',
    description: window.basis === 'hourly'
      ? `Basic pay — ${window.hoursPerWeek} hours a week`
      : 'Basic pay',
    amount: gross, counts: true, rateId: null,
  }]

  const scale = (parts: BandPart[]) => parts.map(p => ({ ...p, amount: share(p.amount) }))

  lines.push(...linesFromBands(scale(owed.incomeTax.parts),       'incomeTax',       'Income tax'))
  lines.push(...linesFromBands(scale(owed.employeePension.parts), 'employeePension', 'Pension'))
  lines.push(...linesFromBands(scale(owed.employerPension.parts), 'employerPension', 'Employer pension', { deduction: false }))
  lines.push(...linesFromBands(scale(owed.employerNI.parts),      'employerNI',      'Employer NI',      { deduction: false }))

  return { employeeId, payWindowId: window.id, ...totalsFor(lines), lines }
}

/**
 * What a set of lines adds up to. **One reader, because there are now two
 * callers**: a period's own draft, and that draft with arrears folded onto it.
 *
 * `gross` is the sum of the EARNING kinds rather than of the positive lines,
 * and that distinction only starts to matter here. A period on its own has one
 * positive counting line and the two spellings agree; a correction can carry a
 * tax REFUND, which is positive, counts toward the person, and is not gross
 * pay — under a sign test it would inflate the year's earnings and under this
 * one it correctly reduces the deductions.
 */
const EARNING_KINDS = new Set(['basicPay', 'overtime', 'bonus'])

export function totalsFor(lines: PayslipDraft['lines']) {
  const counting     = lines.filter(l => l.counts)
  const gross        = counting.filter(l =>  EARNING_KINDS.has(l.kind)).reduce((n, l) => n + l.amount, 0)
  const deductions   = -counting.filter(l => !EARNING_KINDS.has(l.kind)).reduce((n, l) => n + l.amount, 0)
  const employerCost = lines.filter(l => !l.counts).reduce((n, l) => n + l.amount, 0)
  return { gross, deductions, net: gross - deductions, employerCost }
}

/**
 * A period's draft with a correction folded onto it.
 *
 * The arrears are ordinary lines — same kinds, same `counts`, so they reach the
 * same ledger accounts with nothing taught to `payPayRun` — and the totals are
 * recomputed rather than added to, so there is one definition of what a payslip
 * says and it does not depend on which lines arrived first.
 */
export function withArrears(draft: PayslipDraft, arrears: PayslipDraft['lines']): PayslipDraft {
  if (!arrears.length) return draft
  const lines = [...draft.lines, ...arrears]
  return { ...draft, ...totalsFor(lines), lines }
}

/**
 * The invariant `@@check` cannot see.
 *
 * Checked once, here, at the moment the document is written — `FJS-D162`'s
 * ruling — and the columns are frozen immediately after, so there is no drift
 * to catch. A draft that does not add up never becomes a row.
 */
export function assertPayslipAddsUp(draft: PayslipDraft, label: string): void {
  const counting = draft.lines.filter(l => l.counts)
  const sum      = counting.reduce((n, l) => n + l.amount, 0)
  if (sum !== draft.net) throw payrollError(
    `${label}: the lines that count sum to ${sum} and the net is ${draft.net}`,
  )
  const employer = draft.lines.filter(l => !l.counts).reduce((n, l) => n + l.amount, 0)
  if (employer !== draft.employerCost) throw payrollError(
    `${label}: the employer lines sum to ${employer} and the employer cost is ${draft.employerCost}`,
  )
}

/** 409, because every one of these is a state somebody can put right. */
function payrollError(message: string, status = 409) {
  return Object.assign(new Error(message), { status })
}
