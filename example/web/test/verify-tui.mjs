/**
 * web/test/verify-tui.mjs — this app's routes in a terminal, `fli dev:tui`
 * (`FJS-D809`). Started by `bun run verify:tui`; needs no API, no Chrome and
 * no TTY of its own.
 *
 * Three runs of Sierra's shell (`@frontierjs/sierra/tui`) from `web/`:
 * `--list`, which says per route whether it lowers and names the first
 * blocker, run again over `fixtures/tui-imports/` for which import mounts a
 * file; `--frame` of `/reports/`, of `/plans/7/`, a route taking a param,
 * and of `/settings/`, whose theme radios are the app's theme block, painted;
 * and the interactive shell under a pty: `/reports/` opened, its
 * Orders link followed into `/orders/` and Esc walked back through both, a
 * typed `/plans/7/` opened and left with Esc;
 * `/people/`'s Drawer, the kit's modal `<dialog>`, opened over the page and
 * closed by Esc, which the dialog takes and the shell does not; and Ctrl+C,
 * which must exit 0 with the terminal given back.
 *
 * Traps:
 * - The API is pointed at a port nothing holds, so the frame is the same with
 *   or without `bun run api` up: `/reports/` is gated at a level an anonymous
 *   caller does not reach, and the page answers that from the schema without
 *   a request (Invariant 6's affordance half).
 * - The pty is util-linux `script`, which copies its stdin into the pty. A
 *   key written before the screen it is meant for has painted lands on the
 *   previous one, so each key waits for the text the last one should produce.
 * - Ctrl+C restoring the screen and the process exiting are two facts: the
 *   Junction socket's reconnect timers kept the process up after the first.
 */
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB  = join(HERE, '..')
const TUI  = join(HERE, '../../node_modules/@frontierjs/sierra/src/tools/tui.js')
const API  = 'http://localhost:7999'

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── --list ───────────────────────────────────────────────────────────

const list = spawnSync('bun', [TUI, '--list', '--api', API], { cwd: WEB, encoding: 'utf8' })
const rows = list.stdout.split('\n')
check(list.status === 0, '--list exits 0', list.stderr)
check(rows.some((l) => /^✓ \/reports\/\s*$/.test(l)), '/reports/ lowers', list.stdout)
check(rows.some((l) => /^✓ \/plans\/:id\/\s*$/.test(l)), 'a route taking a param lowers', list.stdout)
check(rows.some((l) => /^✗ \/\S*\s+\S.* at \S+\.mesa:\d+:\d+$/.test(l)),
  'a route that does not lower names its blocker by file and line', list.stdout)
check(/\d+ of \d+ routes lower for the terminal/.test(list.stdout), 'and a count closes it', list.stdout)

// ─── which import mounts ──────────────────────────────────────────────

// `fixtures/tui-imports/`, a root of its own because no file in this app
// pins it: Thing.mesa's markup refuses and its <script module> compiles
// (FJS-2182), `/` takes only its data, `/make/` mounts it, and `/deep/` takes
// only the data of Wrap.mesa, which mounts Thing -- a default that never runs.
const IMPORTS = join(HERE, 'fixtures/tui-imports')
const imports = spawnSync('bun', [TUI, '--list'], { cwd: IMPORTS, encoding: 'utf8' })
const irows = imports.stdout.split('\n')
check(irows.some((l) => /^✓ \/\s*$/.test(l)), 'a route taking only a refused file\'s data lowers', imports.stdout + imports.stderr)
check(irows.some((l) => /^✗ \/make\/\s+<iframe> at src\/resources\/Thing\.mesa:4:1$/.test(l)),
  'a route mounting it is refused for it', imports.stdout)
check(irows.some((l) => /^✓ \/deep\/\s*$/.test(l)), 'and a file taken for its data mounts nothing it imports', imports.stdout)
const deep = spawnSync('bun', [TUI, '--frame', '/deep/'], { cwd: IMPORTS, encoding: 'utf8' })
check(deep.status === 0 && deep.stdout.includes('Wraps: 3'), 'which loads and paints', deep.stdout + deep.stderr)

// ─── --frame ──────────────────────────────────────────────────────────

const frame = spawnSync('bun', [TUI, '--frame', '/reports/', '--api', API], { cwd: WEB, encoding: 'utf8' })
check(frame.status === 0, '--frame exits 0', frame.stderr)
check(/^Reports\s*$/m.test(frame.stdout), 'the frame has the page heading', frame.stdout)
check(frame.stdout.includes('Revenue is administrator-only'), 'and the gate refusal, drawn without a request', frame.stdout)

