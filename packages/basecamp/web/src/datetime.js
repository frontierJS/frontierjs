// web/src/datetime.js
// How long ago, on every screen that says it.
//
// One owner because there were eight copies and four answers: five screens
// floored to whole days, `notices.js` rounded and held hours until 48, and
// `/servers/` rounded and never passed hours, so one heartbeat read `2d ago`
// on one screen and `50h ago` on the next (`FJS-411`), while `/volumes/` said
// `yesterday` and `3 days ago`. The words are `@frontierjs/toolbelt/datetime`'s;
// what stays here is this app's clock and what a row with no time says.

import { createDatetime } from '@frontierjs/toolbelt/datetime'

export const dt = createDatetime({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  now:      Date.now,
})

/**
 * `'5m ago'`, `'now'` under a minute, and `none` for a row with no time — `never`
 * unless the screen means something else by absent, as *created unknown* does.
 */
export function ago(iso, none = 'never') {
  return iso ? dt.relativeToNow(iso, { style: 'narrow' }) : none
}
