// web/src/lib/sky/held.js — what this screen holds of the almanac in place of
// the clock's (`/weather`, `/season`), handed to `shared/sky.js` as `held`.
// Kept across doors, since a scene is a fresh mount and the module is not.
// Never sent: the server reads the clock under the environment's pins, so two
// screens in one room may stand in two weathers.
import { HOLDABLE } from '#shared/sky.js'

/** This screen's holds, by field; null is the clock's. Read it, never write it: `hold()` refuses a value the almanac has no name for. */
export const held = { weather: null, season: null }

/** Hold this screen's `field` of the almanac at `value`, or hand it back to the clock with null. */
export function hold(field, value) {
  const values = HOLDABLE[field]
  if (!values) throw new Error(`the almanac holds no ${field}; a screen holds ${Object.keys(HOLDABLE).join(', ')}`)
  if (value !== null && !values.includes(value)) throw new Error(`no ${field} is called ${value}; it is one of ${values.join(', ')}`)
  held[field] = value
}
