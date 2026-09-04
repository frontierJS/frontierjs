// The documents.
//
// `@@gate("1.8.8.8")` — read at 1 and every write is the system's, because an
// invoice is issued by the renewal job and by nothing else. There is no
// `create` a person can reach, and that is the schema's statement rather than
// this file's: `api/src/domain/billing` writes them through `asSystem()`, and it is
// the only thing that does.
//
// What `asSystem()` does NOT get past is `@immutable`, which is the whole
// reason that arrangement is safe. The renewal job runs with no session and
// could otherwise restate a total it had already issued.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'
import { settleInvoice }                  from '../domain/billing'

type Invoices = { invoice: { transition(id: unknown, name: string): Promise<unknown> } }
const invoices = () => $.db as unknown as Invoices

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
     * Dunning notices on its own — `dun-subscriptions` recovers a subscription
     * whose ledger has come clean — so nothing here has to know that a
     * subscription exists.
     */
    settle: async () => {
      const db = $.db as any
      await settleInvoice(db.asSystem(), Number($.id))
      return await db.invoice.findFirst({ where: { id: Number($.id) } })
    },

    /**
     * It should never have been issued.
     *
     * `@gate(5)` on the move: voiding is a manager's decision, where settling is
     * the engine's. It is the only write to an issued invoice anybody may ask
     * for, and it changes the status alone — every figure on the row stays
     * exactly as it was issued, because a voided invoice still has to be
     * readable as the document it was.
     */
    void: async () => invoices().invoice.transition($.id, 'void'),

    methods: ['find', 'get', 'settle', 'void'],
  })
}
