// src/home-board.js — what a home's board says, target-neutral: the text and
// color of each thing `components/HomeBoard.mesa` writes over the furniture
// (`pieces/home.js`), from one board as `#errand`'s `homeBoard()` reads it.
// Each function takes the room it has — a piece's `inner` — and `now`, so a
// test lays out a board at a fixed clock.

export const INK = {
  fresh:  '#fbbf24',
  quiet:  '#d1d5db',
  stale:  '#6b7280',
  unread: '#fbbf24',
  read:   '#9ca3af',
  late:   '#f87171',
  title:  '#e5e7eb',
}

const DAY = 24 * 60 * 60 * 1000
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** How long ago, in three characters or fewer: `5m`, `3h`, `12d`, `2y`; '' for no time. */
export function ago(iso, now) {
  const ms = now - Date.parse(iso)
  if (!iso || Number.isNaN(ms)) return ''
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.round(m / 60)}h`
  if (m < 525_600) return `${Math.round(m / 1440)}d`
  return `${Math.round(m / 525_600)}y`
}

/** A project's name as a pin shows it: its domain's last part dropped, cut to `w` with an ellipsis. */
export function shortName(name, w) {
  const s = name.replace(/\s*\(.*\)$/, '').replace(/\.[a-z]{2,}$/i, '')
  return s.length > w ? `${s.slice(0, w - 1)}…` : s
}

const cut = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s)
const first = (name) => name.split(/\s+/)[0] ?? ''

/**
 * The cork board: a header naming the columns, then one line a project, the
 * one that moved last on top — its name, its to-dos as late/open with the late
 * in red, how long since anyone moved it, and how many of your notifications
 * it sent today. The line is as bright as the project is recent; a board of
 * more pins than lines says how many are left over on the last.
 * @returns {{ dx: number, dy: number, text: string, color: string }[]}
 */
export function pinCards(pins, { w, h }, now) {
  if (!pins.length) return [{ dx: 0, dy: 0, text: 'nothing pinned', color: INK.stale }]
  const TODOS = 7
  const AGE = 6
  const YOU = 7
  const nameW = w - 2 - 1 - TODOS - 1 - AGE - 1 - YOU
  const atTodos = 2 + nameW + 1
  const atAge = atTodos + TODOS + 1
  const atYou = atAge + AGE + 1
  const out = [
    { dx: 2, dy: 0, text: 'project', color: INK.stale },
    { dx: atTodos, dy: 0, text: 'todos'.padStart(TODOS), color: INK.stale },
    { dx: atAge, dy: 0, text: 'active'.padStart(AGE), color: INK.stale },
    { dx: atYou, dy: 0, text: 'for you'.padStart(YOU), color: INK.stale },
  ]
  const when = (p) => Date.parse(p.when) || 0
  const sorted = [...pins].sort((a, b) => when(b) - when(a))
  const room = h - 1
  const shown = sorted.length > room ? sorted.slice(0, room - 1) : sorted
  shown.forEach((p, i) => {
    const dy = i + 1
    const since = now - when(p)
    const color = since < DAY ? INK.title : since < 7 * DAY ? INK.quiet : INK.stale
    out.push({ dx: 0, dy, text: `◆ ${shortName(p.name, nameW)}`, color })
    if (p.open != null) {
      const total = `/${p.open}`
      const late = String(p.late)
      const dx = atTodos + TODOS - total.length - late.length
      out.push({ dx, dy, text: late, color: p.late ? INK.late : color })
      out.push({ dx: dx + late.length, dy, text: total, color })
    }
    out.push({ dx: atAge, dy, text: ago(p.when, now).padStart(AGE), color })
    if (p.fresh) out.push({ dx: atYou, dy, text: String(p.fresh).padStart(YOU), color: INK.fresh })
  })
  if (sorted.length > room) out.push({ dx: 0, dy: h - 1, text: `+ ${sorted.length - shown.length} more`, color: INK.stale })
  return out
}

// A terminal trims a line's leading spaces, so a read row is marked rather than indented.
const mark = (unread) => (unread ? '●' : '·')

/** One notification as a row: how long ago, the project, who, and what. */
function row(n, w, now) {
  const who = first(n.who)
  return cut(`${mark(n.unread)}${ago(n.when, now).padStart(3)} ${shortName(n.project, 10).padEnd(10)} ${who ? `${who}: ` : ''}${n.text}`, w)
}

/** The notifications not yet read, the only ones the screen shows. */
export const unreadOf = (inbox) => inbox.filter((n) => n.unread)

/**
 * The screen over the desk: the unread notifications, newest first, each line
 * at its row `dy`. Standing, as many as fit, the last row saying how many
 * more there are; sat at the desk, all of them from row `offset`, wrapping.
 * @returns {{ dy: number, text: string, color: string }[]}
 */
export function screenLines(inbox, { w, h }, now, { sitting = false, offset = 0 } = {}) {
  const unread = unreadOf(inbox)
  if (!unread.length) return [{ dy: 0, text: 'nothing unread', color: INK.stale }]
  const at = (n, dy) => ({ dy, text: row(n, w, now), color: INK.unread })
  if (unread.length <= h) return unread.map(at)
  if (!sitting) {
    return [
      ...unread.slice(0, h - 1).map(at),
      { dy: h - 1, text: cut(`+ ${unread.length - h + 1} more · sit at the desk to scroll`, w), color: INK.stale },
    ]
  }
  return Array.from({ length: h }, (_, dy) => at(unread[(offset + dy) % unread.length], dy))
}

/** A due date (`2026-10-17`) at local midnight, so a day is due all of that day. */
const dayOf = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

/**
 * The calendar: today, how many are due and how many are late, and the next
 * one not yet late — else the oldest that is.
 * @returns {{ text: string, color: string }[]}
 */
export function calendarLines(due, { w, h }, now) {
  const today = new Date(now)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const late = due.filter((d) => dayOf(d.when) < midnight)
  const ahead = due.filter((d) => dayOf(d.when) >= midnight).sort((a, b) => dayOf(a.when) - dayOf(b.when))
  const next = ahead[0] ?? late[0]
  const when = (d) => { const t = new Date(dayOf(d.when)); return `${MONTHS[t.getMonth()]} ${t.getDate()}` }
  return [
    { text: `${MONTHS[today.getMonth()]} ${today.getDate()}`, color: INK.title },
    { text: `${due.length} due`, color: due.length ? INK.quiet : INK.stale },
    { text: late.length ? `${late.length} late` : 'none late', color: late.length ? INK.late : INK.stale },
    { text: next ? `${ahead[0] ? 'next' : 'from'} ${when(next)}` : '', color: ahead[0] ? INK.fresh : INK.late },
  ].slice(0, h).map((l) => ({ ...l, text: cut(l.text, w) }))
}

/** The pings as the pane by the bell lists them, newest first, under a title. */
export function pingLines(pings, w, h, now) {
  const rows = pings.slice(0, h - 1).map((p) => ({
    text: cut(`${mark(p.unread)}${ago(p.when, now).padStart(3)} ${first(p.who)} (${shortName(p.project, 12)}): ${p.text}`, w),
    color: p.unread ? INK.unread : INK.read,
  }))
  return [{ text: '— pings —', color: INK.title }, ...(rows.length ? rows : [{ text: 'nobody has rung', color: INK.stale }])]
}

/** The bell rings for an unread ping, or one inside the last hour. */
export const ringing = (pings, now) => pings.some((p) => p.unread || now - Date.parse(p.when) < 60 * 60 * 1000)

/** The post on the mat: one letter a thing unread, inbox and pings both, as many as fit. */
export const post = (board) => board.inbox.filter((n) => n.unread).length + board.pings.filter((p) => p.unread).length
