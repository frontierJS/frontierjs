// One side of one journal.
//
// Read-only by declaration rather than by convention, exactly as
// `invoice-lines` is: `@@gate("5.9.9.9")` puts every write in a system context
// and every column is `@immutable`, so even that context cannot restate one.
//
// The service exists because a trial-balance screen sums lines ACROSS entries —
// which is the one question the composed `journal-entries.get` cannot answer,
// since it is scoped to a single header.
import { createBaseService } from '@frontierjs/junction'

export function createJournalLinesService() {
  return createBaseService({
    model:   'JournalLine',
    channel: 'journal-lines',
    methods: ['find', 'get'],
  })
}
