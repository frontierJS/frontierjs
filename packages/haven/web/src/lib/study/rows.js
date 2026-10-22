// src/lib/study/rows.js — a session's messages as the rows the study's pane
// draws (`IDEAS/study.md` 1.3), pure: each message wrapped to the pane's
// width with the ink its kind is drawn in, so `Study.mesa` only windows them.
//
// A row is the whole width of the pane, its gutter included: the terminal
// paints no CSS, so the pane's padding is spaces, and a line the owner sent is
// a band on the scene's own bubble ground (`crowd.js`'s `BUBBLE`), which
// colors every cell of the row. Claude's reply opens under `● Claude`; a run
// of calls shows its last `SHOW_TOOLS` and how many came before, so the words
// are not lost between them, as the workbench's chat does. A thought is one row.
//
// A tab's fold (`/fold`) squashes a side as the workbench's Collapse does:
// `mine` the owner's lines, `claude` the replies, `both` both. A folded line
// or reply keeps `CLAMP` rows and marks the cut `…`; a folded run of calls is
// one row, `› 12 calls`, and a folded reply drops its thoughts.
//
// Terminal only, as `session.js` is: the wrap is `Bun.wrapAnsi`, which keeps a
// line's indent where `answer.js`'s `wrap` folds every run of spaces to one,
// and an answer's code is indented.
import { cells, clip } from '../scene/cells.js'
import { BUBBLE } from '../scene/crowd.js'
import { TONES } from '../home/answer.js'
import { toolLine } from './session.js'

/** The pane's left padding; the right keeps a space and the rail's column. */
export const GUTTER = '  '
export const inner = (w) => Math.max(8, w - 4)

/** Claude's mark, the heading of a reply, and the ink of a fenced block. */
export const CLAUDE = '#d97757'
const HEADING = '#fde68a'
const CODE    = '#c4b5fd'

/** The calls of one run shown; the rest are counted. */
export const SHOW_TOOLS = 4

const CLAMP = 2
const mineFolded   = (fold) => fold === 'mine' || fold === 'both'
const claudeFolded = (fold) => fold === 'claude' || fold === 'both'

/** `rows` cut to their first `CLAMP` with words when `on`, the last kept marked `…`, so a folded message says it holds more. */
function clamped(rows, on, w, mark) {
  if (!on) return rows
  const words = rows.filter((r) => (typeof r === 'string' ? r : r.text).trim())
  if (words.length <= CLAMP) return rows
  const kept = words.slice(0, CLAMP)
  kept[CLAMP - 1] = mark(kept[CLAMP - 1], w)
  return kept
}
const ellipsis = (text, w) => clip(text.trimEnd(), w - 2) + ' …'

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

const hhmm = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

const filled = (text, n) => text + ' '.repeat(Math.max(0, n - cells(text)))
/** A row of the owner's band: the gutter inside it, filled to the rail's space. */
const band = (text, w, ink, extra = {}) => ({ text: filled(clip(GUTTER + text, w - 2), w - 2), ink, ground: BUBBLE.ground, ...extra })
const row  = (text, ink) => ({ text: GUTTER + text, ink })

// Markdown is read for what a row can carry, one ink a row: a heading in its
// own ink, a fenced block in the code ink with its fences dropped, a bullet as
// `•` hanging its wrap, and the `**` round a word dropped, since a terminal
// row cannot bold half of itself.
const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
function prose(text, w) {
  const rows = []
  let fenced = false
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (fenced) { rows.push(...wrapped(line, w).map((t) => row(t, CODE))); continue }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { rows.push(...wrapped(plain(h[1]), w).map((t) => row(t, HEADING))); continue }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (b) { rows.push(...wrapped(plain(b[2]), w - b[1].length - 2).map((t, i) => row(`${b[1]}${i ? '  ' : '• '}${t}`))); continue }
    rows.push(...wrapped(plain(line), w).map((t) => row(t)))
  }
  return rows
}

