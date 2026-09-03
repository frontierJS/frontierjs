// web/test/payroll-sweep.mjs — how a payroll drive removes what it made.
//
// One owner, because there are five callers and the order matters. Four foreign
// keys point INTO a pay run and two of them are `onDelete: Restrict`, so a
// sweep that guesses leaves the run behind and every later run of every later
// drive inherits it.
//
// ─── Why this needs a hatch at all ────────────────────────────────────────
//
// **The books are append-only at the Data boundary and that is deliberate.**
// `JournalEntry` and `JournalLine` are `@@gate("5.8.9.9")`; `9` is LOCKED, so
// `asSystem()` — which grades 8 — is refused BY NAME on update and delete. It
// is what makes the ledger a ledger rather than a table everyone agrees not to
// edit, and `verify:money` asserts it.
//
// The cost lands on the tests, and it was measured rather than reasoned about:
// two drives read that refusal as *the journal stays, as a real one would* and
// left the run behind with it, so after a few weeks of running them the shop
// held **38 pay runs**, all but two of them paid. That is not tidy-versus-untidy.
// A paid run keeps a payslip for a SEEDED employee, so the next drive that
// backdates one of them computes arrears against runs nobody remembers making
// (`api/src/domain/payroll` — the correction is a function of every paid period,
// not of what changed); and a stale run at the top of the console's list is
// what `FJS-612` was first seen through.
//
// So the sweep goes UNDER the boundary, with the one hatch that exists for it:
// `asSystem().sql`, which enforces no gate and no policy. Two things worth
// reading off that — it is the correct escape and it is a blunt one, and it
// binds to TABLE names rather than model names, which is what
// `db/ddl.snapshot.sql` is committed for.
//
// ─── What it does NOT do ──────────────────────────────────────────────────
//
// It never touches a row it was not handed. Every payroll drive mints its own
// employees and its own runs under a per-run prefix (`FJS-530`, `FJS-546`) and
// passes their ids here; a sweep that matched on a reference prefix would one
// day match somebody else's.

/**
 * Remove a drive's own pay runs and employees, in the order the foreign keys
 * allow. Safe to call twice, and safe to call with nothing.
 *
 * Call it from a `finally`. A drive that sweeps only on the success path leaves
 * its fixtures behind exactly when something went wrong — which is the run
 * whose leftovers are hardest to recognise later.
 */
export async function sweepPayroll(sys, { runIds = [], employeeIds = [] } = {}) {
  const runs = runIds.filter(Boolean)
  const staff = employeeIds.filter(Boolean)

  if (runs.length) {
    // Lines, then payslips: `PayslipLine.correctsPayRunId` is `Restrict`, so an
    // adjustment line naming one of these runs holds it even after the payslip
    // carrying that line is gone from a different run.
    const slips = await sys.payslip.findMany({ where: { payRunId: { in: runs } }, limit: 5000 })
    const adjusting = await sys.payslipLine.findMany({
      where: { correctsPayRunId: { in: runs } }, limit: 20_000,
    })
    const lineIds = [...new Set([
      ...adjusting.map(l => l.id),
      ...(slips.length
        ? (await sys.payslipLine.findMany({
            where: { payslipId: { in: slips.map(s => s.id) } }, limit: 20_000,
          })).map(l => l.id)
        : []),
    ])]
    if (lineIds.length) await sys.payslipLine.deleteMany({ where: { id: { in: lineIds } } })
    if (slips.length)   await sys.payslip.deleteMany({ where: { id: { in: slips.map(s => s.id) } } })

    // The books, under the boundary — see the header.
    for (const id of runs) {
      await sys.sql`DELETE FROM journal_line WHERE entryId IN (SELECT id FROM journal_entry WHERE payRunId = ${id})`
      await sys.sql`DELETE FROM journal_entry WHERE payRunId = ${id}`
    }
    await sys.payRun.deleteMany({ where: { id: { in: runs } } })
  }

  if (staff.length) {
    // A payslip on a run this drive did NOT make still points at the employee,
    // so those go first or the delete is refused by a foreign key.
    const slips = await sys.payslip.findMany({ where: { employeeId: { in: staff } }, limit: 5000 })
    if (slips.length) {
      await sys.payslipLine.deleteMany({ where: { payslipId: { in: slips.map(s => s.id) } } })
      await sys.payslip.deleteMany({ where: { id: { in: slips.map(s => s.id) } } })
    }
    await sys.payWindow.deleteMany({ where: { employeeId: { in: staff } } })
    await sys.employee.deleteMany({ where: { id: { in: staff } } })
  }
}
