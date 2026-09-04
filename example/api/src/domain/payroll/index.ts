// api/src/domain/payroll/index.ts — the door into payroll.
//
// Five files with a strict internal order — `employment` is the leaf, then
// `payrates`, then `payslip`, then `arrears`, and `payroll` composes all four —
// and exactly ONE edge leaves the module: `payroll` posts to the books
// (`../ledger.ts`). That closure is what makes this a module rather than a
// shelf, and it is what this file exists to keep true.
//
// Nothing outside `domain/payroll/` imports a file in here. The rule is worth
// stating because it is the whole of what a door buys: a service that reaches
// past this file couples to an internal arrangement that the next change is
// free to move, and *what may call into payroll* stops being answerable.
//
// Adding an export here is a deliberate widening of that surface. A function
// used only by its neighbors does not belong on this list.

// ─── who worked here, on what terms, on a given date ──────────────────────
export {
  instant, payAsAt, payAsAtMany, coveringAt, employedAt,
  annualGross, weeklyGross, assertEffectiveFrom,
} from './employment.ts'

// ─── the numbers a payroll is computed FROM, and the band walk ────────────
export { ratesAsAt, allRatesAsAt, applyBands, contributionsOn, PERCENT_SCALE } from './payrates.ts'

// ─── one payslip ──────────────────────────────────────────────────────────
export { periodShare } from './payslip.ts'

// ─── a correction to a period already paid ────────────────────────────────
export { arrearsFor } from './arrears.ts'

// ─── one period, everybody, and the run that produces it ──────────────────
export {
  planPayRun, calculatePayRun, calculatePayslipFor,
  completeIfDone, payPayRun, revertPayRun,
} from './payroll.ts'