/** A run of calls: the last `SHOW_TOOLS`, after a count of the rest and how many of them failed; folded, the count alone. */
function toolRows(run, w, folded) {
  if (folded) {
    const failed = run.filter((m) => m.failed).length
    const open = run.some((m) => !m.done)
    return [row(clip(`› ${run.length} call${run.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}${open ? ` · ${run.at(-1).line}` : ''}`, w), failed ? TONES.danger : open ? TONES.warn : TONES.muted)]
  }
  const hidden = run.slice(0, Math.max(0, run.length - SHOW_TOOLS))
  const failed = hidden.filter((m) => m.failed).length
  return [
    ...(hidden.length ? [row(clip(`⋯ ${hidden.length} earlier call${hidden.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`, w), failed ? TONES.danger : TONES.muted)] : []),
    ...run.slice(hidden.length).map((m) => { const [mark, ink] = MARK(m); return row(clip(`${mark} ${m.line}`, w), ink) }),
  ]
}

/** The rows of one message. `ink` undefined is the terminal's own. */
function rowsOfOne(m, w, n, fold) {
  const iw = inner(w)
  switch (m.kind) {
    case 'you':
      return [
        band(`you #${n}${m.at ? ` · ${hhmm(m.at)}` : ''}`, w, BUBBLE.nick, { you: n }),
        ...clamped(wrapped(m.text, iw), mineFolded(fold), iw, ellipsis).map((text) => band(text, w, BUBBLE.ink)),
        ...(m.images ? [band(`+ ${m.images} image${m.images > 1 ? 's' : ''}`, w, BUBBLE.old)] : []),
      ]
    case 'said':
      return clamped(prose(m.text, iw), claudeFolded(fold), iw, (r) => ({ ...r, text: GUTTER + ellipsis(r.text.slice(GUTTER.length), iw) }))
    case 'thought':
      return claudeFolded(fold) ? [] : [row(clip(`∴ ${m.text.trim().split('\n')[0]}`, iw), TONES.muted)]
    case 'turn':
      return m.error
        ? wrapped(`— ${m.error}`, iw).map((text) => row(text, TONES.danger))
        : [row(clip(`— ${secs(m.ms)} · $${m.cost.toFixed(3)}`, iw), TONES.muted)]
    case 'error':
      return wrapped(`! ${m.text}`, iw).map((text) => row(text, TONES.danger))
    default:
      return []
  }
}

/**
 * Every row of `messages` in a pane `w` cells wide, under `fold` (`tabs.js`'s `FOLDS`): a
 * blank row before each line sent but the first and after it, `● Claude` over
 * each reply, and a run of calls folded by `toolRows`. A line sent carries
 * `you`, its number, on its first row, which is what the rail marks and
 * Alt+↑ jumps to.
 */
