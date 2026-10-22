/*
 * test/browser/console.mjs — one `fli gui`, two frames: Chrome over CDP and a
 * pty, asked whether they show the same rows (`IDEAS/one-console.md` 1.3).
 * Then the keys (2.3): the legend, a `/` filter, each pane after `:run`
 * reached by its digit, and `:` back — asked of both frames the same way.
 * `:map` (2.4) is the last digit, and its issues are counted in both.
 *
 * `Console.mesa` is one file compiled for two targets, and the claim the console
 * rests on is that a person at either sees the same thing. Nothing else asks
 * it: the browser drive beside this one reads the old page, and a unit test
 * over `/api/runnables` passes with either frame drawing nothing. So the drive
 * starts `fli gui` under a pty, the way a person does, then opens THAT
 * process's `/console/` in Chrome, and diffs the two row by row: group, count,
 * name, state word, command and the actions offered.
 *
 * Traps:
 * - The pty is util-linux `script`, as `example`'s `verify:tui` uses. It is
 *   opened tall enough for every row, since a row scrolled off the bottom is
 *   not on the screen to compare. The renderer writes only the cells that
 *   changed, so a frame is the stream replayed onto a grid, never the stream.
 * - Each frame polls `/api/state` on its own clock, so a process that starts
 *   or stops between the two reads is a real difference neither frame is
 *   wrong about. The diff is asked again after a poll before it fails.
 * - Both frames are empty when either read fails, and two empty frames agree.
 *   So the row count is held to `/api/runnables`' before any diff is trusted.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI  = resolve(HERE, '../..')
const REPO = resolve(CLI, '../..')
const FLI  = resolve(CLI, 'bin/fli.js')

// The test tier's tooling slot beside `test:browser`'s 7500, so the two
// drives and a `fli gui` somebody has open on their dev slot never meet.
const PORT   = Number(process.env.FLI_CONSOLE_TEST_PORT ?? 7501)
const origin = `http://localhost:${PORT}`
const ROWS = 400, COLS = 160

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await sleep(100) }
  return false
}
const answers = () => fetch(`${origin}/api/state`).then(() => true, () => false)

if (await answers()) {
  console.error(`${origin} already answers — this drive starts the console it tests; FLI_CONSOLE_TEST_PORT picks another`)
  process.exit(2)
}

/** The grid a person would see after `stream`, as `verify-tui.mjs` replays it. */
function screen(stream, rows = ROWS, cols = COLS) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0, c = 0
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
  return grid.map((l) => l.join('').trimEnd())
}

const squash = (s) => s.replace(/\s+/g, ' ').trim()
// A button is `[ start ]` in the terminal and `start` in the browser.
const actionsOf = (s) => squash(s.replace(/[[\]]/g, ' '))

/** The terminal frame as groups of rows. A group opens on its `title count`
 *  line; its table header names where each column starts. A cell wider than
 *  its column wraps onto the next line, whose name cell is blank, so that line
 *  continues the row above rather than starting one. */
function terminalFrame(lines) {
  const groups = []
  let g = null, cols = null
  for (const line of lines.map((l) => l.replace(/[▀▄█▐▌]+$/, '').trimEnd())) {
    const head = line.match(/^(\S+) (\d+)$/)
    if (head) { g = { kind: head[1], count: Number(head[2]), rows: [] }; groups.push(g); cols = null; continue }
    if (!g || isLegend(line)) continue
    if (/^Name\s+State\s+Command\s+Actions$/.test(line)) {
      cols = ['State', 'Command', 'Actions'].map((w) => line.indexOf(w))
      continue
    }
    if (!cols || !line.trim()) continue
    const cells = {
      name:    squash(line.slice(0, cols[0])),
      state:   squash(line.slice(cols[0], cols[1])),
      command: squash(line.slice(cols[1], cols[2])),
      actions: actionsOf(line.slice(cols[2])),
    }
    const last = g.rows.at(-1)
    if (!cells.name && last) for (const f in cells) last[f] = squash(`${last[f]} ${cells[f]}`)
    else g.rows.push(cells)
  }
  return groups
}

