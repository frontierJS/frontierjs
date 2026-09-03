// api/src/domain/payroll/arrears.ts — what a backdated correction owes, and what the language
// cannot say about it.
//
// A raise agreed in June and effective from March makes three already-paid
// periods wrong. Nothing here edits them: every figure on a `Payslip` is
// `@immutable`, so the correction lands as extra lines on the NEXT payslip and
// the closed documents stay exactly as they were issued. That half is enforced
// by the schema and this file cannot cheat even if somebody wants it to.
//
// ─── The finding this file exists for ─────────────────────────────────────
//
// **Nothing declares *this row was derived from those rows*.** Three things
// follow from that, and each is written out below where it bites:
//
//   * **The cascade has no owner.** A pay window is written and three payslips
//     become wrong. No column, no attribute and no event says so, so the only
//     correct answer is to RECOMPUTE EVERYTHING and compare — which is what
//     `arrearsFor` does, and why it is O(every run this person has been paid
//     for) rather than O(what changed).
//   * **Idempotency is hand-built.** *Has this run already been corrected* is
//     the `alreadyAdjusted` term below: a query somebody remembered to write.
//     Forget it and the second pay run pays the arrears again.
//   * **A derived row is not live.** Once an adjustment is issued it is frozen
//     like any other line. A second backdate does not move it; it produces a
//     second adjustment for the remaining difference.
//
// `PayslipLine.correctsPayRunId` is the whole of what can be said, and it is a
// foreign key. Frappe reaches the same place from the other end with
// `amendedFrom` on 54 doctypes, which is evidence that a link is the state of
// the art rather than that a link is enough.
//
// ─── Bitemporality, which shows up here and only here ─────────────────────
//
// Two questions about one instant:
//
//   *what did March's payslip say when March said it*  — the payslip, frozen
//   *what do we now believe March owed*                — recompute at March's
//                                                        period end
//
// The schema holds VALID time only: `effectiveFrom`/`effectiveTo` say when
// terms were in force and nothing says when we learnt them. So the first
// question is answerable **only because a document happened to freeze the
// answer** — ask the terms table about March after a backdate and it tells you
// today's belief. `@@log(audit)` holds the other axis as a log nothing can be
// joined against, which is not the same thing as a dimension.

import { instant, payAsAtMany }  from './employment.ts'
import { allRatesAsAt }          from './payrates.ts'
import { draftPayslip }          from './payslip.ts'
import type { PayslipDraft }     from './payslip.ts'

type Client = Record<string, any>

/** What a correction to each kind is called on a payslip. */
const LABEL: Record<string, string> = {
  basicPay:        'Back pay',
  overtime:        'Overtime arrears',
  bonus:           'Bonus arrears',
  incomeTax:       'Income tax adjustment',
  employeePension: 'Pension adjustment',
  employerPension: 'Employer pension adjustment',
  employerNI:      'Employer NI adjustment',
}

/** Employer contributions never count toward what the person is paid, here
 *  exactly as in `draftPayslip` — a correction cannot change what a kind IS. */
const COUNTS = (kind: string) => kind !== 'employerPension' && kind !== 'employerNI'

export type Arrears = {
  lines: PayslipDraft['lines']
  /** Which runs it puts right, for a caller that wants to say so. */
  runs:  Array<{ id: number, reference: string, net: number }>
}

/**
 * What this person is still owed for periods that have already been paid.
 *
 * Per paid run, one comparison in three terms:
 *
 *     what we now believe the period owed        (recomputed at its period end)
 *   − what the payslip said it owed              (its own lines, corrections excluded)
 *   − what has already been put right since      (adjustment lines naming that run)
 *
 * The third term is what makes it composable: a second backdate after the first
 * has been paid out yields only the remaining difference, and running the same
 * pay run twice yields the arrears once. Every term is read from rows, so the
 * answer does not depend on knowing WHEN anything changed — which is the only
 * shape available when nothing declares what a change invalidated.
 *
 * Zero deltas emit no line: `@@check("amount != 0")` refuses a line for
 * nothing, and a payslip listing seven adjustments of zero is a payslip nobody
 * can read.
 */
export async function arrearsFor(client: Client, employeeId: number): Promise<Arrears> {
  const held = await client.payslip.findMany({ where: { employeeId }, limit: 500 })
  if (!held.length) return { lines: [], runs: [] }

  const runs = await client.payRun.findMany({
    where:   { id: { in: held.map((s: any) => s.payRunId) }, status: 'paid' },
    orderBy: { periodEnd: 'asc' },
    limit:   500,
  })
  if (!runs.length) return { lines: [], runs: [] }

  // Every line this person has, in one query. A per-run read here would be the
  // N+1 `payAsAtMany` exists to avoid, one table along.
  const lines = await client.payslipLine.findMany({
    where: { payslipId: { in: held.map((s: any) => s.id) } }, limit: 20_000,
  })
  const bySlip = new Map<number, any[]>()
  for (const line of lines) {
    const list = bySlip.get(line.payslipId) ?? []
    list.push(line)
    bySlip.set(line.payslipId, list)
  }

  const out:  PayslipDraft['lines'] = []
  const done: Arrears['runs']       = []

  for (const run of runs) {
    const slip = held.find((s: any) => s.payRunId === run.id)
    const at   = instant(run.periodEnd)

    // As we believe it NOW. The same read the run itself made, at the same
    // instant, against a terms table that has since been corrected — which is
    // the whole of what a backdate does and the only reason these two numbers
    // can differ.
    const windows = await payAsAtMany(client, [employeeId], at)
    const window  = windows.get(employeeId)
    // Nothing in force is not a correction. It is somebody having deleted a
    // window under a paid period, and inventing a delta from it would silently
    // claw back a payslip that was legitimately issued.
    if (!window) continue

    const rates = await allRatesAsAt(client, at)
    const now   = draftPayslip(employeeId, window as any, rates, run.periodsPerYear, run.periodIndex)

    // What the payslip said about ITSELF. A correction it happens to carry for
    // an earlier run is somebody else's money and is filtered out here — which
    // is the one thing `correctsPayRunId` is load-bearing for.
    const own = (bySlip.get(slip.id) ?? []).filter((l: any) => l.correctsPayRunId == null)

    // What has already been put right for this run, wherever it was paid.
    const settled = lines.filter((l: any) => l.correctsPayRunId === run.id)

    const kinds = new Set<string>([
      ...now.lines.map(l => l.kind),
      ...own.map((l: any) => l.kind),
      ...settled.map((l: any) => l.kind),
    ])

    let net = 0
    for (const kind of [...kinds].sort()) {
      const sum = (rows: Array<{ kind: string, amount: number }>) =>
        rows.filter(r => r.kind === kind).reduce((n, r) => n + r.amount, 0)

      const amount = sum(now.lines) - sum(own) - sum(settled)
      if (amount === 0) continue

      out.push({
        kind,
        description: `${LABEL[kind] ?? 'Adjustment'} — ${run.reference}`,
        amount,
        counts: COUNTS(kind),
        // No rate, and not an omission: an adjustment is the DIFFERENCE between
        // two band walks, so no single band produced it. A line that named one
        // would be pointing at a row that explains part of it at most —
        // provenance stated wrongly is worse than provenance left null.
        rateId: null,
        correctsPayRunId: run.id,
      })
      if (COUNTS(kind)) net += amount
    }

    if (net !== 0 || out.some(l => l.correctsPayRunId === run.id)) {
      done.push({ id: run.id, reference: run.reference, net })
    }
  }

  return { lines: out, runs: done }
}
