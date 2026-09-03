// api/src/domain/payroll/employment.ts — who worked here, on what terms, on a given date.
//
// This file is the specification for a language feature that does not exist,
// and it is written by hand on purpose (`IDEAS/payroll.md` phase 2). Read it as
// evidence rather than as a pattern to copy.
//
// ─── The question ─────────────────────────────────────────────────────────
//
// Every payroll question is *what was true on the 12th*, not *what is true*. A
// pay run for March recalculated in June must produce March's numbers, and a
// backdated raise must not silently reprice a payslip that has already been
// issued. So no read of `PayWindow` is ever a plain read: every one of
// them carries an instant.
//
// ─── The interval, decided ONCE ───────────────────────────────────────────
//
// A window is HALF-OPEN: `effectiveFrom <= at < effectiveTo`. Windows touch —
// `setPay` closes the old one at the exact instant it opens the new — so the
// boundary instant belongs to the NEW window and to nothing else. A second
// reader that used `<=` on the end would find two windows covering one instant
// and pick whichever came back first, which is a wrong salary once per raise
// and never reproducible.
//
// That is Invariant 4's shape applied to time, and it is the whole reason this
// module exists rather than the where-clause being written at each call site.
//
// ─── Where it gets ugly, which is the point ───────────────────────────────
//
// One employee is fine. A PAY RUN is five thousand employees at one instant,
// and there is no way to ask for that:
//
//   * per employee, one query — N+1, and a pay run is the one place N is big
//   * one query for every covering row, then pick in JS — what `payAsAtMany`
//     does, and it is only correct because at most one window per employee can
//     cover an instant
//
// **and that "at most one" IS declarable now.**
// `@@unique([employeeId], where: effectiveTo == null)` — `FJS-603`, closed. The
// batch read below rests on a rule the table holds, so a migration, a seed and
// an `asSystem()` repair are each refused rather than each able to break it
// without a word. `employees.setPay` still checks it because a service can name
// the employee and say what to do, where the boundary answers a 409 naming a
// column.
//
// The defence below therefore guards against a database written BEFORE the
// constraint existed. Nothing in this repo can stage one any more, which is why
// no drive asserts it. A function that has to re-check an
// invariant its own database was supposed to hold is what a missing feature
// looks like from the inside.
//
// ─── The second copy ──────────────────────────────────────────────────────
//
// `api/src/services/plans.service.ts`'s `reprice` is the same four steps over
// `PlanVersion` — find the open window, refuse two, close it at `now`, open the
// next in one transaction — for a completely unrelated noun. Two domains in one
// application arranging validity windows identically by hand is the argument
// for `FJS-D164`'s open question, and it is only an argument because they are
// the same arrangement rather than two dialects.

/** A Litestone client of some flavour — `inventory.ts`'s reason, unchanged. */
type Client = Record<string, any>

export type PayWindowRow = Record<string, unknown> & {
  id:            number
  employeeId:    number
  basis:         'salary' | 'hourly'
  rate:          number
  hoursPerWeek:  number
  effectiveFrom: string
  effectiveTo:   string | null
}

/** The instant, as every function here wants it. A `Date`, a number and an ISO
 *  string all reach these call sites in practice, and a column compared against
 *  the wrong one of the three silently matches nothing. */
export const instant = (at: string | number | Date = new Date()): string =>
  (at instanceof Date ? at : new Date(at)).toISOString()

/**
 * The window covering `at`, as a `where` clause.
 *
 * The one place the half-open rule is written. Exported so a caller that must
 * build its own query — a count, a join, an aggregate — cannot spell the
 * interval a second way.
 */
export function coveringAt(at: string) {
  return {
    effectiveFrom: { lte: at },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
  }
}

/**
 * What one employee was on, at one instant. `null` if nothing covers it —
 * before they were hired, or a gap somebody left.
 *
 * `orderBy` is belt and braces: with the invariant holding there is exactly one
 * row, and taking the latest `effectiveFrom` makes the answer deterministic
 * rather than arbitrary if it is not.
 */