const param = spawnSync('bun', [TUI, '--frame', '/plans/7/', '--api', API], { cwd: WEB, encoding: 'utf8' })
check(param.status === 0 && /^Plans\s*$/m.test(param.stdout), '--frame opens a route by a path that fills its param', param.stdout + param.stderr)

// The app's theme block reaches the terminal: six themes offered, the default
// checked, and the footer naming it (FJS-2565). Each is a tile, so a border
// stands between two (FJS-D1423).
const settings = spawnSync('bun', [TUI, '--frame', '/settings/', '--api', API], { cwd: WEB, encoding: 'utf8' })
check(/\(•\) default[\s│]+\( \) dark[\s│]+\( \) forest[\s│]+\( \) midnight[\s│]+\( \) sunset[\s│]+\( \) elite/.test(settings.stdout),
  "/settings/ offers the app's six themes with its default checked", settings.stdout + settings.stderr)
check(settings.stdout.includes('theme theme-default ·'), 'and its footer names the resolved theme', settings.stdout)

// ─── interactive ──────────────────────────────────────────────────────

/**
 * The screen a person would see after `stream`: the renderer moves the
 * cursor with `ESC[row;colH` and writes only the cells that changed, so the
 * stream's text is a patch over the last frame and never a frame itself.
 * Every other sequence moves nothing it paints. An OSC or DCS ends at BEL or at
 * ESC \, and read to BEL alone, one ended by ESC \ swallows every frame up to
 * the next BEL — the cursor color a focused field sets.
 */
function screen(stream, rows = 30, cols = 100) {
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
  return grid.map((l) => l.join('').trimEnd()).join('\n')
}
const seen = (text) => screen(out).includes(text)

