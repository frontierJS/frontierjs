// api/services/stocktake-sheets.service.ts — the walk around the stockroom.
//
// A sheet is made where the stock is, which is the whole reason this model
// exists in an app that already had a ledger: `StocktakeSheet` and
// `StocktakeCount` both declare `@@sync(server)`, so the browser holds both
// writes when there is no signal and drains them when there is.
//
// ─── Why the key is the browser's ──────────────────────────────────────────
//
// The counts reference the sheet, and in a stockroom they are written in the
// same minute as the sheet with nothing reachable. `@default(uuid())` on the
// `@id` is what makes that expressible: litestone crosses `x-mint` with the
// schema, sierra states the key on the create, and the count that follows names
// a sheet the server has never heard of. Both writes then drain in order and
// the reference is already correct — no rewriting of ids on the way out, which
// is the other way this is done and the way that breaks quietly.
//
// ─── What `close` is for ───────────────────────────────────────────────────
//
// A count is an observation, not a correction. Closing the sheet is what turns
// the differences into ledger movements — one `adjusted` movement per count
// that disagrees with what the system thought — through the same `move()` every
// other stock write here uses, so the tape and the shelf stay one fact.

import { createBaseService, $ } from '@frontierjs/junction'
import { move } from '../domain/shop'

export function createStocktakeSheetsService() {
  return createBaseService({
    model: 'StocktakeSheet',

    // No `channel:`. A sheet is `@@gate("5.…")` for reads and a broadcast does
    // not re-check the gate, so publishing these would hand every connected
    // browser rows the Data boundary refuses them — the same reason
    // `inventory` declares none.

    // `close` reads every count, writes a movement per discrepancy and stamps
    // the sheet. Half a stocktake posted is worse than none posted: the ledger
    // would then disagree with a sheet that says it is closed.
    transactional: ['close'],

    /**
     * Post the differences and shut the sheet.
     *
     * Idempotent by the state it reads rather than by a flag: a sheet with
     * `closedAt` set refuses, so a replayed close — which is exactly what an
     * offline device produces — answers 409 rather than posting the
     * adjustments a second time.
     */
    async close() {
      const id = String($.id)

      const sheet = await $.db.stocktakeSheet.findUnique({ where: { id } }) as
        { id: string, closedAt: string | null } | null
      if (!sheet)          throw Object.assign(new Error(`No stocktake sheet ${id}.`), { status: 404 })
      if (sheet.closedAt)  throw Object.assign(
        new Error(`Stocktake sheet ${id} was closed at ${sheet.closedAt}. A second count is a new sheet.`),
        { status: 409 },
      )

      const counts = await $.db.stocktakeCount.findMany({ where: { sheetId: id } }) as
        Array<{ id: string, variantId: number, counted: number, expected: number }>

      const posted = []
      for (const c of counts) {
        // The difference, signed, in the ledger's own convention: what is on
        // the shelf minus what the system thought when the shelf was counted.
        const delta = Number(c.counted) - Number(c.expected)
        if (delta === 0) continue
        const { before, after } = await move($.db, Number(c.variantId), 'adjusted', delta, {
          note: `stocktake ${id}`,
        })
        posted.push({ variantId: c.variantId, delta, before, after })
      }

      await $.db.stocktakeSheet.update({ where: { id }, data: { closedAt: new Date().toISOString() } })

      return { sheetId: id, counted: counts.length, posted }
    },

    // A sheet is created, read and closed. No remove — the model's gate locks
    // delete at 9, and a stocktake that can be deleted is a stocktake nobody
    // can audit.
    methods: ['find', 'get', 'create', 'patch', 'close'],
  })
}
