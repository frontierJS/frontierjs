// The documents.
//
// `@@gate("1.8.4.8")` — read at 1, created and deleted by the system alone,
// because an invoice is issued by billing and by nothing else. Update
// is staff's, and reaches only the moves. There is no
// `create` a person can reach, and that is the schema's statement rather than
// this file's: `api/src/domain/billing` writes them, on the client of whoever
// caused the document with the gate named (`system: ['@@gate']`, `FJS-D575`),
// and it is the only thing that does.
//
// What no lift gets past is `@immutable`, which is the whole reason that
// arrangement is safe. A renewal runs as the shop and could otherwise restate a
// total it had already issued.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'
import { settleInvoice, voidInvoice }     from '../domain/billing'

/** The invoice this call names, read as the caller.
 *
 *  Before a move, because a move refused on a row the caller cannot read
 *  answers differently from one on a row that does not exist — 403 against
 *  204 — which confirms which invoice numbers are real (`FJS-1093`). Read
 *  first, both are this 404, and the move's own refusal only reaches a caller
 *  who can already see the row. */
async function readable(): Promise<{ id: number }> {
  const row = await ($.db as any).invoice.findFirst({ where: { id: Number($.id) } })
  if (!row) throw new NotFound('Invoice not found')
  return row
}

export function createInvoicesService() {
  return createBaseService({
    model:   'Invoice',
    channel: 'invoices',

    /**
     * The document, with the lines that make it up.
     *
     * A statement is a header AND its lines — a total with nothing under it is
     * not something anybody can check — so this `get()` answers more than the
     * row, and the detail screen watches it with `record(id, { composed: true })`
     * (`FJS-D161`). A plain node holds one shape and a WS push carries the row
     * alone, so watching an uncomposed node here would drop the lines the first
     * time anything announced the invoice.
     *
     * A CRUD method written on the definition WINS over the generated one
     * (`FJS-426`), and the derived hooks still attach by name, so the gate and
     * the row policies grade this exactly as they graded the read it replaces.
     * All three reads go through `$.db` for the same reason: `InvoiceLine` and
     * `CreditNote` each carry their own `@@allow` pair, and reading them
     * through the header's policy would make the header the only thing
     * protecting them.
     */
    get: async () => {
      const db = $.db as any
      const id = Number($.id)

      const invoice = await db.invoice.findFirst({ where: { id } })
      // The row policy compiles into the WHERE, so *not yours* and *not there*
      // are one answer here — which is the answer they should be. A 404 that
      // distinguished them would confirm which invoice numbers exist.
      if (!invoice) throw new NotFound('Invoice not found')

      const [lines, creditNotes] = await Promise.all([
        db.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { id: 'asc' }, limit: 200 }),
        db.creditNote.findMany({ where: { invoiceId: id }, orderBy: { id: 'asc' }, limit: 50 }),
      ])

      return { ...invoice, lines, creditNotes }
    },

    /**
     * The money arrived.
     *
     * `@system` in `@@transitions`, so this method cannot be it — a caller
     * asking to be marked paid is not a request a shop can honor. It is here
     * for the same shape `orders.pay` has: the webhook path settles the row,
     * and this is the staff button for the bank transfer somebody reconciled by
     * hand. Both go through the same transition, which is the only arrangement
     * where they cannot drift.
     *
     * On the CALLER's client. `@system` on the move is lifted by naming it on
     * the call, which leaves the gate and `@@allow('update', auth().isStaff)`
     * grading who pressed the button — `asSystem()` here grades nobody, and a
     * custom method's gate floor is only a presence check (`FJS-1087`).
     *
     * A `pastDue` subscription whose ledger this clears goes back to `active`
     * inside `settleInvoice` (`FJS-D363`), so nothing here has to know that a
     * subscription exists.
     */
    settle: async () => {
      const db  = $.db as any
      const row = await readable()
      await settleInvoice(db, row.id)
      return await db.invoice.findFirst({ where: { id: row.id } })
    },

    /**
     * It should never have been issued.
     *
     * `@gate(5)` on the move: voiding is a manager's decision, where settling is
     * the shop recording money it received. It changes the status alone —
     * every figure on the row stays exactly as it was issued, because a voided
     * invoice still has to be readable as the document it was. It can clear a
     * ledger as a settle can, so it recovers the subscription the same way.
     */
    void: async () => voidInvoice($.db as any, (await readable()).id),

    methods: ['find', 'get', 'settle', 'void'],
  })
}
