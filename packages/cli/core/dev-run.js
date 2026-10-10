// ─── dev-run.js — the surfaces of `fli dev`, one labeled stream ──────────────
// Two servers under `bun run api & bun run web & wait` write into one terminal
// with nothing saying whose line is whose, so a vite error reads as the API's.
// Each surface runs as its own child here and every line it writes is printed
// behind its surface's name.
//
// A child is its own process group and is stopped as one: `bun run api` is a
// launcher, and signaling its pid leaves the app it spawned holding the port
// (`core/children.js` § Lifetime measured the same thing).

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { chalk, colorEnabled } from './color.js'
import { plain, wrap } from './text.js'

const TONES = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue]

// Lines closer together than this are one burst — a boot, a rebuild. A blank
// line between bursts, and wherever the surface speaking changes, is what lets
// each block be read as one.
const BURST_MS = 300

/**
 * Run each row's script from `root` until every one has exited.
 * Resolves with the first non-zero exit code, or 0.
 *
 * @param {{root: string, runner: string, rows: {surface: string, script: string}[],
 *          env: object, echo: Function, onExit: Function}} opts
 */
export function runSurfaces({ root, runner, rows, env, echo, onExit }) {
  const width = Math.max(...rows.map(r => r.surface.length))
  // A child's stdout is a pipe here, so vite and bun drop their color unless told.
  const childEnv = colorEnabled ? { ...env, FORCE_COLOR: '1' } : env

  // A line the terminal wraps itself restarts at column 0, under nobody's
  // label. Wrapped here, its rest stays inside the column. A pipe has no
  // width and is not wrapped.
  const room = process.stdout.columns ? process.stdout.columns - width - 3 : 0
  let last = 0, speaker = null

  const print = (tone, label, line) => {
    // bun echoes each script's command before running it, and the header has
    // already named the script.
    // A child under FORCE_COLOR styles the echo, so it is read without escapes.
    if (plain(line).startsWith('$ ')) return
    const now   = Date.now()
    const fresh = !last || now - last > BURST_MS || speaker !== label
    // A blank line opening a block doubles the one printed between blocks.
    if (fresh && !plain(line).trim()) return
    if (fresh) echo('')
    last = now; speaker = label
    const [first, ...rest] = wrap(line, room && room - 2)
    echo(`${tone(`${label} │`)} ${first}`)
    for (const r of rest) echo(`${tone(`${' '.repeat(width)} │`)}   ${r}`)
  }

  const children = rows.map((row, i) => {
    const tone  = TONES[i % TONES.length]
    const label = row.surface.padEnd(width)
    const say   = line => print(tone, label, line)
    const child = spawn(runner, ['run', row.script], {
      cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', say)
    }
    const done = new Promise(resolve => {
      child.on('error', err => { say(chalk.red(err.message)); resolve(1) })
      child.on('close', (code, signal) => {
        if (!signal) say((code ? chalk.red : chalk.dim)(`exited with code ${code}`))
        resolve(code ?? 0)
      })
    })
    return { child, done }
  })

  // Ctrl-C reaches fli and not the children, which lead their own groups.
  onExit(() => {
    for (const { child } of children) {
      if (child.exitCode === null) try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }
  })

  return Promise.all(children.map(c => c.done)).then(codes => codes.find(c => c) ?? 0)
}
