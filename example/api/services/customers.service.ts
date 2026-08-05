import { createBaseService } from '@frontierjs/junction'

// `notes` is @guarded(5) in the schema, so it is stripped from this service's
// responses for anyone below level 5 without a line of code here saying so.
export function createCustomersService() {
  return createBaseService({ channel: 'customers' })
}
