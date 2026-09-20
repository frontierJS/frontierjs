// Where an order can be collected from.
//
// `@@gate("0.5.5.5")` — read by anybody, written by staff, for
// `shipping-methods`' reason one degree sharper: a storefront asks *which
// branch is near me* with no session at all.
//
// Nothing is written here. `near` is a FILTER at the Data boundary, so it
// arrives through the derived `find` like any other `where` — which is the
// whole point of it being a declaration rather than a verb: the gate, the row
// policies and the tenant filter are in front of it for free, and a custom
// method would have had to put each of them back.
import { createBaseService } from '@frontierjs/junction'

export function createPickupPointsService() {
  return createBaseService({ model: 'PickupPoint', channel: 'pickup-points' })
}