export async function payAsAt(
  client: Client, employeeId: number, at: string | number | Date = new Date(),
): Promise<PayWindowRow | null> {
  const when = instant(at)
  return await client.payWindow.findFirst({
    where:   { employeeId, ...coveringAt(when) },
    orderBy: { effectiveFrom: 'desc' },
  }) as PayWindowRow | null
}

/**
 * The same question for many people at once, which is what a pay run asks.
 *
 * One query rather than N, and the pick happens here because SQLite cannot be
 * asked for *the latest row per group* without a window function litestone does
 * not compile. The map is keyed by employee id; somebody with no covering
 * window is ABSENT rather than mapped to null, so a caller iterating it cannot
 * pay a leaver by accident.
 *
 * `onOverlap` is not an option — it is the invariant reporting itself. The
 * default throws, because a pay run computing a salary from whichever of two
 * overlapping windows sorted first is the failure this whole file exists to
 * make impossible.
 */
export async function payAsAtMany(
  client: Client,
  employeeIds: number[],
  at: string | number | Date = new Date(),
  { onOverlap = 'throw' as 'throw' | 'latest' } = {},
): Promise<Map<number, PayWindowRow>> {
  if (!employeeIds.length) return new Map()
  const when = instant(at)

  const rows = await client.payWindow.findMany({
    where:   { employeeId: { in: employeeIds }, ...coveringAt(when) },
    orderBy: { effectiveFrom: 'desc' },
    limit:   employeeIds.length * 4,
  }) as PayWindowRow[]

  const byEmployee = new Map<number, PayWindowRow>()
  for (const row of rows) {
    const held = byEmployee.get(row.employeeId)
    if (!held) { byEmployee.set(row.employeeId, row); continue }

    // Two windows covering one instant. The database was supposed to make this
    // unreachable and cannot say so, so it is named rather than resolved
    // quietly — `latest` is available for a report that would rather show a
    // number than stop, and no payroll path passes it.
    if (onOverlap === 'throw') throw employmentError(
      `employee ${row.employeeId} has overlapping pay windows covering ${when} ` +
      `(terms ${held.id} and ${row.id}) — close one before running payroll`,
    )
    if (new Date(row.effectiveFrom) > new Date(held.effectiveFrom)) byEmployee.set(row.employeeId, row)
  }
  return byEmployee
}

/**
 * Everybody employed at `at`, which is a different question from everybody in
 * the table and is asked of `Employee` rather than of the terms.
 *
 * Somebody who left in February is not on March's payroll however many pay
 * windows they still have rows for, and somebody hired in April is not on
 * March's. Half-open at both ends, for `coveringAt`'s reason: the leaving date
 * is the first day they are NOT employed.
 */
export async function employedAt(
  client: Client, at: string | number | Date = new Date(),
): Promise<Array<Record<string, unknown> & { id: number, reference: string, name: string }>> {
  const when = instant(at)
  return await client.employee.findMany({
    where: {
      startedOn: { lte: when },
      OR: [{ endedOn: null }, { endedOn: { gt: when } }],
    },
    orderBy: { reference: 'asc' },
    limit:   5000,
  }) as Array<Record<string, unknown> & { id: number, reference: string, name: string }>
}

