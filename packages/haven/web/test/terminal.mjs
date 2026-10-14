/**
 * web/test/terminal.mjs — reading a terminal Haven is drawn in, for the
 * drives that put one in a room: `verify-explore.mjs` (two terminals) and
 * `verify-browser.mjs` (a terminal and a tab).
 *
 * Traps:
 * - The screen is a cell-diff patch, never a frame: `screen()` replays the
 *   cursor moves (example's `verify-tui.mjs` is where it was learned).
 * - A figure's cell is counted from the picture's top-left, which sits at a
 *   different row in the shell (under its heading) and in `--frame` (top
 *   line). `cellOf` finds the corner first, from the stage's own picture
 *   (`stage.mjs`), so a drive hands it the scene it is reading.
 * - A screen draws the stage's VIEW, which follows that screen's own figure
 *   (`stage.js`), so a cell is read through the view that screen has: the
 *   drive's stage's own unless the drive says otherwise, and a drive that
 *   walks a figure past the edge keeps that terminal's view with `follow()`.
 * - The pty is util-linux `script`, which copies its stdin into the pty. A
 *   key written before the screen it is meant for has painted lands on the
 *   previous one, so a caller waits for what each key should produce.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '..')
export const TUI = join(WEB, '../node_modules/@frontierjs/sierra/src/tools/tui.js')

export const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return false
}

/** The screen after `stream`: cursor moves replayed, every other sequence dropped. */
export function screen(stream, rows = 30, cols = 100) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0, c = 0
  // A string sequence (OSC, DCS, APC) ends at BEL or at ESC \. Ended at BEL
  // alone, one closed by ESC \ swallowed the screen up to a later BEL, which
  // a focused input's cursor sequences send.
  const seq = /\x1b\[([0-9;?<>$ ]*)([a-zA-Z~])|\x1b[()][A-Z0-9]|\x1b[=>78]|\x1b[\]P_][^\x07\x1b]*(?:\x07|\x1b\\)/y
  for (let i = 0; i < stream.length;) {
    seq.lastIndex = i
    const m = seq.exec(stream)
    if (m) {
      if (m[2] === 'H') { const [y = 1, x = 1] = (m[1] || '1;1').split(';').map(Number); r = y - 1; c = x - 1 }
      i = seq.lastIndex
      continue
    }
    const ch = String.fromCodePoint(stream.codePointAt(i))
    i += ch.length
    if (ch === '\r') { c = 0; continue }
    if (ch === '\n') { r++; continue }
    if (r < rows && c < cols) grid[r][c] = ch
    c++
  }
  return grid.map((l) => l.join('').trimEnd()).join('\n')
}

/**
 * What is drawn on stage cells `x`..`x+width-1` of row `y` in a frame that
 * shows `view` of the stage — the drawn slice's own corner is the origin.
 * A cell outside the view is null.
 */
export function cellOf(frame, x, y, width = 1, stage, view = stage.view) {
  const corner = stage.picture()[view.y].slice(view.x, view.x + view.w).trimEnd()
  const lines = frame.split('\n')
  const mark = corner.trim()
  const top = lines.findIndex((l) => l.includes(mark))
  if (top === -1) return null
  const col = x - view.x, row = y - view.y
  if (col < 0 || row < 0 || col >= view.w || row >= view.h) return null
  const left = lines[top].indexOf(mark) - corner.indexOf(mark)
  return (lines[top + row] ?? '').slice(left + col, left + col + width)
}

/**
 * Sierra's interactive shell over Haven's routes, under a pty, signed in
 * with `token` the way `fli haven` hands one over. Answers the process, a
 * reader of its screen, and `exited`; `home` is the stage `at` reads by
 * default.
 */
export function terminal(api, token, home) {
  const shell = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI} --api ${api}`, '/dev/null'], {
    cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HAVEN_TOKEN: token },
  })
  let out = ''
  shell.stdout.on('data', (d) => { out += d })
  const exited = new Promise((r) => shell.on('exit', (code) => r(code)))
  return {
    shell,
    exited,
    screen: () => screen(out),
    at:     (x, y, width, stage = home, view) => cellOf(screen(out), x, y, width, stage, view),
  }
}
