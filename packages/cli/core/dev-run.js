// ─── dev-run.js — the surfaces of `fli dev`, one labeled stream ──────────────
// Two servers under `bun run api & bun run web & wait` write into one terminal
// with nothing saying whose line is whose, so a vite error reads as the API's.
// Each surface runs as its own child here and every line it writes is printed
// behind its surface's name.
//
// A child is its own process group and is stopped as one: `bun run api` is a
// launcher, and signaling its pid leaves the app it spawned holding the port
// (`core/children.js` § Lifetime measured the same thing).
//
// COMPACT is the default. Each child is started with `FLI_DEV=1` and prints
// one ready line in place of its boot banner (`@frontierjs/toolbelt/devline`);
// once every surface has said it, they are laid out as one summary, two lines
// a surface. Until then every other line is HELD, never dropped: a surface
// that exits, or a summary that does not come within `settleMs`, prints what
// there is and lets the held lines through. VERBOSE starts the children
// without the variable, so each prints the banner it always has.

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { DEV_ENV, parseDevLine } from '@frontierjs/toolbelt/devline'
import { chalk, colorEnabled } from './color.js'
import { plain, wrap, visibleLength } from './text.js'

const TONES = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue]

// Lines closer together than this are one burst — a boot, a rebuild. A blank
// line between bursts, and wherever the surface speaking changes, is what lets
// each block be read as one.
const BURST_MS = 300

// A cold vite with a dependency pre-bundle takes seconds; an API that never
// reports is one whose output the person is waiting to read.
const SETTLE_MS = 15000

// A boot past this with nothing on screen reads as a hang, though basecamp
// takes ~1.5s. A boot faster than this prints no line it would then bury.
const BOOTING_MS = 400

// `bun --watch` keeps a process that threw at boot alive, so no exit ends the
// hold and the error waited out SETTLE_MS. A surface that writes an error line
// before its ready line, then nothing for this long, counts as down; the hold
// ends once every surface is ready or down.
const CRASH_QUIET_MS = 1000
const CRASH_LINE = /^error\b/i

/**
 * Run each row's script from `root` until every one has exited.
 *
 * @param {{root: string, runner: string, rows: {surface: string, script: string}[],
 *          env: object, echo: Function, onExit: Function,
 *          compact?: boolean, title?: string, settleMs?: number, bootingMs?: number,
 *          columns?: number, onSummary?: Function}} opts
 * @returns {{ done: Promise<number>, restart: (opts?: {compact?: boolean}) => Promise<void>,
 *             readonly compact: boolean, readonly summarized: boolean,
 *             frontUrl: () => string | undefined }}
 *   `done` resolves with the first non-zero exit code, or 0, when the surfaces
 *   exit on their own; a restart's stop does not resolve it.
 */
