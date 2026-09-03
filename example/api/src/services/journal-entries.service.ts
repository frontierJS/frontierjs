// The books.
//
// `@@gate("5.9.9.9")` — read by staff, and every write is the system's. There
// is no `create` any caller can reach, which is the schema's statement rather
// than this file's: `api/src/domain/ledger.ts` posts every journal in the application
// and it is the only thing that does.
//
// What `asSystem()` does not get past is `@immutable`, which is what makes the
// balance worth checking once. A posted entry cannot be restated, so the sum
// that was zero when it was written is still zero.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'

export function createJournalEntriesService() {
  return createBaseService({
    model:   'JournalEntry',
    channel: 'journal-entries',

    /**
     * The entry, with both sides of it.
     *
     * `invoices.get`'s argument, and here it is stronger: a journal header on
     * its own carries no amount at all — the money is entirely in the lines —
     * so a `get()` that answered the row would answer a reference and a date
     * and nothing a person could check. A detail screen watches it with
     * `record(id, { composed: true })` (`FJS-D161`), because a WS push carries
     * the row alone and an uncomposed node would drop the lines the first time
     * anything announced the entry.
     *
     * Read through `$.db` rather than the system client: `JournalLine` carries
     * its own gate, and reading the lines through the header's would make the
     * header the only thing protecting them.
     */
    async get() {
      const db = $.db as Record<string, any>
      const id = Number($.id)

      const entry = await db.journalEntry.findFirst({ where: { id } })
      if (!entry) throw new NotFound('No such journal entry')

      const lines = await db.journalLine.findMany({
        where: { entryId: id }, orderBy: { id: 'asc' }, limit: 100,
      })

      return { ...entry, lines }
    },

    methods: ['find', 'get'],
  })
}
