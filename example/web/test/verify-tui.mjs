/**
 * web/test/verify-tui.mjs — this app's routes in a terminal, `fli dev:tui`
 * (`FJS-D809`). Started by `bun run verify:tui`; needs no API, no Chrome and
 * no TTY of its own.
 *
 * Three runs of Sierra's shell (`@frontierjs/sierra/tui`) from `web/`:
 * `--list`, which says per route whether it lowers and names the first
 * blocker, run again over `fixtures/tui-imports/` for which import mounts a
 * file; `--frame` of `/reports/` and of `/plans/7/`, a route taking a param,
 * painted; and the interactive shell under a pty: `/reports/` opened, its
 * Orders link followed into the router and refused with the reason that
 * route does not lower, a typed `/plans/7/` opened, each left with Esc, and
 * Ctrl+C, which must exit 0 with the terminal given back.
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
check(rows.some((l) => /^✗ \/plans\/\s+\S.* at \S+\.mesa:\d+:\d+$/.test(l)),
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
check(irows.some((l) => /^✗ \/make\/\s+<svg> at src\/resources\/Thing\.mesa:4:1$/.test(l)),
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

// ─── interactive ──────────────────────────────────────────────────────

/**
 * The screen a person would see after `stream`: the renderer moves the
 * cursor with `ESC[row;colH` and writes only the cells that changed, so the
 * stream's text is a patch over the last frame and never a frame itself.
 * Every other sequence moves nothing it paints.
 */
function screen(stream, rows = 30, cols = 100) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0, c = 0
  const seq = /\x1b\[([0-9;?<>]*)([a-zA-Z~])|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07/y
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

const plain = (s) => s.replace(/\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07/g, '')

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
let mark = out.length
// The shell has a button per route `--list` marks that takes no param, in its
// order, with the first focused, and the path field after them; a Tab paints
// no text, so the moves go together.
const buttons = rows.filter((l) => l.startsWith('✓ ') && !l.includes(':')).map((l) => l.slice(2).trim())
shell.stdin.write('\t'.repeat(Math.max(0, buttons.indexOf('/reports/'))) + '\r')
check(await until(() => plain(out.slice(mark)).includes('administrator-only')), 'Enter opens it', plain(out.slice(mark)).slice(-500))
mark = out.length
// The heading's Orders link is the route's first focus; /orders/ does not lower.
shell.stdin.write('\r')
check(await until(() => seen('/orders/ does not lower:')),
  'a link is followed into the router, which refuses a route that does not lower and says why', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('Tab moves, Enter opens')), 'Esc comes back to the list', screen(out))
mark = out.length
shell.stdin.write('\t'.repeat(buttons.length))
await new Promise((r) => setTimeout(r, 300))
shell.stdin.write('/plans/7/')
await until(() => seen('/plans/7/'))
mark = out.length
shell.stdin.write('\r')
check(await until(() => seen('/plans/7/ · Esc goes back')), 'a typed path opens a route that takes a param', screen(out))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => seen('Tab moves, Enter opens')), 'and Esc comes back to the list', screen(out))
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
check(await until(() => seen('Tab moves, Enter opens')), 'the fixture shell lists its routes', screen(out))
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
walk.stdin.write('\x1b')
check(await until(() => seen('Tab moves, Enter opens')), 'and from its first entry to the list', screen(out))
walk.stdin.write('\x03')
const walkCode = await Promise.race([walked, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
if (walkCode === 'timeout') walk.kill('SIGKILL')

console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
