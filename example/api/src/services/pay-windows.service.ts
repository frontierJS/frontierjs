// The pay history, row by row.
//
// Readable as an ordinary list because *what has this person been paid, and
// when did it change* is a question a screen asks directly — and because the
// as-at read on `employees` answers ONE window, which is the wrong shape for
// showing a history.
//
// Writes go through `employees.setPay` rather than here. Nothing stops a
// `create` at level 5 and that is deliberate: a correction to a window somebody
// entered wrong is a legitimate act, and `@immutable` on `rate`, `basis`,
// `employeeId` and `effectiveFrom` is what stops it being a quiet restatement.
import { createBaseService } from '@frontierjs/junction'

export function createPayWindowsService() {
  return createBaseService({
    model:   'PayWindow',
    channel: 'pay-windows',
    methods: ['find', 'get', 'create', 'update', 'patch'],
  })
}