export function runSurfaces({
  root, runner, rows, env, echo, onExit,
  compact = true, title = '', settleMs = SETTLE_MS, bootingMs = BOOTING_MS, columns = process.stdout.columns,
  onSummary = () => {},
}) {
  const width = Math.max(...rows.map(r => r.surface.length))
  // A child's stdout is a pipe here, so vite and bun drop their color unless told.
  const baseEnv = colorEnabled ? { ...env, FORCE_COLOR: '1' } : { ...env }

  // A line the terminal wraps itself restarts at column 0, under nobody's
  // label. Wrapped here, its rest stays inside the column. A pipe has no
  // width and is not wrapped.
  const room = columns ? columns - width - 3 : 0
  let last = 0, speaker = null

  const print = (tone, label, line) => {
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

  const printWarn = (label, { file, text }) => {
    echo('')
    last = 0; speaker = null
    echo(`  ${chalk.yellow('!')} ${chalk.yellow(label)}  ${file ?? ''}`)
    const pad = ' '.repeat(width + 6)
    for (const r of wrap(text, columns ? columns - pad.length : 0)) echo(chalk.dim(pad + r))
  }

  // The URL a person opens: the web surface's, or the first that reported one.
  // The summary marks it and `o` opens it, so the two cannot name different ones.
  const frontUrl = (g) => {
    const urls = rows.map(r => ({ surface: r.surface, url: g.ready.get(r.surface)?.url })).filter(u => u.url)
    return (urls.find(u => u.surface === 'web') ?? urls[0])?.url
  }

  let gen = null
  let resolveDone
  const done = new Promise(r => { resolveDone = r })

  // ─── the summary ────────────────────────────────────────────────────────────

  const summarize = (g) => {
    if (g.summarized) return
    g.summarized = true
    clearTimeout(g.timer)
    clearTimeout(g.booting)
    const urls = rows.map(r => g.ready.get(r.surface)?.url ?? '')
    const urlWidth = Math.max(0, ...urls.map(u => u.length))
    const lead = 2 + width + 3 + urlWidth + 3
    const fit = s => wrap(s, columns ? columns - lead : 0)
    const front = frontUrl(g)

    // A surface that never reported is not ready, and its row says so.
    const allReady = rows.every(r => g.ready.has(r.surface))
    const took = chalk.dim(`in ${((Date.now() - g.started) / 1000).toFixed(1)}s`)
    const head = [allReady && chalk.bold(chalk.green('READY')), title && chalk.bold(title), allReady && took].filter(Boolean)
    echo('')
    if (head.length) { echo(`  ${head.join('  ')}`); echo('') }
    rows.forEach((row, i) => {
      const tone  = TONES[i % TONES.length]
      const label = tone(row.surface.padEnd(width))
      const ready = g.ready.get(row.surface)
      if (!ready) {
        echo(`  ${label}   ${chalk.dim('no ready line — its output follows')}`)
        return
      }
      const url = ready.url ?? ''
      const facts = ready.rows.length ? ready.rows : [{ name: '', facts: [] }]
      facts.forEach((r, j) => {
        const text = [r.name && chalk.bold(r.name), ...r.facts].filter(Boolean).join(chalk.dim(' · '))
        const [first = '', ...rest] = fit(text)
        const shown = url && url === front ? chalk.green(url) : url
        const head = j === 0
          ? `  ${label}   ${shown}${' '.repeat(urlWidth - visibleLength(url))}   `
          : ' '.repeat(lead)
        echo(head + first)
        for (const more of rest) echo(' '.repeat(lead + 2) + more)
      })
    })
    last = 0; speaker = null
    for (const f of g.held.splice(0)) f()
    g.printed = true
    onSummary()
  }

  // ─── one generation of children ─────────────────────────────────────────────

  const start = (isCompact) => {
    const g = { compact: isCompact, started: Date.now(), ready: new Map(), down: new Set(), summarized: !isCompact, printed: !isCompact, held: [], children: [], stopping: false, timer: null }
    gen = g
    const childEnv = { ...baseEnv }
    if (isCompact) childEnv[DEV_ENV] = '1'
    else delete childEnv[DEV_ENV]

    const emit = (fn) => (g.summarized ? fn() : g.held.push(fn))

    g.children = rows.map((row, i) => {
      const tone  = TONES[i % TONES.length]
      const label = row.surface.padEnd(width)
      let quiet   = null
      const say   = (line) => {
        if (g.stopping) return
        const text = plain(line)
        // bun echoes each script's command before running it, and the header has
        // already named the script. Read without escapes: FORCE_COLOR styles it.
        if (text.startsWith('$ ')) return
        const message = parseDevLine(text)
        if (message?.ready) {
          clearTimeout(quiet)
          g.down.delete(row.surface)
          g.ready.set(row.surface, message.ready)
          if (rows.every(r => g.ready.has(r.surface) || g.down.has(r.surface))) summarize(g)
          return
        }
        if (message?.warn) return emit(() => printWarn(label, message.warn))
        if (!g.summarized && !g.ready.has(row.surface) && (quiet || CRASH_LINE.test(text.trim()))) {
          clearTimeout(quiet)
          quiet = setTimeout(() => {
            g.down.add(row.surface)
            if (rows.every(r => g.ready.has(r.surface) || g.down.has(r.surface))) summarize(g)
          }, CRASH_QUIET_MS)
        }
        emit(() => print(tone, label, line))
      }
      const child = spawn(runner, ['run', row.script], {
        cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', say)
      }
      const exited = new Promise(resolve => {
        child.on('error', err => { say(chalk.red(err.message)); resolve(1) })
        child.on('close', (code, signal) => {
          if (!signal) say((code ? chalk.red : chalk.dim)(`exited with code ${code}`))
          // A surface that is gone will never report, and what it said on the
          // way out is the thing to read.
          if (!g.stopping) summarize(g)
          resolve(code ?? 0)
        })
      })
      return { child, exited }
    })

    if (!g.summarized) g.timer = setTimeout(() => summarize(g), settleMs)
    if (!g.summarized) g.booting = setTimeout(() => {
      if (g.summarized || g.stopping) return
      echo('')
      echo(`  ${[title && chalk.bold(title), chalk.dim('gearing up…')].filter(Boolean).join('  ')}`)
    }, bootingMs)

    Promise.all(g.children.map(c => c.exited)).then(codes => {
      if (!g.stopping) resolveDone(codes.find(c => c) ?? 0)
    })
  }

  const stop = (g) => {
    g.stopping = true
    clearTimeout(g.timer)
    clearTimeout(g.booting)
    for (const { child } of g.children) {
      if (child.exitCode === null) try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    return Promise.all(g.children.map(c => c.exited))
  }

  // Ctrl-C reaches fli and not the children, which lead their own groups.
  onExit(() => { if (gen) stop(gen) })

  start(compact)

  return {
    done,
    get compact() { return gen.compact },
    // Not `gen.summarized`, which is set before the first line of it is written.
    get summarized() { return gen.printed },
    frontUrl: () => frontUrl(gen),
    async restart({ compact: next = gen.compact } = {}) {
      await stop(gen)
      echo('')
      echo(chalk.dim(`  restarting${next === gen.compact ? '' : next ? ' — compact' : ' — verbose'}`))
      start(next)
    },
  }
}