// The browser frame, read off the same markup the terminal painted.
const BROWSER_FRAME = `
  const squash = (s) => s.replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('section[data-kind]')].map(s => {
    const bar = s.querySelector('.bar');
    return {
      kind:  squash(bar.querySelector('strong').textContent),
      count: Number(bar.querySelector('span').textContent),
      rows:  [...s.querySelectorAll('tr[data-id]')].map(tr => {
        const td = tr.querySelectorAll('td');
        return {
          name:    squash(td[0].textContent),
          state:   squash(td[1].textContent),
          command: squash(td[2].textContent),
          actions: [...td[3].querySelectorAll('button, a')].map(b => squash(b.textContent)).join(' '),
        };
      }),
    };
  });
`

/** Every line on which the two frames differ, as `kind/row: field a ≠ b`.
 *  A wrap may fall inside a word or at a space, so a cell is compared with
 *  its whitespace taken out. */
const same = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '')
function diff(term, web) {
  const out = []
  const kinds = (gs) => gs.map((g) => `${g.kind} ${g.count}`).join(', ')
  if (kinds(term) !== kinds(web)) out.push(`groups: terminal [${kinds(term)}] ≠ browser [${kinds(web)}]`)
  for (const w of web) {
    const t = term.find((g) => g.kind === w.kind)
    if (!t) continue
    const n = Math.max(t.rows.length, w.rows.length)
    for (let i = 0; i < n; i++) {
      const a = t.rows[i], b = w.rows[i]
      if (!a || !b) { out.push(`${w.kind}/${i}: ${a ? 'only the terminal' : 'only the browser'} has ${JSON.stringify(a ?? b)}`); continue }
      for (const f of ['name', 'state', 'command', 'actions'])
        if (!same(a[f], b[f])) out.push(`${w.kind}/${a.name}: ${f} ${JSON.stringify(a[f])} ≠ ${JSON.stringify(b[f])}`)
    }
  }
  return out
}

// Each pane after `:run`, in strip order, reached by its digit. Read off the
// line that heads the pane's first list.
const firstNumber = (s) => s.match(/\d+/)?.[0] ?? null
const PANES = [
  ['check',  '2', ['findings']],
  ['decide', '3', ['decisions']],
  ['ship',   '4', ['release', 'publish']],
  ['map',    '5', ['issues']],
]

// The legend is the footer's last line in the terminal and `[data-legend]` in
// the browser, compared as text with a key's bracket and spacing taken out.
const legendOf = (s) => squash(s.replace(/[[\]]/g, ' '))
const isLegend   = (l) => /: go to a pane|^\s*<CR> /.test(l)
const termLegend = () => legendOf(screen(out).filter(isLegend).at(-1) ?? '')
const webLegend  = () => browser.evaluate(`return document.querySelector('[data-legend]')?.textContent ?? ''`).then(legendOf)
async function legendsAgree(label, expect) {
  let t = '', w = ''
  const agree = async () => { t = termLegend(); w = await webLegend(); return same(t, w) && expect.every((e) => w.includes(e)) }
  check(await until(agree, 10000), `${label} — both frames show the same legend`, `terminal ${JSON.stringify(t)}\nbrowser  ${JSON.stringify(w)}`)
}

// A key at both frames: the pty takes bytes, Chrome a real key event.
const BYTES = { Enter: '\r', Escape: '\x1b' }
async function press(k) {
  pty.stdin.write(BYTES[k] ?? k)
  await (k.length === 1 ? browser.type(k) : browser.press(k))
  await sleep(150)
}

// ─── the terminal frame: `fli gui` under a pty ────────────────────────

const pty = spawn('script', ['-qfec', `stty rows ${ROWS} cols ${COLS}; bun ${FLI} gui --port ${PORT}`, '/dev/null'], {
  cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TERM: 'xterm-256color' },
})
let out = ''
pty.stdout.on('data', (d) => { out += d })
const exited = new Promise((r) => pty.on('exit', (code) => r(code)))
let browser = null

