/**
 * web/test/terminal.mjs — reading a terminal Haven is drawn in, for the
 * drives that put one in a room: `verify-explore.mjs` (two terminals) and
 * `verify-browser.mjs` (a terminal and a tab).
 *
 * Traps:
 * - The screen is a cell-diff patch, never a frame: `screen()` replays the
 *   cursor moves (example's `verify-tui.mjs` is where it was learned).
 * - A figure's cell is counted from the art's top-left, which sits at a
 *   different row in the shell (under its heading) and in `--frame` (top
 *   line), and the art is fogged, so `cellOf` finds the room's status line
 *   under it and counts up; a drive hands it the scene it is reading for
 *   the view's size.
 * - A screen draws the stage's VIEW, which follows that screen's own figure
 *   (`stage.js`), so a cell is read through the view that screen has: the
 *   drive's stage's own unless the drive says otherwise, and a drive that
 *   walks a figure past the edge keeps that terminal's view with `follow()`.
 * - The pty is util-linux `script`, which copies its stdin into the pty. A
 *   key written before the screen it is meant for has painted lands on the
 *   previous one, so a caller waits for what each key should produce.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '..')
export const TUI = join(WEB, '../node_modules/@frontierjs/sierra/src/tools/tui.js')

export const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return false
}

const GRAPHEMES = new Intl.Segmenter()
const oneGrapheme = (s) => { const it = GRAPHEMES.segment(s)[Symbol.iterator](); it.next(); return it.next().done }

/**
 * The screen after `stream`: cursor moves replayed, every other sequence
 * dropped. A grapheme takes the cells `Bun.stringWidth` gives it, as a
 * terminal does, and a code point that continues the one just drawn (a skin
 * tone, a ZWJ, a flag's second half) joins its cell; the second cell of a
 * wide one is `''`, so a row reads as a person sees it and is shorter, as a
 * string, than the cells it spans.
 */
export function screen(stream, rows = 30, cols = 100) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0, c = 0
  let last = null   // the cell of the grapheme just drawn, while the cursor stands right after it
  // A string sequence (OSC, DCS, APC) ends at BEL or at ESC \. Ended at BEL
  // alone, one closed by ESC \ swallowed the screen up to a later BEL, which
  // a focused input's cursor sequences send.
  const seq = /\x1b\[([0-9;?<>$ ]*)([a-zA-Z~])|\x1b[()][A-Z0-9]|\x1b[=>78]|\x1b[\]P_][^\x07\x1b]*(?:\x07|\x1b\\)/y
  for (let i = 0; i < stream.length;) {
    seq.lastIndex = i
    const m = seq.exec(stream)
    if (m) {
      if (m[2] === 'H') { const [y = 1, x = 1] = (m[1] || '1;1').split(';').map(Number); r = y - 1; c = x - 1; last = null }
      i = seq.lastIndex
      continue
    }
    const ch = String.fromCodePoint(stream.codePointAt(i))
    i += ch.length
    if (ch === '\r') { c = 0; last = null; continue }
    if (ch === '\n') { r++; last = null; continue }
    if (last && last.r === r && oneGrapheme(grid[r][last.c] + ch)) {
      const was = grid[r][last.c]
      const grow = Bun.stringWidth(was + ch) - Bun.stringWidth(was)
      grid[r][last.c] = was + ch
      for (let k = 0; k < grow; k++) if (c + k < cols) grid[r][c + k] = ''
      c += Math.max(0, grow)
      continue
    }
    const w = Math.max(1, Bun.stringWidth(ch))
    if (r < rows && c < cols) {
      if (grid[r][c] === '' && c > 0) grid[r][c - 1] = ' '
      if (grid[r][c + 1] === '' && w === 1) grid[r][c + 1] = ' '
      grid[r][c] = ch
      if (w === 2 && c + 1 < cols) grid[r][c + 1] = ''
      last = { r, c }
    }
    c += w
  }
  return grid.map((l) => l.join('').trimEnd()).join('\n')
}