export function rowsOf(messages, w, fold = 'none') {
  const rows = []
  let n = 0, open = false, run = []
  const flush = () => { if (run.length) rows.push(...toolRows(run, inner(w), claudeFolded(fold))); run = [] }
  for (const m of messages) {
    if (m.kind === 'tool') {
      if (!open) { rows.push(row('● Claude', CLAUDE)); open = true }
      run.push(m)
      continue
    }
    flush()
    if (m.kind === 'you') {
      if (rows.length) rows.push({ text: '' })
      rows.push(...rowsOfOne(m, w, ++n, fold), { text: '' })
      open = false
      continue
    }
    if (!open && m.kind !== 'turn' && m.kind !== 'error') { rows.push(row('● Claude', CLAUDE)); open = true }
    rows.push(...rowsOfOne(m, w, n, fold))
  }
  flush()
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

/**
 * The rail down the pane's right edge, as the workbench's notches are: one
 * glyph for each of the window's `room` rows, standing for its share of every
 * row — `•` where a line sent falls, `┃` the share in sight, `│` the rest.
 * Null when every row fits, since then there is nothing to place.
 */
export function railOf(rows, room, start) {
  const n = rows.length
  if (n <= room) return null
  const out = []
  for (let k = 0; k < room; k++) {
    const a = Math.floor(k * n / room)
    const b = Math.max(a + 1, Math.floor((k + 1) * n / room))
    const sent = rows.slice(a, b).some((r) => r.you)
    const seen = b > start && a < start + room
    out.push(sent ? { glyph: '•', ink: TONES.info } : seen ? { glyph: '┃', ink: TONES.muted } : { glyph: '│', ink: '#4b5563' })
  }
  return out
}

/**
 * The first row of the line sent after (`dir` 1) or before (-1) row `start`.
 * Past the last it is null, which follows the newest; before the first, 0.
 */
export function jumpOf(rows, start, dir) {
  const marks = rows.flatMap((r, i) => (r.you ? [i] : []))
  return dir < 0 ? marks.filter((i) => i < start).at(-1) ?? 0 : marks.find((i) => i > start) ?? null
}

// ─── the help ─────────────────────────────────────────────────────────────────

/**
 * `?`'s box (`tabs.js`'s `helpOf`): a frame the pane's width, each section's
 * title in the info ink and its rows as two columns, the left as wide as its
 * widest; a right column too long wraps under itself.
 */
export function helpRows(sections, w) {
  const iw = inner(w)
  const left = Math.max(...sections.flatMap((s) => s.rows.map(([k]) => cells(k))))
  const body = iw - 4
  const framed = (text, ink) => row(`│ ${filled(clip(text, body), body)} │`, ink)
  const out = [row(clip(`┌─ Study · ? or Esc closes ${'─'.repeat(iw)}`, iw - 1) + '┐', TONES.info)]
  for (const s of sections) {
    out.push(framed(''), framed(s.title, TONES.info))
    for (const [k, what] of s.rows) {
      wrapped(what, Math.max(8, body - left - 2)).forEach((t, i) => out.push(framed(`${i ? '' : k}${' '.repeat(Math.max(0, left - (i ? 0 : cells(k))))}  ${t}`)))
    }
  }
  out.push(framed(''), framed('The shell\'s own keys: ? in the scene', TONES.muted), row(`└${'─'.repeat(iw - 2)}┘`, TONES.info))
  return out
}

// ─── the permission panel (study.md 2.3) ──────────────────────────────────────

const WHERE = { localSettings: 'settings.local.json', projectSettings: 'settings.json', userSettings: '~/.claude/settings.json', session: 'this session' }

/** What `always` adds, one phrase per suggestion the CLI made. */
export function suggested(suggestions) {
  return suggestions.map((s) => {
    const where = WHERE[s.destination] ?? s.destination
    if (s.type === 'addRules') return `${s.rules.map((r) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ')} in ${where}`
    if (s.type === 'setMode') return `${s.mode} for ${where}`
    if (s.type === 'addDirectories') return `${s.directories.join(', ')} for ${where}`
    return `${s.type} for ${where}`
  }).join('; ')
}

/**
 * The panel over the input while prompt `ask` waits, `more` others behind it.
 * A command is shown whole, up to `most` rows: one approved off its first
 * line could run any line after it, so a cut one says so in red. A path is
 * wrapped rather than clipped, since its end is the file.
 */
export function askRows(ask, more, w, most = 6) {
  const call = wrapped(ask.tool === 'Bash' && ask.input.command ? `Bash ${ask.input.command}` : toolLine(ask.tool, ask.input), w - 2)
  const rows = call.slice(0, call.length > most ? most - 1 : most).map((text, i) => ({ text: `${i ? '  ' : '? '}${text}`, ink: TONES.warn }))
  if (call.length > most) rows.push({ text: `  … ${call.length - most + 1} more rows the pane cannot show`, ink: TONES.danger })
  if (ask.tool === 'Edit') {
    const first = (t) => String(t ?? '').split('\n')[0]
    rows.push({ text: clip(`  - ${first(ask.input.old_string)}`, w), ink: TONES.danger }, { text: clip(`  + ${first(ask.input.new_string)}`, w), ink: TONES.ok })
  }
  if (ask.description && !call.join(' ').includes(ask.description)) rows.push({ text: clip(`  ${ask.description}`, w), ink: TONES.muted })
  const always = ask.suggestions.length ? ` · 2 always: ${suggested(ask.suggestions)}` : ''
  rows.push(...wrapped(`1 allow${always} · 3 deny · or type why and Enter${more ? ` · ${more} more waiting` : ''}`, w - 2)
    .map((text) => ({ text: `  ${text}`, ink: TONES.info })))
  return rows
}

/** A read-along's ask (`IDEAS/study.md` 3.3): what it waits on, and where it is answered, since this pane cannot. */
export const waitRows = (why, w) => [
  ...wrapped(`? ${why}`, w).map((text, i) => ({ text: i ? `  ${text}` : text, ink: TONES.warn })),
  { text: clip('  answer it in its own terminal', w), ink: TONES.muted },
]
