// web/src/datetime.js — which day a date is, on every screen that shows one.
//
// One owner because there were eight copies of the same helper, and because the
// copies answered in the wrong calendar. Each read the date in the VIEWER's
// zone, while an invoice's line text is frozen in the SHOP's: a billing period
// starting 03:10Z read `Aug 29` in the header and `30 Aug` on the line beneath
// it, on one page, for anyone west of Greenwich (`FJS-1149`). A period, a due
// date, a start date and an effective date are days in the shop's calendar, so
// they are read in it here, whoever is looking.
//
// The zone is the shop's `$.config.timeZone`, answered by `shopfront.settings`
// and read ONCE, before the app mounts (`main.js`), so no screen renders a date
// before it is known. The locale stays the reader's: the order a day and a
// month are written in is theirs, and which day it IS is the shop's.
//
// Dates only. A timestamp — when a stock movement was recorded — is an instant
// a person reads in their own zone, and does not come through here.

import { getClient } from '@frontierjs/sierra/junction'

let timeZone = null

/** Ask the shop which calendar it keeps. `main.js` awaits this before mounting. */
export async function loadShopCalendar() {
  const settings = await getClient().service('shopfront').invoke('settings', null, {})
  timeZone = settings?.timeZone ?? null
}

/** `Sep 4, 2026` — a day in the shop's calendar, in the reader's locale. `—` for none. */
export function day(iso) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    // UTC is the API's own floor for a shop that set nothing, so a calendar
    // that failed to load reads what an unconfigured shop would have written.
    timeZone: timeZone ?? 'UTC',
  }).format(new Date(iso))
}
