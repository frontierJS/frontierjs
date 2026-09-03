// The documents.
//
// `@@gate("5.5.8.8")` — read and created at 5, written only by the system.
//
// Not `9`, and the two are easy to confuse: `9` is LOCKED, so it would freeze
// the ROW, and a payslip still has to move — `sentAt` is stamped after it is
// issued, and reverting a miscalculated run has to be able to remove the
// payslips it made. What holds the FIGURES is `@immutable` on every one of
// them: the gate refuses the caller and the column refuses the value, and only
// the second has anything to say to `asSystem()`.
//
// The composed `get` is `invoices.get`'s argument in a domain where it is
// sharper — a payslip header is four totals, and a person reading one wants to
// know which bands produced them.
import { createBaseService, NotFound, $ } from '@frontierjs/junction'

export function createPayslipsService() {
  return createBaseService({
    model:   'Payslip',
    channel: 'payslips',

    async get() {
      const db = $.db as Record<string, any>
      const id = Number($.id)

      const slip = await db.payslip.findFirst({ where: { id } })
      if (!slip) throw new NotFound('No such payslip')

      const lines = await db.payslipLine.findMany({
        where: { payslipId: id }, orderBy: { id: 'asc' }, limit: 100,
      })
      return { ...slip, lines }
    },

    methods: ['find', 'get'],
  })
}
