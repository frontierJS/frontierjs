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

// A pin keeps its color by its place on the board, as the bar's rows do.
const PIN_INKS = ['#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171']

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
 * The cork board: two cards to a row, each a pin line — the name and how long
 * since the project moved — and under it what moved there today. A board of
 * more pins than cards says how many are left over in the last card.
 * @returns {{ dx: number, dy: number, text: string, color: string }[]}
 */
export function pinCards(pins, { w, h }, now) {
  const col = Math.floor((w - 2) / 2)
  const slots = Math.floor((h + 1) / 2) * 2
  const shown = pins.length > slots ? pins.slice(0, slots - 1) : pins
  const out = []
  shown.forEach((p, i) => {
    const dx = (i % 2) * (col + 2)
    const dy = Math.floor(i / 2) * 2
    const age = ago(p.when, now)
    const name = shortName(p.name, col - 8)
    const color = p.fresh ? INK.fresh : now - Date.parse(p.when) < 7 * DAY ? INK.quiet : INK.stale
    out.push({ dx, dy, text: `◆ ${name.padEnd(col - 8)} ${age.padStart(4)}`, color: PIN_INKS[i % PIN_INKS.length] })
    if (dy + 1 < h && age) out.push({ dx: dx + 2, dy: dy + 1, text: (p.fresh ? `${p.fresh} today` : 'quiet').slice(0, col - 2), color })
  })
  if (pins.length > slots) {
    const i = slots - 1
    out.push({ dx: (i % 2) * (col + 2), dy: Math.floor(i / 2) * 2, text: `+ ${pins.length - shown.length} more`, color: INK.stale })
  }
  if (!pins.length) out.push({ dx: 0, dy: 0, text: 'nothing pinned', color: INK.stale })
  return out
}

// A terminal trims a line's leading spaces, so a read row is marked rather than indented.
const mark = (unread) => (unread ? '●' : '·')

/** One notification as a row: how long ago, the project, who, and what. */
function row(n, w, now) {
  const who = first(n.who)
  return cut(`${mark(n.unread)}${ago(n.when, now).padStart(3)} ${shortName(n.project, 10).padEnd(10)} ${who ? `${who}: ` : ''}${n.text}`, w)
}

/**
 * The screen over the desk, each line at its row `dy`, since an empty line
 * takes no row. Standing, it is the count, the newest under it and a hint on
 * the last row; sat at the desk, the whole inbox from row `offset`, wrapping.
 * @returns {{ dy: number, text: string, color: string }[]}
 */
export function screenLines(inbox, { w, h }, now, { sitting = false, offset = 0 } = {}) {
  if (!inbox.length) return [{ dy: 0, text: 'inbox zero', color: INK.quiet }]
  const unread = inbox.filter((n) => n.unread).length
  if (!sitting) {
    return [
      { dy: 0, text: cut(unread ? `● ${unread} unread · ${inbox.length} in the tray` : `all read · ${inbox.length} in the tray`, w), color: unread ? INK.unread : INK.quiet },
      ...inbox.slice(0, Math.max(0, h - 3)).map((n, i) => ({ dy: i + 1, text: row(n, w, now), color: n.unread ? INK.unread : INK.read })),
      { dy: h - 1, text: 'sit at the desk to read on', color: INK.stale },
    ]
  }
  const idx = inbox.length > h ? Array.from({ length: h }, (_, i) => (offset + i) % inbox.length) : inbox.map((_, i) => i)
  return idx.map((n, i) => ({ dy: i, text: row(inbox[n], w, now), color: inbox[n].unread ? INK.unread : INK.read }))
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
