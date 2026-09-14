// web/src/datetime.js
// How long ago, on every screen that says it.
//
// One owner because there were seven copies and three answers: five screens
// floored to whole days, `notices.js` rounded and held hours until 48, and
// `/servers/` rounded and never passed hours, so one heartbeat read `2d ago`
// on one screen and `50h ago` on the next (`FJS-411`). The words are
// `@frontierjs/toolbelt/datetime`'s; what stays here is this app's clock and
// what a row with no time says.

import { createDatetime } from '@frontierjs/toolbelt/datetime'

export const dt = createDatetime({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  now:      Date.now,
})

/** `'5m ago'`, `'now'` under a minute, `'never'` for a row with no time. */
export function ago(iso) {
  return iso ? dt.relativeToNow(iso, { style: 'narrow' }) : 'never'
}
