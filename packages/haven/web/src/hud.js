// src/hud.js — the foot of the screen drawn as boxes, as text: this member's
// card on the left, a hotbar of what they carry in the middle, the room as a
// minimap on the right. Pure — `Profile.mesa` owns what is asked and when.
//
// A line is cut and padded by `cells()`, never `length`, since a glyph or a
// nick may take two cells and a box edge one cell off is a torn frame.
import { cells, clip } from './cells.js'

export const HEIGHT = 5
export const ROWS   = HEIGHT - 2

/** What an item is drawn as in its slot, three cells wide. */
const ICONS = {
  arrow:    '-->',
  minnow:   '><>',
  perch:    '>#>',
  trout:    '>=>',
  catfish:  '>~>',
  eel:      '~~>',
  pike:     '>>>',
  moonfish: '>*>',
}

const LEFT   = 20
const RIGHT  = 18
const SLOT_W = 7
export const MIN_W = LEFT + RIGHT + SLOT_W + 4

const pad = (text, n) => {
  const t = clip(text, n)
  return t + ' '.repeat(n - cells(t))
}

/** A box `w` cells wide round `lines`, `title` set into its top edge. */
export function box(title, lines, w) {
  const label = title ? ` ${clip(title, w - 6)} ` : ''
  const top   = `┌─${label}${'─'.repeat(w - 3 - cells(label))}┐`
  return [top, ...lines.map((l) => `│${pad(l, w - 2)}│`), `└${'─'.repeat(w - 2)}┘`]
}

/** One hotbar slot, three rows: its key in the top edge, its count in the bottom. */
export function slot(n, item, count) {
  if (!item) return [`┌─ ${n} ─┐`, '│     │', '└─────┘']
  return [`┌─ ${n} ─┐`, `│ ${ICONS[item] ?? item.slice(0, 3).padEnd(3)} │`, `└${`─${count}`.padEnd(SLOT_W - 2, '─')}┘`]
}

/** `rows` of a map snap, `w` by `h` of it, cut round block `at` and `@` on it. */
export function windowOf(rows, at, w, h) {
  const width = Math.max(0, ...rows.map((r) => r.length))
  const x0 = Math.max(0, Math.min(at.x - (w >> 1), width - w))
  const y0 = Math.max(0, Math.min(at.y - (h >> 1), rows.length - h))
  return Array.from({ length: h }, (_, j) => {
    const row = (rows[y0 + j] ?? '').padEnd(width, ' ').split('')
    if (y0 + j === at.y && at.x >= x0 && at.x < x0 + w) row[at.x] = '@'
    return row.slice(x0, x0 + w).join('')
  })
}

/**
 * The whole foot: `HEIGHT` rows `w` cells wide, or none where `w` is too
 * narrow for the three boxes. `held` is a count per item name, `items` the
 * names in slot order, `mini` the room's snap rows with `at` the figure's
 * block in them.
 */
export function hud({ w, nick, glyph, room, way, items, held, mini, at }) {
  if (w < MIN_W) return []
  const mid   = w - LEFT - RIGHT
  const fits  = Math.min(9, Math.max(1, Math.floor((mid - 1) / (SLOT_W + 1))))
  const slots = Array.from({ length: fits }, (_, i) => slot(i + 1, items[i], held[items[i]] ?? 0))
  const pack  = Array.from({ length: ROWS }, (_, r) => slots.map((s) => s[r]).join(' '))
  const card  = box(nick, [` ${glyph}  ${room}`, ` facing ${way}`, ' /inv lists pack'], LEFT)
  const bar   = box('pack', pack.map((l) => ` ${l}`), mid)
  const maps  = box('/map', windowOf(mini, at, RIGHT - 2, ROWS), RIGHT)
  return card.map((l, i) => l + bar[i] + maps[i])
}
