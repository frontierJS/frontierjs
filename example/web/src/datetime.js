// web/src/datetime.js — which day a date is, on every screen that shows one.
//
// One owner because there were eight copies of the same helper, and because the
// copies answered in the wrong calendar. Each read the date in the VIEWER's
// zone, while an invoice's line text is frozen in the SHOP's: a billing period
// read `Aug 29` in the header and `30 Aug` on the line beneath it, on one page,
// for anyone west of Greenwich (`FJS-1149`).
//
// Two kinds of value arrive here, and they are read differently:
//
//   a plain date  '2026-09-14' — a billing period, a due date. It IS a day, so
//                 it is shown as that day and no zone is consulted; reading it
//                 as midnight UTC in New York would show the 13th.
//   an instant    '2026-09-14T03:10:00Z' — when an invoice was issued or paid.
//                 Shown as the day it fell on in the shop's calendar.
//
// The zone is the shop's `$.config.timeZone`, answered by `shopfront.settings`
// and read ONCE, before the app mounts (`main.js`), so no screen renders a date
// before it is known. The locale stays the reader's: the order a day and a
// month are written in is theirs, and which day it IS is the shop's.

import { getClient } from '@frontierjs/sierra/junction'
import { plainDateIn, addToDate } from '@frontierjs/toolbelt/datetime'

let timeZone = null

// UTC is the API's own floor for a shop that set nothing, so a calendar that
// failed to load reads what an unconfigured shop would have written.
const shopZone = () => timeZone ?? 'UTC'

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Ask the shop which calendar it keeps. `main.js` awaits this before mounting. */
export async function loadShopCalendar() {
  const settings = await getClient().service('shopfront').invoke('settings', null, {})
  timeZone = settings?.timeZone ?? null
}

/** The shop's zone, for a screen that has to turn a day into instants. */
export function calendarZone() {
  return shopZone()
}

/** The day it is now in the shop's calendar, as 'YYYY-MM-DD'. */
export function today() {
  return plainDateIn(Date.now(), shopZone())
}

/** `Sep 4, 2026` — a plain date as itself, an instant as its day in the shop's
 *  calendar, in the reader's locale. `—` for none. */
export function day(value) {
  if (!value) return '—'
  const date = PLAIN_DATE.test(value) ? value : plainDateIn(value, shopZone())
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`))
}

/** `Aug 30, 2026 – Sep 28, 2026` — a `[start, end)` period by its first and LAST
 *  day, which is how the invoice's own line text reads it (`describeSpan`). */
export function span(start, end) {
  if (!start || !end) return '—'
  return `${day(start)} – ${day(addToDate(end, { days: -1 }))}`
}
