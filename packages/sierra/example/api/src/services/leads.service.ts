// The whole service. Name from the filename ('leads' → /api/leads → db.lead),
// CRUD from the model, 401s from @@gate, 400s from the field rules.
import { createService } from '@frontierjs/junction'

export default createService({ channel: 'leads' })
