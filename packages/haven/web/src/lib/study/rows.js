// src/lib/study/rows.js — a session's messages as the rows the study's pane
// draws (`IDEAS/study.md` 1.3), pure: each message wrapped to the pane's
// width with the ink its kind is drawn in, so `Study.mesa` only windows them.
// A thought and a tool call are one row each, since a session's calls would
// otherwise bury what it said.
//
// Terminal only, as `session.js` is: the wrap is `Bun.wrapAnsi`, which keeps a
// line's indent where `answer.js`'s `wrap` folds every run of spaces to one,
// and an answer's code is indented.
import { clip } from '../scene/cells.js'
import { TONES } from '../home/answer.js'

/**
 * `text` as rows of at most `w` cells: its own line breaks kept, a long line
 * broken at a word, a longer word cut. A line's indent carries onto the rows
 * it wraps to; the space a break falls on does not.
 */
export function wrapped(text, w) {
  const rows = []
  for (const line of String(text).replaceAll('\t', '  ').split('\n')) {
    const indent = /^ */.exec(line)[0].slice(0, Math.max(0, w - 8))
    const rest = line.slice(indent.length).trimEnd()
    if (!rest) { rows.push(''); continue }
    for (const r of Bun.wrapAnsi(rest, Math.max(1, w - indent.length), { hard: true, trim: true }).split('\n')) rows.push(indent + r)
  }
  return rows
}

const MARK = (m) => m.failed ? ['✗', TONES.danger] : m.done ? ['✓', TONES.muted] : ['…', TONES.warn]

const secs = (ms) => ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`

/** The rows of one message. `ink` undefined is the terminal's own. */
function rowsOfOne(m, w) {
  switch (m.kind) {
    case 'you':
      return wrapped(m.text, w - 2).map((text, i) => ({ text: `${i ? '  ' : '› '}${text}`, ink: TONES.info }))
    case 'said':
      return wrapped(m.text, w).map((text) => ({ text }))
    case 'thought':
      return [{ text: clip(`∴ ${m.text.trim().split('\n')[0]}`, w), ink: TONES.muted }]
    case 'tool': {
      const [mark, ink] = MARK(m)
      return [{ text: clip(`${mark} ${m.line}`, w), ink }]
    }
    case 'turn':
      return m.error
        ? wrapped(`— ${m.error}`, w).map((text) => ({ text, ink: TONES.danger }))
        : [{ text: clip(`— ${secs(m.ms)} · $${m.cost.toFixed(3)}`, w), ink: TONES.muted }]
    case 'error':
      return wrapped(`! ${m.text}`, w).map((text) => ({ text, ink: TONES.danger }))
    default:
      return []
  }
}

/** Every row of `messages` at `w` cells, a blank row before each line sent but the first. */
export function rowsOf(messages, w) {
  const rows = []
  for (const m of messages) {
    if (m.kind === 'you' && rows.length) rows.push({ text: '' })
    rows.push(...rowsOfOne(m, w))
  }
  return rows
}

/**
 * The `room` rows from row `top`, or the newest when `top` is null. A reader
 * scrolled back holds a row rather than a distance from the end, so what
 * arrives meanwhile does not move what they are reading. `below` is how many
 * newer rows are out of sight.
 */
export function windowOf(rows, room, top = null) {
  const last  = Math.max(0, rows.length - room)
  const start = top == null ? last : Math.min(Math.max(0, top), last)
  return { rows: rows.slice(start, start + room), start, below: Math.max(0, rows.length - start - room) }
}
