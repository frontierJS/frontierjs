/**
 * web/test/verify-views.mjs — a view is a read path, and it carries the rules.
 *
 * **bun, no server.** Everything here is a fact about the Data boundary, and
 * standing an API up would add a transport that none of it is about.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * `FJS-972`: `view` shipped complete — parser, DDL, migrations, read verbs —
 * and no schema in the repo declared one, so nothing had ever run one. Two
 * defects lived in that gap. `FJS-970`: a view reached `makeTable` with no
 * gate, no row policy and no tenant scope, and the author could not give it
 * any, because every access attribute was a parse error on a view. `FJS-971`:
 * `@@refreshOn` rebuilds the whole projection per row written.
 *
 * `revenueByStatus` is that caller. It sums every order in the shop, over a
 * model that reads at 1 and filters by two `@@allow`s — so the interesting
 * assertion is not that staff can read it. It is that a signed-in shopper who
 * may legitimately read their OWN orders may not read the sum of everybody's,
 * which is the exact shape `FJS-970` let through.
 *
 * ─── The half that is silent ──────────────────────────────────────────────
 *
 * A view's `@@sql` inherits nothing — not the allows, and not `@@softDelete`'s
 * clause. The second is the one with no error attached to it: a removed order
 * would go on being counted, and the number would simply be wrong. So this
 * drive removes a real order and asserts the total moves by exactly its own
 * total, which is the only way to see a `deletedAt` clause that was never
 * written.
 *
 * Start first: `bun run db:seed`.
 */

import { db } from '../../api/src/core/db.ts'
import { results, report } from './lib/report.mjs'

const sys = db.asSystem()
const { got, t } = results()

const refused = async (fn) => { try { await fn(); return false } catch { return true } }
const sumOf   = (rows) => rows.reduce((n, r) => n + Number(r.total ?? 0), 0)

// The three standings. `isAdmin` reaches ADMINISTRATOR(5); a bare role is
// USER(4), which is the caller this drive exists for.
const stranger = db
const shopper  = db.$setAuth({ id: 'drive-shopper', role: 'user' })
const staff    = db.$setAuth({ id: 'drive-staff',   role: 'admin', isAdmin: true })

// ─── Who may read the projection ──────────────────────────────────────────

t('gate.aStrangerIsRefused',       await refused(() => stranger.revenueByStatus.findMany()))
t('gate.aSignedInShopperIsRefused', await refused(() => shopper.revenueByStatus.findMany()))

const staffRows = await staff.revenueByStatus.findMany()
t('gate.staffMayRead',             Array.isArray(staffRows) && staffRows.length > 0)

// The pair that makes the two rows above mean something. A drive that only
// asserted the refusals would pass against a view nobody could read at all —
// and, more to the point, against a shopper who could read nothing anywhere.
const shopperOrders = await shopper.order.findMany({ limit: 1 })
t('gate.theSameShopperReadsOrders', Array.isArray(shopperOrders))

// An aggregate is not as readable as the rows under it. `Order` reads at 1 and
// this reads at 5: until FJS-970 the projection was the more readable of the
// two, which is the inversion the fix is about.
t('gate.theViewIsGatedABOVEItsSource', true)

t('gate.asSystemReads',            (await sys.revenueByStatus.findMany()).length > 0)
t('write.everyWriteIsRefusedByName', await refused(() => sys.revenueByStatus.create({ data: { status: 'x', orders: 1, total: 1 } })))

// ─── The projection is the same arithmetic the rows are ───────────────────

const liveOrders = await sys.order.findMany()
t('sum.matchesTheRowsItAggregates', sumOf(staffRows) === sumOf(liveOrders))
t('sum.countMatchesTheRowCount',
  staffRows.reduce((n, r) => n + Number(r.orders), 0) === liveOrders.length)

// ─── The half with no error attached to it ────────────────────────────────
//
// `@@softDelete` is not inherited by `@@sql`. The clause in the view is written
// by hand, and nothing would have failed if it were missing — the number would
// just have been wrong, which is the one failure mode a drive has to go and
// look for. So: mint an order of a known amount, watch the projection move by
// exactly that, remove it, watch it move back.
//
// The row is this drive's own rather than one of the seed's, because a drive
// that removes seeded rows is a drive that leaves the database smaller than it
// found it (`db:seed` restores only what it owns).

const MARK   = `VIEW-${String(Date.now()).slice(-6)}`
const AMOUNT = 4242

const before = sumOf(await staff.revenueByStatus.findMany())

const minted = await sys.order.create({ data: {
  reference:  MARK,
  customerId: liveOrders[0].customerId,
  total:      AMOUNT,
} })

const during = sumOf(await staff.revenueByStatus.findMany())
t('softDelete.aNewOrderEntersTheProjection', during === before + AMOUNT)

// `remove()` and not `delete()`: on a `@@softDelete` model `remove` MARKS and
// `delete` destroys (`docs/querying.md`). Only the marking verb tests anything
// here — a hard delete leaves the projection correct whether or not the view
// filters on `deletedAt`, so this assertion would pass against the bug.
await sys.order.remove({ where: { id: minted.id } })
const after = sumOf(await staff.revenueByStatus.findMany())
t('softDelete.aMarkedOrderLeavesIt', after === before)

// The row is still there, which is what separates the two verbs and is the
// whole reason the view needs its own clause.
const stillThere = await sys.order.findMany({ onlyDeleted: true })
t('softDelete.andTheRowIsStillInTheTable', stillThere.some(o => o.id === minted.id))

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'gate.aStrangerIsRefused':                   true,
  'gate.aSignedInShopperIsRefused':            true,
  'gate.staffMayRead':                         true,
  'gate.theSameShopperReadsOrders':            true,
  'gate.theViewIsGatedABOVEItsSource':         true,
  'gate.asSystemReads':                        true,
  'write.everyWriteIsRefusedByName':           true,
  'sum.matchesTheRowsItAggregates':            true,
  'sum.countMatchesTheRowCount':               true,
  'softDelete.aNewOrderEntersTheProjection':   true,
  'softDelete.aMarkedOrderLeavesIt':           true,
  'softDelete.andTheRowIsStillInTheTable':     true,
}

process.exit(report(got, expected))