const plain = (s) => s.replace(/\x1b\[[0-9;?<>$ ]*[a-zA-Z~]|\x1b[()][A-Z0-9]|\x1b[=>78]|\x1b[\]P_][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

const shell = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI} --api ${API}`, '/dev/null'], {
  cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'],
})
let out = ''
shell.stdout.on('data', (d) => { out += d })
const exited = new Promise((r) => shell.on('exit', (code) => r(code)))

const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return false
}

check(await until(() => plain(out).includes('/reports/')), 'the shell lists the route', plain(out).slice(-500))
// `?` lists the keys the shell takes here, read from its keymaps: on the list
// there is nothing to go back from, so Esc is not one of them.
const keyRow = (keys, action) => new RegExp(`(^|\\s)${keys.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${action}(\\s|$)`, 'm')
shell.stdin.write('?')
check(await until(() => seen('Keys here') && keyRow('j', 'down').test(screen(out)) && keyRow('<C-p>', 'jump').test(screen(out))),
  '? lists the keys, each read from a keymap', screen(out))
check(keyRow('?', 'help').test(screen(out)) && !keyRow('<Esc>', 'back').test(screen(out)), 'and on the list, no back', screen(out))
shell.stdin.write('?')
check(await until(() => !seen('Keys here')), 'a second ? closes it', screen(out))
shell.stdin.write('\x10')
check(await until(() => seen('Jump to a route')), 'Ctrl+P opens the jump', screen(out))
shell.stdin.write('\x1b')
check(await until(() => !seen('Jump to a route') && seen('j/k moves, Enter opens')), 'and Esc closes it on the list', screen(out))
let mark = out.length
// The shell has a button per route `--list` marks that takes no param, in its
// order, with the first focused, and the path field after them; a move paints
// no text, so the moves go together. j moves as Tab does, and k back again.
const buttons = rows.filter((l) => l.startsWith('✓ ') && !l.includes(':')).map((l) => l.slice(2).trim())
shell.stdin.write('j'.repeat(Math.max(0, buttons.indexOf('/reports/')) + 1) + 'k\r')
check(await until(() => seen('administrator-only')), 'Enter opens it', screen(out))
shell.stdin.write('?')
check(await until(() => seen('Keys here') && keyRow('<Esc>', 'back').test(screen(out))), 'on a route ? lists Esc going back', screen(out))
shell.stdin.write('\x1b')
check(await until(() => !seen('Keys here')), 'and Esc closes the list', screen(out))
check(seen('administrator-only') && seen('/reports/ · Esc goes back'), 'without leaving the route', screen(out))
mark = out.length
// The heading's Orders link is the route's first focus. /orders/ holds the
// kit's DatePicker, whose days listen to mouseenter.
shell.stdin.write('\r')
check(await until(() => seen('/orders/ · Esc goes back') && seen('Last 7 days')),
  'a link is followed into the router and the route it names opens', screen(out))
// /orders/ is taller than the screen: its lines keep a row each rather than
// being pressed into 30 and painted over one another (FJS-2487), and Tab past
// the bottom edge scrolls the control it reaches into view. The error line
// waits on the refused fetch, which lands after the route has painted.
check(await until(() => seen('Unable to connect.') && seen('Placed between')), 'a route taller than the screen paints each line whole', screen(out))
for (let i = 0; i < 60 && !seen('[ 28 ]'); i++) {
  shell.stdin.write('\t')
  await new Promise((r) => setTimeout(r, 60))
}
check(await until(() => seen('[ 28 ]'), 2000), 'Tab past the bottom edge brings the control it reaches on screen', screen(out))
// The DatePicker's month is a table, so a week is a row and a day sits under
// its weekday (FJS-2488). The 14th is in a full week in every month. The
// picker sits in a card, whose border opens each line (FJS-D1423).
{
  const lines = screen(out).split('\n')
  const week = lines.find((l) => l.includes('[ 14 ]')) ?? ''
  const head = lines.find((l) => /^│?\s*Su\s+Mo\s+Tu\s+We\s+Th\s+Fr\s+Sa\b/.test(l.trim())) ?? ''
  const at = (l, re) => [...l.matchAll(re)].map((m) => m.index)
  const days = at(week, /\[ \d+ \]/g)
  check(days.length === 7 && String(days) === String(at(head, /\b(Su|Mo|Tu|We|Th|Fr|Sa)\b/g)),
    'the date picker lays a week on one row, each day under its weekday', screen(out))
}
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('/reports/ · Esc goes back')), 'Esc goes back to the route the link was on', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'and a second Esc comes back to the list', screen(out))
mark = out.length
shell.stdin.write('\t'.repeat(buttons.length))
check(await until(() => seen('INSERT')), 'the path field is INSERT the moment focus lands on it', screen(out))
shell.stdin.write('/plans/7')
await until(() => seen('/plans/7'))
// Esc out of INSERT leaves the list up, and in NORMAL a letter types nothing
// until i. The keys wait apart: Esc then a letter at once reads as Alt+letter.
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('i types')), 'Esc on the field is NORMAL', screen(out))
await new Promise((r) => setTimeout(r, 100))
shell.stdin.write('xx')
await new Promise((r) => setTimeout(r, 300))
mark = out.length
shell.stdin.write('i')
check(await until(() => seen('INSERT')), 'and i is INSERT again', screen(out))
shell.stdin.write('/')
check(await until(() => seen('/plans/7/')) && !plain(out).includes('/plans/7x'), 'with nothing NORMAL was handed in the field', screen(out))
mark = out.length
shell.stdin.write('\r')
check(await until(() => seen('/plans/7/ · Esc goes back')), 'a typed path opens a route that takes a param', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'and Esc comes back to the list', screen(out))
mark = out.length
// The route's first focus is its Pay runs link, so one Tab reaches New
// employee. The Drawer is a modal <dialog>: drawn in a border over the page,
// its form's first field focused, and Esc closes it without leaving the route.
shell.stdin.write('\t'.repeat(Math.max(0, buttons.indexOf('/people/'))) + '\r')
check(await until(() => seen('/people/ · Esc goes back') && seen('[ New employee ]')), '/people/ opens', screen(out))
shell.stdin.write('\t')
await new Promise((r) => setTimeout(r, 300))
shell.stdin.write('\r')
check(await until(() => /│ New employee +│/.test(screen(out)) && /│ \[ Save \] \[ Cancel \] +│/.test(screen(out))),
  'its Drawer opens in a border over the page', screen(out))
check(/│ \[ Close \] +│/.test(screen(out)), 'and its icon-only close button paints its aria-label', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => !/│ New employee/.test(screen(out))), 'Esc closes the Drawer', screen(out))
check(seen('/people/ · Esc goes back') && seen('[ New employee ]'), 'and leaves the route open', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'a second Esc comes back to the list', screen(out))
mark = out.length
shell.stdin.write('\x03')
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
check(out.slice(mark).includes('\x1b[?1049l'), 'and gives the terminal back')
if (code === 'timeout') shell.kill('SIGKILL')

// ─── a link that lands, and Esc back through it ───────────────────────

// `/` of the fixture root links to `deep/`, relative, so the link is resolved
// against the route it is on; Esc then walks the router's History back to `/`
// before it leaves for the list.
const walk = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI}`, '/dev/null'], {
  cwd: IMPORTS, stdio: ['pipe', 'pipe', 'inherit'],
})
out = ''
mark = 0
walk.stdout.on('data', (d) => { out += d })
const walked = new Promise((r) => walk.on('exit', (c) => r(c)))
check(await until(() => seen('j/k moves, Enter opens')), 'the fixture shell lists its routes', screen(out))
mark = out.length
walk.stdin.write('\r')
check(await until(() => seen('Things: 2')), '/ opens', screen(out))
mark = out.length
walk.stdin.write('\r')
check(await until(() => seen('/deep/ · Esc goes back') && seen('Wraps: 3')), 'its link lands on the route it names', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('Things: 2')), 'Esc goes back through the History', screen(out))
mark = out.length
// Its second link names /make/, which mounts Thing and does not lower.
walk.stdin.write('\t')
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\r')
check(await until(() => seen('/make/ does not lower:')),
  'a link to a route that does not lower is refused by the router, which says why', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'and from its first entry to the list', screen(out))

