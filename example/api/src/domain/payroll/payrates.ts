// api/src/domain/payroll/payrates.ts — the numbers a payroll is computed FROM, and the walk.
//
// `employment.ts` answers *what was this person on* at an instant. This answers
// the other half of the same question — *and what were the rules* — and the two
// are separate files because they are separate tables with separate lifetimes:
// somebody's pay changes when they are promoted, a tax band changes when a
// government says so, and a payslip has to reproduce BOTH as they were.
//
// ─── The band walk, which is the only interesting arithmetic here ─────────
//
// A rate applies to the SLICE of income between two thresholds, not to the
// whole. Applying the top band to the whole salary is the classic wrong answer
// and it is wrong by thousands, so the walk is written once, here, and
// `applyBands` is the only thing in the application that reads `fromAmount` and
// `toAmount` together.
//
// ─── Rounding is per BAND and not on the total ────────────────────────────
//
// A payslip shows the bands, so each line has to be a whole number of minor
// units on its own — a breakdown whose lines are exact and whose total is
// rounded separately does not add up, which is the one thing a payslip may
// never do. The consequence is stated rather than hidden: the sum of the parts
// IS the answer, and rounding the total independently would sometimes differ by
// a unit.
//
// `roundMinor` and not `Math.round`, for `FJS-D154`'s reason: ties go away from
// zero so a negative rounds the same distance as its positive twin, and the
// mode is a per-call option because banker's rounding is required of tax in
// several jurisdictions.
//
// ─── The interval is not re-spelled ───────────────────────────────────────
//
// `coveringAt` comes from `employment.ts`. This is its second consumer, and
// that is the whole argument for exporting it: two tables with validity windows
// in one application, and one definition of which window covers an instant. A
// second spelling here would be a tax band that changes on a different midnight
// from a salary.

import { roundMinor }             from '@frontierjs/toolbelt/units'
import { coveringAt, instant }    from './employment.ts'

type Client = Record<string, any>

export type RateKind = 'incomeTax' | 'employeePension' | 'employerPension' | 'employerNI'

export const RATE_KINDS: RateKind[] = ['incomeTax', 'employeePension', 'employerPension', 'employerNI']

/** A percentage at two places, as the column stores it — 2000 is 20.00%. The
 *  divisor is written once so nobody divides by 100 and is out by a hundred. */
export const PERCENT_SCALE = 10_000

export type PayRateRow = Record<string, unknown> & {
  id:         number
  kind:       RateKind
  fromAmount: number
  toAmount:   number | null
  percent:    number
}

/** One band's contribution, which is also one payslip line. */
export type BandPart = {
  rateId:  number
  kind:    RateKind
  from:    number
  to:      number | null
  percent: number
  /** The slice of income this band actually caught, in minor units. */
  slice:   number
  /** What that slice is worth at this band's rate, rounded. */
  amount:  number
}

/**
 * The bands in force for one kind, at one instant, in threshold order.
 *
 * Ordered here rather than by the caller because the walk below depends on it:
 * a band list read in insertion order applies the wrong rate to the wrong
 * slice and still returns a plausible number.
 */
export async function ratesAsAt(
  client: Client, kind: RateKind, at: string | number | Date = new Date(),
): Promise<PayRateRow[]> {
  const when = instant(at)
  return await client.payRate.findMany({
    where:   { kind, ...coveringAt(when) },
    orderBy: { fromAmount: 'asc' },
    limit:   50,
  }) as PayRateRow[]
}

/**
 * Every kind at once, which is what a pay run wants — four reads rather than
 * four per employee.
 *
 * A kind with no bands in force is an EMPTY array rather than missing, because
 * *this shop does not run an employer pension* and *somebody forgot to seed the
 * pension bands* look identical from a caller's side either way, and an empty
 * array at least makes the walk return zero rather than throw.
 */
export async function allRatesAsAt(
  client: Client, at: string | number | Date = new Date(),
): Promise<Record<RateKind, PayRateRow[]>> {
  const when = instant(at)
  const rows = await client.payRate.findMany({
    where:   coveringAt(when),
    orderBy: { fromAmount: 'asc' },
    limit:   200,
  }) as PayRateRow[]

  const out = Object.fromEntries(RATE_KINDS.map(k => [k, [] as PayRateRow[]])) as Record<RateKind, PayRateRow[]>
  for (const row of rows) out[row.kind]?.push(row)
  return out
}

/**
 * Walk the bands against an annual amount.
 *
 * The slice a band catches is `[from, to)` intersected with `[0, annual]`, so
 * a salary landing exactly on a threshold falls in the band ABOVE it and in
 * nothing else — half-open at both ends, for `coveringAt`'s reason and with the
 * same consequence if two readers disagree.
 *
 * Returns the parts as well as the total because a payslip shows them, and
 * because a total nobody can take apart is a number an employee cannot query.
 */
export function applyBands(bands: PayRateRow[], annual: number): { total: number, parts: BandPart[] } {
  const parts: BandPart[] = []
  let total = 0

  for (const band of bands) {
    if (annual <= band.fromAmount) continue
    const ceiling = band.toAmount == null ? annual : Math.min(annual, band.toAmount)
    const slice   = ceiling - band.fromAmount
    if (slice <= 0) continue

    const amount = roundMinor(slice * band.percent / PERCENT_SCALE)
    total += amount
    parts.push({
      rateId: band.id, kind: band.kind,
      from: band.fromAmount, to: band.toAmount, percent: band.percent,
      slice, amount,
    })
  }

  // The total is the SUM of the parts and is never rounded again. See the
  // header: a breakdown that does not add up to its own total is the one thing
  // a payslip may not do.
  return { total, parts }
}

/**
 * Everything owed on one annual figure, at one instant.
 *
 * The employer's two kinds are answered beside the employee's and are NOT
 * netted into anything: employer NI and the employer's pension contribution are
 * a cost to the business and never a deduction from the person, so a function
 * that returned one number would have made that mistake for every caller.
 * Phase 4's journal debits them to a different account.
 */
export function contributionsOn(
  rates: Record<RateKind, PayRateRow[]>, annual: number,
): Record<RateKind, { total: number, parts: BandPart[] }> {
  return Object.fromEntries(
    RATE_KINDS.map(kind => [kind, applyBands(rates[kind] ?? [], annual)]),
  ) as Record<RateKind, { total: number, parts: BandPart[] }>
}
