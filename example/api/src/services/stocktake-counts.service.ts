// api/services/stocktake-counts.service.ts — one shelf, counted once.
//
// The child half of the offline pair. Nothing here is clever, and that is the
// claim worth making: a count arriving from a device that was in a stockroom is
// an ordinary create, graded by the model's own `@@gate("5.5.5.9")` at the Data
// boundary, carrying a `sheetId` the browser minted for a sheet that may still
// be in the queue ahead of it.
//
// The queue drains in order, so the sheet lands first and the foreign key
// resolves. What makes that true is `@default(uuid())` on both models, not
// anything in this file — which is the point of writing it down here.

import { createBaseService } from '@frontierjs/junction'

export function createStocktakeCountsService() {
  return createBaseService({
    model: 'StocktakeCount',

    // ─── why `patch` is here on an append-only table ──────────────────────
    //
    // A second look at a shelf is a second count, not an edit of the first, and
    // the model's gate locks delete at 9. So `patch` reads as the wrong verb —
    // and it is the one the BYTES arrive on.
    //
    // A held write replays in two halves (`FJS-D301`): the row first, then each
    // file as a patch naming that row. A service that offers no patch refuses
    // the second half with a 405 and the photograph is stranded in the device's
    // attachment queue, which is exactly what happened here before this line.
    // A model that declares `@@sync` and carries a `File` needs the verb its
    // own bytes travel on.
    methods: ['find', 'get', 'create', 'patch'],
  })
}
