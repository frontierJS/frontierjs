// The rate this shop collects.
//
// A table and not a constant because this is a FLEET: `tenancy { strategy
// database }` gives every shop its own file, and two shops in two jurisdictions
// disagree about both the number and what it is called. A constant in the API
// would be the one fact about a shop every shop had to share.
//
// Read at 0 so a storefront can show tax-inclusive pricing without a session.
// `pricing.ts` takes the first active default and charges nothing where there
// is none — a shop nobody has configured is one that does not charge tax, not
// one that refuses to sell.
import { createBaseService } from '@frontierjs/junction'

export function createTaxRatesService() {
  return createBaseService({ model: 'TaxRate', channel: 'tax-rates' })
}
