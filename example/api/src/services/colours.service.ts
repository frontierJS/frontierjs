// The colourway list behind `ProductVariant.colour`.
//
// A service over the SOURCE of a value set, which is what makes the set
// reachable from the browser at all: a picker asks this service for the list,
// narrowed by the `@@scope` the set declares, so the values it offers are the
// values the Data boundary will accept.
//
// Nothing else calls it. That is the shape — a value set's source is a list
// somebody maintains, not a thing the app has screens about.
import { createBaseService } from '@frontierjs/junction'

export function createColoursService() {
  return createBaseService({ model: 'Colour', channel: 'colours' })
}
