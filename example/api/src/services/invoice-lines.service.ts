// What an invoice charged for, line by line.
//
// Read-only by declaration rather than by convention: `@@gate("1.8.8.8")` puts
// every write in a system context, and every column is `@immutable`, so even
// that context cannot restate one. The service exists because a detail screen
// needs the lines and a nested read would make the header's own policy the
// only thing protecting them.
import { createBaseService } from '@frontierjs/junction'

export function createInvoiceLinesService() {
  return createBaseService({
    model:   'InvoiceLine',
    channel: 'invoice-lines',
    methods: ['find', 'get'],
  })
}
