// The corrections.
//
// A credit note is how an issued invoice is put right, and it is a row beside
// the invoice rather than an edit to it — which is what lets every figure on
// `Invoice` be `@immutable` (`FJS-D162`). Read at 1 with the same two policies
// the invoice carries; written by the application.
import { createBaseService } from '@frontierjs/junction'

export function createCreditNotesService() {
  return createBaseService({
    model:   'CreditNote',
    channel: 'credit-notes',
    methods: ['find', 'get'],
  })
}