try {
  check(await until(answers), `fli gui at a terminal starts its server on :${PORT}`, out.slice(-500))
  const { rows: inventory } = await fetch(`${origin}/api/runnables`).then((r) => r.json())
  check(inventory.length > 10, `the workspace has rows to compare (${inventory.length})`)

  const painted = () => terminalFrame(screen(out)).reduce((n, g) => n + g.rows.length, 0) === inventory.length
    && screen(out).some((l) => l.startsWith('What can run here') && l.includes('state at'))
  check(await until(painted), 'the terminal paints every row, with a state read', screen(out).join('\n'))

  // ─── the browser frame: the same process's /console/ ────────────────

  browser = await openChrome({ windowSize: '1400,900' })
  await browser.navigate(`${origin}/console/`,
    `document.querySelectorAll('tr[data-id]').length === ${inventory.length} && document.querySelector('[data-at]')?.textContent.startsWith('state at')`)
  check(true, 'Chrome paints /console/ from the same server, every row and a state read')

  // ─── the two agree ─────────────────────────────────────────────────

  let differences = []
  for (let attempt = 0; attempt < 4; attempt++) {
    const web  = await browser.evaluate(BROWSER_FRAME)
    const term = terminalFrame(screen(out))
    differences = diff(term, web)
    if (!differences.length) {
      const counted = web.every((g) => g.count === g.rows.length) && term.every((g) => g.count === g.rows.length)
      check(counted, 'each group\'s count is the rows under it, in both frames')
      break
    }
    await sleep(3500)
  }
  check(!differences.length, 'the terminal and the browser show the same rows — group, name, state, command, actions',
    differences.slice(0, 20).join('\n') + (differences.length > 20 ? `\n… and ${differences.length - 20} more` : ''))

  // ─── the keys: the legend, then a filter typed into both ───────────

  await legendsAgree(':run', ['1 :run', ': go to a pane', '/ filter', 'r read again'])

  const TERM = 'drive'
  for (const k of ['/', ...TERM, 'Enter']) await press(k)
  const total = (gs) => gs.reduce((n, g) => n + g.rows.length, 0)
  let narrowed = []
  const filtered = async () => {
    const web = await browser.evaluate(BROWSER_FRAME)
    narrowed = diff(terminalFrame(screen(out)), web)
    return total(web) > 0 && total(web) < inventory.length && !narrowed.length
  }
  check(await until(filtered, 10000), `/${TERM} narrows both frames to the same rows`, narrowed.slice(0, 10).join('\n'))
  await legendsAgree('filtered', ['<Esc> clear the filter', `filtered by /${TERM}`])
  await press('Escape')
  check(await until(async () => (await browser.evaluate(BROWSER_FRAME)).reduce((n, g) => n + g.rows.length, 0) === inventory.length
    && total(terminalFrame(screen(out))) === inventory.length, 10000), 'Esc clears the filter in both frames')

  // ─── the other panes: the count each one heads its list with ───────

  for (const [pane, digit, parts] of PANES) {
    await press(digit)
    for (const part of parts) {
      await browser.waitFor(`/\\d/.test(document.querySelector('[data-part="${part}"] .bar span')?.textContent ?? '')`, { ms: 120000 })
      const web = squash(await browser.evaluate(`return document.querySelector('[data-part="${part}"] .bar span').textContent`))
      // No space is promised after the title: the terminal paints no flex gap.
      const line = () => screen(out).find((l) => l.startsWith(part) && /^\s*\d/.test(l.slice(part.length)))
      check(await until(line, 120000), `:${pane} paints its ${part} in the terminal`, screen(out).slice(0, 40).join('\n'))
      const term = squash(line()?.slice(part.length) ?? '')
      check(firstNumber(term) !== null && firstNumber(term) === firstNumber(web), `:${pane} — both frames count the same ${part} (${firstNumber(web)})`, `terminal ${JSON.stringify(term)} ≠ browser ${JSON.stringify(web)}`)
    }
    await legendsAgree(`:${pane}`, ['1 :run', pane === 'check' ? 'r check again' : 'r read again'])
  }

  // `:` and a unique prefix, back to the first pane.
  for (const k of [':', 'r', 'u', 'Enter']) await press(k)
  check(await until(painted, 20000), ':ru goes back to :run in the terminal', screen(out).slice(0, 3).join('\n') + `\nlegend: ${termLegend()}`)
  check(await until(async () => await browser.evaluate(`return document.querySelectorAll('tr[data-id]').length`) === inventory.length, 20000),
    ':ru goes back to :run in the browser', await webLegend())
  check(!browser.errors.length, 'the browser page raised no error', browser.errors.join('\n'))
} catch (e) {
  check(false, 'the drive ran to the end', e.stack ?? String(e))
} finally {
  await browser?.close()
}

// ─── Ctrl+C stops both ────────────────────────────────────────────────

pty.stdin.write('\x03')
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
check(!(await answers()), `and :${PORT} is free after it`)
if (code === 'timeout') pty.kill('SIGKILL')

console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
