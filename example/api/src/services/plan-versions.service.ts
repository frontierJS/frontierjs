// A price, over the window it applied.
//
// The rows nothing edits: `PlanVersion.price` and `effectiveFrom` are
// `@immutable` (`FJS-D162`), so raising a price is closing one window and
// opening another rather than a PATCH. The Data boundary refuses the PATCH by
// name, which is what makes that a rule rather than a convention somebody
// documented.
//
// **The schema says *one OPEN window per plan*** —
// `@@unique([planId], where: effectiveTo == null)`, `FJS-603` — so a service
// that closes and opens in one transaction is how the second write is made
// legal rather than where the rule lives. It is not implemented here yet: nothing in the app raises a price, and a method that exists to hold
// a rule nobody exercises is a method that is wrong the first time somebody
// needs it.
import { createBaseService } from '@frontierjs/junction'

export function createPlanVersionsService() {
  return createBaseService({ model: 'PlanVersion', channel: 'plan-versions' })
}
