/**
 * web/test/verify-tui.mjs — this app's routes in a terminal, `fli dev:tui`
 * (`FJS-D809`). Started by `bun run verify:tui`; needs no API, no Chrome and
 * no TTY of its own.
 *
 * Three runs of Sierra's shell (`@frontierjs/sierra/tui`) from `web/`:
 * `--list`, which says per route whether it lowers and names the first
 * blocker; `--frame /reports/`, the one route that lowers today, painted; and
 * the interactive shell under a pty, opened, left with Esc and quit with
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
check(rows.some((l) => /^✗ \/plans\/:id\/\s+takes :id/.test(l)), 'a route taking a param says so', list.stdout)
check(rows.some((l) => /^✗ \/plans\/\s+\S.* at src\/routes\/plans\/index\.mesa:\d+:\d+$/.test(l)),
  'a route that does not lower names its blocker by file and line', list.stdout)
// `/` imports only `orders` from Order.mesa and `/orders/create/` mounts its
// form, so the file's markup refuses the second and not the first (FJS-2182).
check(rows.some((l) => /^✗ \/orders\/create\/\s+.* at src\/resources\/Order\.mesa:\d+:\d+$/.test(l)),
  'a route mounting a resource file\'s form is refused for it', list.stdout)
check(rows.some((l) => /^. \/\s/.test(l) && !l.includes('Order.mesa')),
  'and a route taking only its data half is not', list.stdout)
check(/\d+ of \d+ routes lower for the terminal/.test(list.stdout), 'and a count closes it', list.stdout)

// ─── --frame ──────────────────────────────────────────────────────────

const frame = spawnSync('bun', [TUI, '--frame', '/reports/', '--api', API], { cwd: WEB, encoding: 'utf8' })
check(frame.status === 0, '--frame exits 0', frame.stderr)
check(/^Reports\s*$/m.test(frame.stdout), 'the frame has the page heading', frame.stdout)
check(frame.stdout.includes('Revenue is administrator-only'), 'and the gate refusal, drawn without a request', frame.stdout)

// ─── interactive ──────────────────────────────────────────────────────

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
shell.stdin.write('\r')
check(await until(() => plain(out.slice(mark)).includes('administrator-only')), 'Enter opens it', plain(out.slice(mark)).slice(-500))
mark = out.length
shell.stdin.write('\x1b')
check(await until(() => plain(out.slice(mark)).includes('lower')), 'Esc comes back to the list', plain(out.slice(mark)).slice(-500))
mark = out.length
shell.stdin.write('\x03')
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
check(out.slice(mark).includes('\x1b[?1049l'), 'and gives the terminal back')
if (code === 'timeout') shell.kill('SIGKILL')

console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