/**
 * Where the art is on a frame `h` rows of it tall: `top` the line its first
 * row is drawn on, `left` its first column. Null with no room drawn.
 *
 * The art is fogged (`stage.js`, 6.3), so no row of it is sure to be drawn;
 * the room's status line is, at the art's left. A screen taller than the page
 * puts its spare rows between the art and that line (`fill` in `cell.js`), so
 * the art starts under the shell's header, or on the first line of a
 * `--frame`, which has none. A page taller than the screen has no spare and
 * scrolls the header off, and the art ends right above the status line.
 */
export function artOf(lines, h) {
  const status = lines.findIndex((l) => / · \d+ here\b/.test(l))
  if (status === -1) return null
  const header = lines.findIndex((l) => l.includes(' · Esc goes back'))
  return { top: Math.min(header + 1, status - h), left: lines[status].search(/\S/) }
}

/**
 * What is drawn on stage cells `x`..`x+width-1` of row `y` in a frame that
 * shows `view` of the stage — the drawn slice's own corner is the origin.
 * A cell outside the view is null, and so is a frame with no room on it. A
 * cell the frame leaves blank reads as a space, or as '' past the trimmed
 * end of its line.
 */
export function cellOf(frame, x, y, width = 1, stage, view = stage.view) {
  const lines = frame.split('\n')
  const art   = artOf(lines, view.h)
  if (!art) return null
  const col = x - view.x, row = y - view.y
  if (col < 0 || row < 0 || col >= view.w || row >= view.h) return null
  return (lines[art.top + row] ?? '').slice(art.left + col, art.left + col + width)
}

/** Whether `cellOf` read a cell the frame left blank — not one outside it. */
export const blank = (s) => s !== null && s.trim() === ''

/** The tty a process tree's leaf holds: the pty `script` made, which `stty -F` resizes. */
function ttyOf(pid) {
  for (let p = pid; p;) {
    const tty = (() => { try { return readlinkSync(`/proc/${p}/fd/0`) } catch { return '' } })()
    if (tty.startsWith('/dev/pts/') && p !== pid) return tty
    const kids = (() => { try { return readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/) } catch { return [] } })()
    p = Number(kids[kids.length - 1]) || 0
  }
  return null
}

/**
 * Sierra's interactive shell over Haven's routes, under a pty, signed in
 * with `token` the way `fli haven` hands one over. Answers the process, a
 * reader of its screen, and `exited`; `home` is the stage `at` reads by
 * default, and `env` is laid over this process's — a HOME of the
 * terminal's own, for one. The pty is 100×30, where the view is `VIEW`,
 * unless `size` says its own `{ cols, rows }`; `resize(cols, rows)` resizes
 * it as a window would, and the screen is read from what was drawn after.
 */
export function terminal(api, token, home, env = {}, size = { cols: 100, rows: 30 }) {
  const shell = spawn('script', ['-qfec', `stty rows ${size.rows} cols ${size.cols}; bun ${TUI} --api ${api}`, '/dev/null'], {
    cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env, HAVEN_TOKEN: token },
  })
  let out = ''
  let from = 0   // where the stream at this size begins
  let { cols, rows } = size
  shell.stdout.on('data', (d) => { out += d })
  const exited = new Promise((r) => shell.on('exit', (code) => r(code)))
  const now = () => screen(out.slice(from), rows, cols)
  return {
    shell,
    exited,
    screen: now,
    raw:    () => out,
    at:     (x, y, width, stage = home, view) => cellOf(now(), x, y, width, stage, view),
    write:  (k) => shell.stdin.write(k),
    // The kernel signals the pty's foreground process on the new size; the
    // stream before it is dropped, since `screen()` replays no clear.
    resize(c, r) {
      const tty = ttyOf(shell.pid)
      if (!tty) throw new Error('no pty under the shell to resize')
      execFileSync('stty', ['-F', tty, 'rows', String(r), 'cols', String(c)])
      ;({ cols, rows } = { cols: c, rows: r })
      from = out.length
    },
  }
}
