// web/src/datetime.js
// When something happened, on every screen that says it.
//
// One owner because there were eight copies of *how long ago* and four answers:
// five screens floored to whole days, `notices.js` rounded and held hours until
// 48, and `/servers/` rounded and never passed hours, so one heartbeat read `2d
// ago` on one screen and `50h ago` on the next (`FJS-411`). The patterns are
// fixed rather than `toLocale*String()`, which orders a date however the
// browser's locale does — one date column reads `9/14/2026` for one operator
// and `14/09/2026` for the next, and `3/4` is either month. The words are
// `@frontierjs/toolbelt/datetime`'s; what stays here is this app's clock, its
// three patterns, and what a row with no time says.
//
// Every instant is read in the VIEWER's zone: a fleet has no calendar of its
// own, and a heartbeat is a moment rather than a day somebody is billed for.

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

/** `'Sep 14, 2026'` — when a row was created, or expires. */
export function day(instant, none = '—') {
  return instant ? dt.format(instant, 'MMM D, YYYY') : none
}

/** `'Sep 14, 2026, 4:05:03 PM'` — an event somebody may need to line up with a log. */
export function at(instant, none = '—') {
  return instant ? dt.format(instant, 'MMM D, YYYY, h:mm:ss aa') : none
}

/** `'4:05:03 PM'` — a step in a run that is already dated by the page around it. */
export function clock(instant, none = '—') {
  return instant ? dt.format(instant, 'h:mm:ss aa') : none
}
