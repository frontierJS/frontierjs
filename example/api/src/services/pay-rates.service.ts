// The band tables a payroll is computed from.
//
// An ordinary CRUD service and that is the point: a band is reference data
// somebody in the office maintains, not a document the application issues. What
// stops it being edited into the past is `@immutable` on `kind`, the two
// thresholds and `percent` — a band's rate is corrected by closing its window
// and opening the next, exactly as a pay window is, so a payslip issued last
// year still reproduces.
//
// `effectiveTo` stays writable, and must: closing a window is how the next one
// opens. See `db/schema.lite`'s model header.
import { createBaseService } from '@frontierjs/junction'

export function createPayRatesService() {
  return createBaseService({
    model:   'PayRate',
    channel: 'pay-rates',
    methods: ['find', 'get', 'create', 'update', 'patch', 'remove'],
  })
}
