// The whole service. The name comes from the filename — 'products' → /api/products
// → db.product — and CRUD, the 401s and the 400s all come from the model.
import { createBaseService } from '@frontierjs/junction'

export function createProductsService() {
  return createBaseService({ channel: 'products' })
}
