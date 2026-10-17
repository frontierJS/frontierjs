// The whole service. The name comes from the filename — 'products' → /api/products
// → db.product — and CRUD, the 401s and the 400s all come from the model.
import { createService } from '@frontierjs/junction'

export default createService({ channel: 'products', paginate: { default: 20, max: 200 } })