/**
 * Which instants a new pay window may open at, given the ones already there.
 *
 * The rule and not the four steps. `setPay` and `plans.reprice` write the same
 * close-then-open by hand on purpose (see the module header), and this is a
 * different thing: *what does a stated `effectiveFrom` mean* has exactly one
 * answer, and it is asked by the service and by the drives that grade it.
 *
 * Three refusals, and each is a wrong answer that would otherwise be silent:
 *
 *   * **The future.** A window opening tomorrow leaves `payAsAt(now)` answering
 *     the old one, so a payroll run today quietly pays the old rate for a raise
 *     everybody can see on screen. Forward effective-dating is a real feature
 *     and it needs a pay run that can say *there is one queued for the 1st*.
 *   * **Before the open window started**, which is backdating ACROSS an earlier
 *     change. Handling it means splitting or discarding windows that an issued
 *     payslip already points at — a second correction mechanism for the rarer
 *     half of the case.
 *   * **Into a closed history with nothing open**, which would put two windows
 *     over one instant — the thing `payAsAtMany` cannot resolve and has to
 *     report by name.
 *
 * **A FIRST window may start whenever they did**, and that is not a hole. Pay
 * beginning before the moment somebody typed it is the ordinary case for a new
 * hire, there is no window to close and no history to cross, and refusing it
 * meant a person's pay could only ever start at the instant it was recorded —
 * which makes the first pay run for anybody hired last month wrong.
 *
 * Throws; a caller that reaches the end may write.
 */
export function assertEffectiveFrom(
  reference: string, at: string, now: string, windows: PayWindowRow[] = [],
): void {
  if (at > now) throw employmentError(
    `${reference}: pay cannot be set from a future date (${at})`)

  if (at === now) return   // the ordinary raise: nothing to grade

  const open = windows.find(w => !w.effectiveTo) ?? null

  if (open) {
    if (at < open.effectiveFrom) throw employmentError(
      `${reference}: ${at} falls before the current pay window (which opened ` +
      `${open.effectiveFrom}) — backdating across an earlier change is not ` +
      `supported; correct the windows by hand`)
    return
  }

  // Nothing open. A first window may start whenever they did; a window opening
  // inside a history that has already been closed would overlap one of them.
  const lastEnd = windows
    .map(w => w.effectiveTo as string)
    .filter(Boolean)
    .sort()
    .at(-1)

  if (lastEnd && at < lastEnd) throw employmentError(
    `${reference}: ${at} falls inside a pay window that has already been ` +
    `closed (the last one ended ${lastEnd}) — two windows would cover one ` +
    `instant; correct the windows by hand`)
}

/**
 * What one week of somebody's terms is worth, in minor units.
 *
 * Here because `rate` means two different magnitudes under the two bases, and a
 * caller that had to remember which is a caller that will one day divide an
 * hourly rate by 52. It is deliberately NOT a payslip: no tax, no deductions,
 * no rounding of a period — phase 4 owns all three.
 */
export function weeklyGross(terms: Pick<PayWindowRow, 'basis' | 'rate' | 'hoursPerWeek'>): number {
  return terms.basis === 'hourly'
    ? terms.rate * terms.hoursPerWeek
    // 52 and not 52.1786, and it is a decision rather than an approximation: a
    // weekly figure that does not divide the annual one exactly is a figure
    // that cannot be summed back to the salary anybody agreed to. What a real
    // payroll divides by is the PERIOD, which phase 4 introduces.
    : Math.round(terms.rate / 52)
}

/**
 * The same terms as an ANNUAL figure, which is the unit a band table is written
 * in — nobody publishes a tax threshold per week.
 *
 * `* 52` for an hourly rate and the salary straight through, so the two bases
 * meet at the one magnitude the rest of payroll is computed from. It is the
 * inverse of `weeklyGross`'s division and deliberately not exact against it: 52
 * weeks is a convention at both ends, and what a real payroll divides by is the
 * PERIOD, which phase 4 introduces.
 */
export function annualGross(terms: Pick<PayWindowRow, 'basis' | 'rate' | 'hoursPerWeek'>): number {
  return terms.basis === 'hourly' ? terms.rate * terms.hoursPerWeek * 52 : terms.rate
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** 409, because every one of these is a state somebody can put right — close a
 *  window, correct a start date — rather than a bad request. */
function employmentError(message: string) {
  return Object.assign(new Error(message), { status: 409 })
}
