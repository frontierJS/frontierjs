// ─── text.js — blocks and rows of terminal output ─────────────────────────────
import { chalk } from './color.js'

// A leaf beside color.js, whose tag `untag` reads. `lines` is handed to every
// command body as `echo.lines`; `wrap` keeps a long line inside a labeled column.

// false, null and undefined are dropped, so a row that only exists sometimes is
// written `started && dim(started)` instead of an if around echo. An empty
// string is a blank line, which is what a caller writing '' meant. `style`
// wraps the whole block, which is what lets a styled row sit inside it —
// color.js reopens the outer style.
export const lines = (rows, { indent = 0, style } = {}) => {
  const text = rows
    .filter(row => row !== false && row != null)
    .map(row => (row === '' ? '' : ' '.repeat(indent) + row))
    .join('\n')
  return style ? style(text) : text
}

// The arguments of a function that can also be a template tag, as the plain
// call's. Called as echo`a ${b}`, a function gets the literal parts as an array
// carrying `raw` and the values after it; that becomes the one string chalk's
// tag builds, so echo`{dim name} ${v}` styles its literal text and never a
// value. Any other call passes through as it came.
export const untag = (args) => {
  const [strings, ...values] = args
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) return args
  return [chalk(strings, ...values)]
}

// `3 ports`, `1 port`. A word whose plural is not an s is spelled out by the
// caller rather than taught here.
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// A color code, or either end of an OSC 8 link — none of them takes a column.
const SGR   = /\x1b\[[0-9;]*m|\x1b\]8;[^\x1b]*\x1b\\/g
const RESET = '\x1b[0m'

// An emoji takes two columns, and counting it as one put the break one past
// the edge, which the terminal then wrapped itself.
const columns = ch => (ch.codePointAt(0) >= 0x1f300 ? 2 : 1)

export const plain = s => String(s).replace(SGR, '')

export const visibleLength = s => [...plain(s)].reduce((n, ch) => n + columns(ch), 0)

/**
 * `text` as rows no wider than `width` columns, broken at the last space where
 * there is one. Escape codes take no width, and a style open at a break is
 * closed there and reopened on the next row, so a prefix printed in front of
 * each row neither inherits it nor ends it. No width (a pipe) is no wrap.
 */
export function wrap(text, width) {
  const s = String(text)
  if (!(width > 0) || visibleLength(s) <= width) return [s]

  const rows = []
  let row = '', count = 0, open = ''
  let cut = -1, cutOpen = '', cutCount = 0
  for (const [tok] of s.matchAll(/\x1b\[[0-9;]*m|\x1b\]8;[^\x1b]*\x1b\\|[\s\S]/gu)) {
    // A link end is not a style, and carrying it into `open` would reopen it
    // on every row after the break.
    if (tok.startsWith('\x1b]')) { row += tok; continue }
    if (tok[0] === '\x1b' && tok.length > 1) {
      row += tok
      open = /^\x1b\[0?m$/.test(tok) ? '' : open + tok
      continue
    }
    const w = columns(tok)
    if (count + w > width) {
      // The space that overflows is the break itself, and is dropped with it.
      if (tok === ' ') {
        rows.push(row + (open && RESET))
        row = open; count = 0; cut = -1
        continue
      }
      if (cut > 0) {
        rows.push(row.slice(0, cut) + (cutOpen && RESET))
        row   = cutOpen + row.slice(cut + 1)
        count = count - cutCount - 1
      } else {
        rows.push(row + (open && RESET))
        row   = open
        count = 0
      }
      cut = -1
    }
    if (tok === ' ') { cut = row.length; cutOpen = open; cutCount = count }
    row   += tok
    count += w
  }
  rows.push(row)
  return rows
}