// `/confirm/` mounts the kit's ConfirmationPopover, which no route of the app
// opens without rows from an API. Its panel is a `<mesa:portal>` and paints
// under its trigger; the Esc it takes closes it and leaves the route open.
const fixtureButtons = irows.filter((l) => l.startsWith('✓ ') && !l.includes(':')).map((l) => l.slice(2).trim())
mark = out.length
walk.stdin.write('\t'.repeat(Math.max(0, fixtureButtons.indexOf('/confirm/'))) + '\r')
check(await until(() => seen('/confirm/ · Esc goes back') && seen('Cancels: 0') && seen('[ Ask ]')), '/confirm/ opens', screen(out))
mark = out.length
walk.stdin.write('\r')
check(await until(() => /\[ Ask \][\s\S]*Remove it\?[\s\S]*\[ Cancel \][\s\S]*\[ Remove \]/.test(screen(out))),
  'the confirmation, a portal, paints under its trigger', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('Cancels: 1') && !seen('Remove it?')), 'Esc cancels it', screen(out))
check(seen('/confirm/ · Esc goes back'), 'and leaves the route open, since the panel took the key', screen(out))
// Focus went back to the trigger: Enter opens the panel again. With nothing
// holding focus it would press nothing.
mark = out.length
walk.stdin.write('\r')
check(await until(() => seen('Remove it?')), 'after Esc focus is back on the trigger, which Enter presses again', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('Cancels: 2') && !seen('Remove it?')), 'and Esc cancels that one too', screen(out))

// The kit's DropdownMenu on the same route: Tab from the trigger reaches the
// menu's, Enter opens it, ArrowDown walks the rows by registration (a terminal
// node has no querySelector) and Enter chooses one.
await new Promise((r) => setTimeout(r, 300))
mark = out.length
// The trigger's wrapper listens to `click`, so it is a stop of its own before
// the button inside it.
walk.stdin.write('\t')
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\t')
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\r')
check(await until(() => seen('Edit') && seen('Delete')), 'the menu opens under its trigger', screen(out))
mark = out.length
walk.stdin.write('\x1b[B')
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\x1b[B')
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\r')
check(await until(() => seen('Chose: delete') && !seen('Edit')), 'ArrowDown twice reaches the second row, Enter chooses it and the menu closes', screen(out))
mark = out.length
walk.stdin.write('\r')
check(await until(() => seen('Edit') && seen('Delete')), 'the close put focus back on the trigger, which Enter opens again', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => !seen('Edit')), 'Esc closes the menu', screen(out))
check(seen('/confirm/ · Esc goes back'), 'and leaves the route open', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'a second Esc leaves the route', screen(out))
// A route whose only control paints after it mounts has nothing to focus when
// shell.js looks (FJS-3165): the mode line said the last route's INSERT, and
// Enter pressed nothing until a Tab.
mark = out.length
walk.stdin.write('\t'.repeat(Math.max(0, fixtureButtons.indexOf('/late/'))) + '\r')
check(await until(() => seen('/late/ · Esc goes back') && seen('[ Late ]')), '/late/ opens and paints its control after the mount', screen(out))
await new Promise((r) => setTimeout(r, 300))
walk.stdin.write('\r')
check(await until(() => seen('Pressed: 1')), 'Enter presses a control that painted after the mount, with no Tab first', screen(out))
mark = out.length
walk.stdin.write('\x1b')
check(await until(() => seen('j/k moves, Enter opens')), 'and Esc leaves the route', screen(out))
walk.stdin.write('\x03')
const walkCode = await Promise.race([walked, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
if (walkCode === 'timeout') walk.kill('SIGKILL')

console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
