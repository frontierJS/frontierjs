// The whole service. Name from the filename ('leads' → /api/leads → db.lead),
// CRUD from the model, 401s from @@gate, 400s from the field rules.
import { createBaseService } from '@frontierjs/junction'

export function createLeadsService() {
  return createBaseService({ channel: 'leads' })
}
