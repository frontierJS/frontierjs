// src/lib/home/snooze.js — what the desk's `/snooze` hides and until when, pure.
//
// A snooze puts a linked item away until a day. It is keyed by the item's URL,
// the one thing a report and an `/ask` answer both give an item, so the same
// ticket stays away whichever drew it. `#errand` keeps them on this machine.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A local calendar day as `YYYY-MM-DD`; a snooze ends on a day, at `WAKE_HOUR`. */
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const dayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const plus = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** The hour of its day a snooze ends, local: the item is back with the morning, not at midnight. */
export const WAKE_HOUR = 8

/** When a snooze ending on `until` (`YYYY-MM-DD`) is over. */
export const wakeOf = (until) => { const d = dayOf(until); d.setHours(WAKE_HOUR); return d }

/** `2026-10-24` as `Sat Oct 24`. */
export function dayLabel(s) {
  const d = dayOf(s)
  const day = DAYS[d.getDay()]
  return `${day[0].toUpperCase()}${day.slice(1, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/**
 * The day a snooze ends, `YYYY-MM-DD`, from the word after `/snooze <n>`:
 * none or `tomorrow`, a weekday (the next one, never today), `3d` or `2w`,
 * `2026-10-24`, or `10/24` (this year, else next). Null for a word it does
 * not read, and for a day not after `today`, which would hide nothing.
 */
export function untilOf(said, today = new Date()) {
  const t = plus(today, 0)
  const w = String(said ?? '').trim().toLowerCase()
  let d = null
  if (!w || w === 'tomorrow' || w === 'tmrw') d = plus(t, 1)
  else if (/^\d+[dw]$/.test(w)) d = plus(t, parseInt(w, 10) * (w.endsWith('w') ? 7 : 1))
  else if (/^\d{4}-\d{2}-\d{2}$/.test(w)) d = dayOf(w)
  else if (/^\d{1,2}[/-]\d{1,2}$/.test(w)) {
    const [m, day] = w.split(/[/-]/).map(Number)
    d = new Date(t.getFullYear(), m - 1, day)
    if (d <= t) d = new Date(t.getFullYear() + 1, m - 1, day)
    // A month or day out of range rolls over in `new Date`, to a day nobody said.
    if (d.getMonth() !== m - 1) d = null
  } else if (w.length >= 3) {
    const n = DAYS.findIndex((name) => name.startsWith(w))
    if (n >= 0) d = plus(t, ((n - t.getDay() + 6) % 7) + 1)
  }
  if (!d || Number.isNaN(d.getTime()) || ymd(d) <= ymd(t)) return null
  if (/^\d{4}-/.test(w) && ymd(d) !== w) return null
  return ymd(d)
}

/** `2026-10-24` as `Sat Oct 24 8am`, when that snooze is over. */
export const wakeLabel = (until) => `${dayLabel(until)} ${WAKE_HOUR}am`

/** Whether `snoozes` (`{ [url]: { until } }`) hides `url` at `now`. */
export const isSnoozed = (snoozes, url, now = new Date()) => !!url && !!snoozes[url] && now < wakeOf(snoozes[url].until)

/**
 * `answer` less every list item `snoozes` hides, and how many it hid. A list
 * left empty goes, and a heading with nothing of its own under it, as
 * `filterAnswer` cuts them; the counts stay as the report gave them.
 */
export function hideSnoozed(answer, snoozes, now = new Date()) {
  let hidden = 0
  const cut = answer.blocks.map((b) => {
    if (b.kind !== 'list') return b
    const items = b.items.filter((i) => !isSnoozed(snoozes, i.url, now))
    hidden += b.items.length - items.length
    return { ...b, items }
  }).filter((b) => b.kind !== 'list' || b.items.length)
  if (!hidden) return { answer, hidden }
  const blocks = cut.filter((b, n) => b.kind !== 'heading' || (cut[n + 1] && cut[n + 1].kind !== 'heading'))
  return { answer: { ...answer, blocks }, hidden }
}
