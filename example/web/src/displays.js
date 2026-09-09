// web/src/displays.js — what this shop renders differently from the kit.
//
// The reading half of `money-control.js`, and the same rule (`FJS-D17`): a
// contributed renderer is TWO registrations and one name across them.
// `registerDisplay` (sierra) answers WHICH renderer a column gets, from the
// schema alone, in plain Node; `registerDisplayComponent` (@frontierjs/ui) says
// what that name draws. A name is the only thing that can cross — sierra's
// table runs in a prerender where no component can be loaded, and the kit peers
// on mesa and css and cannot import sierra.
//
// A DISPLAY is a second registry beside the control one (`FJS-D242`), because
// the two tables disagree at their first branch: a control refuses `@system`,
// `@computed` and `@generated` by rule, and those are among the columns a table
// most wants.
//
// ─── The two halves are not both needed every time ────────────────────────
//
// `money` needs only the RENDERING half: `displayFor` already answers `money`
// for any `x-money` column, so there is nothing left to name. What the kit
// cannot know is that this app has a reader-chosen display currency — that is
// `web/src/money.js`, and it is not in `db/schema.lite` and should not be. A
// shop keeps its books in one currency and a person reads it in another.
//
// `status` needs BOTH, because the built-in table has no name for it: it
// answers `enum` for every bound column in the app, and claiming that name
// would put an order's colours on a country picker. The `{ field, model }` the
// resolver is handed is what makes the claim narrow.
import { registerDisplay }          from '@frontierjs/sierra/junction'
import { registerDisplayComponent } from '@frontierjs/ui/controls'

import MoneyCell  from './MoneyCell.mesa'
import StatusPill from './StatusPill.mesa'

registerDisplayComponent('money', MoneyCell)

// Claimed by NAME rather than by type. Every `status` in this schema is a
// bound enum, and an enum that is not a status — `Product.brand`, a country —
// keeps the kit's Badge. Resolving on *is it an enum* would claim all of them.
registerDisplay('status', (rule, ctx) =>
  ctx?.field === 'status' && (rule?.enum || rule?.values) ? 'status' : null)

registerDisplayComponent('status', StatusPill)
