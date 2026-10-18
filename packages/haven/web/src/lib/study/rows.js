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
import { toolLine } from './session.js'

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
      return [
        ...wrapped(m.text, w - 2).map((text, i) => ({ text: `${i ? '  ' : '› '}${text}`, ink: TONES.info })),
        ...(m.images ? [{ text: clip(`  + ${m.images} image${m.images > 1 ? 's' : ''}`, w), ink: TONES.muted }] : []),
      ]
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
