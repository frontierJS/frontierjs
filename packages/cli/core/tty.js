// ─── tty.js — a command that owns the terminal while it runs ─────────────────
//
// `context.tty`. What a long-running command needs that `echo` and prompt.js
// do not give it, each of which fails in a way only a terminal shows:
//
//   keys(q, choices)  one keypress, no Enter. Raw mode stays on from the first
//                     call to close: switched per prompt, keys typed between
//                     two prompts echo onto the screen.
//   live(render)      one footer line. stdout, stderr and console are patched
//                     while it shows, so echo, log and console print ABOVE it;
//                     every write would otherwise land on the footer's own line.
//                     console is patched apart because Bun's writes to the fd
//                     and never reaches process.stdout.write.
//   aside(fn)         the screen for somebody else — $EDITOR. Raw mode off,
//                     this process's output held until fn returns, and Ctrl-C
//                     left to the child, since the terminal sends it to both.
//   onExit(fn)        runs however the command ends — return, throw, Ctrl-C,
//                     SIGTERM — capped, so a hung request cannot keep Ctrl-C
//                     from exiting.
//   title(text)       the terminal tab's title, cleared at the end.
//
// A terminal left in raw mode is a broken shell, so restoring it is not the
// author's job: the runtime closes every tty on return and on throw, its signal
// handlers close them on Ctrl-C and SIGTERM (`settleTtys`), and a bare
// `process.exit` still restores the terminal, though onExit cannot run there.
//
// No terminal — a pipe, or `fli gui`, whose stdin is the terminal it was started
// from with nobody at it for this run — and live, title and aside add nothing,
// while keys refuses by name, or answers a question with its first choice under
// `yes`. `interactive` is how a command asks first.
// ─────────────────────────────────────────────────────────────────────────────

import { stripVTControlCharacters } from 'node:util'
import { chalk } from './color.js'

const ERASE    = '\r\x1b[2K'
const EXIT_CAP = 3000

// ─── measuring ────────────────────────────────────────────────────────────────

/** Columns a string takes on screen: escape codes are zero, a code point is one. */
export const width = (s) => [...stripVTControlCharacters(String(s))].length

/**
 * Word-wrapped lines, each keeping the indent of the line it came from. An array
 * rather than a string, because a caller prefixes each line with a rail.
 */
export function wrap(text, cols) {
  return String(text).split('\n').flatMap((para) => {
    const indent = para.match(/^\s*/)[0]
    const room   = cols - width(indent)
    const lines  = []
    let line = ''
    for (const word of para.trim().split(/\s+/)) {
      if (line && width(line) + 1 + width(word) > room) { lines.push(indent + line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    lines.push(indent + line)
    return lines
  })
}

// A footer that wraps is two lines, and ERASE clears only the one the cursor is
// on, so every redraw would leave the previous one's first half behind.
export function truncate(s, cols) {
  const flat = String(s).replace(/\r?\n/g, ' ')
  if (width(flat) <= cols) return flat
  let out = '', seen = 0
  for (const [, code, ch] of flat.matchAll(/(\x1b\[[0-9;]*m)|([\s\S])/gu)) {
    if (code) out += code
    else if (seen < cols) { out += ch; seen++ }
  }
  return out + '\x1b[0m'
}

// Parts drop from the right until the line fits, so the least useful go first.
export function fit(parts, sep, cols) {
  const kept = parts.filter(p => p != null && p !== false && p !== '')
  while (kept.length > 1 && width(kept.join(sep)) > cols) kept.pop()
  return truncate(kept.join(sep), cols)
}

// ─── every open tty, for the paths that end the process ──────────────────────

const open = new Set()

/** Close every open tty — onExit included. The runtime's signal handlers await it. */
export const settleTtys = () => Promise.all([...open].map(t => t.close()))

/** Is a tty lending the screen out? Ctrl-C then belongs to the child. */
export const ttyAside = () => [...open].some(t => t.inAside())

process.on('exit', () => { for (const t of open) t.restore() })

// ─── createTty ────────────────────────────────────────────────────────────────

export function createTty({
  yes       = false,
  emit      = null,
  input     = process.stdin,
  output    = process.stdout,
  errput    = process.stderr,
  interrupt = () => process.kill(process.pid, 'SIGINT'),
  cap       = EXIT_CAP,
} = {}) {
  const interactive = !emit && !!input.isTTY && !!output.isTTY
  const cols = () => (output.columns || 80) - 1

  let render   = null
  let sep      = ' · '
  const waiting = []   // keys() calls in the order made
  let drawn    = ''    // what the footer line shows now
  let lineOpen = false // the last write left the cursor mid-line
  let asideDepth = 0
  const held   = []
  let raw      = false
  let lent     = false // raw mode handed to aside, taken back after
  let titled   = false
  const hooks  = []
  let restored = false
  let closing  = null

  // ─── the footer ─────────────────────────────────────────────────────────────

  // A question outranks a bare listener whatever their age, so a menu loop that
  // re-arms while a prompt is open cannot take the prompt's keys.
  const active = () => waiting.findLast(w => w.prompt) ?? waiting.at(-1)

  const footerText = () => {
    if (asideDepth || restored) return ''
    const asking = waiting.findLast(w => w.prompt)
    if (asking) return truncate(asking.prompt, cols())
    const r = render?.()
    if (r == null || r === false) return ''
    return Array.isArray(r) ? fit(r, sep, cols()) : truncate(r, cols())
  }

  const erase = () => { if (drawn) { outWrite(ERASE); drawn = '' } }

  const draw = () => {
    if (!interactive || lineOpen) return
    const text = footerText()
    if (text === drawn) return
    erase()
    if (text) { outWrite(text); drawn = text }
  }

  // ─── output above the footer ────────────────────────────────────────────────

  const origOut = output.write
  const origErr = errput.write
  const outWrite = (s) => origOut.call(output, s)
  let patched = false

  const CONSOLE = ['log', 'info', 'warn', 'error', 'debug']
  const origConsole = Object.fromEntries(CONSOLE.map(m => [m, console[m]]))

  // Every console method ends its line.
  const aboveConsole = (m) => (...args) => {
    if (asideDepth) { held.push(() => console[m](...args)); return }
    erase()
    origConsole[m].apply(console, args)
    lineOpen = false
    draw()
  }

  const through = (stream, orig) => function (chunk, ...rest) {
    if (asideDepth) { held.push(() => stream.write(chunk, ...rest)); return true }
    erase()
    const ok = orig.call(stream, chunk, ...rest)
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    if (s) lineOpen = !s.endsWith('\n')
    draw()
    return ok
  }

  // Only a tty that has done something is one an exit has to undo, and a
  // Command() built and never run would otherwise stay in `open` for good.
  const enlist = () => { if (!restored) open.add(tty) }

  const patch = () => {
    if (patched || !interactive || restored) return
    enlist()
    output.write = through(output, origOut)
    if (errput.isTTY) errput.write = through(errput, origErr)
    for (const m of CONSOLE) console[m] = aboveConsole(m)
    patched = true
  }

  const unpatch = () => {
    if (!patched) return
    output.write = origOut
    if (errput.isTTY) errput.write = origErr
    Object.assign(console, origConsole)
    patched = false
  }

  // ─── the keyboard ───────────────────────────────────────────────────────────

  const keyName = (k) =>
    k === '\r' || k === '\n' || k === '\r\n' ? 'enter'
      : k === '\x1b' ? 'esc'
        : [...k].length === 1 ? k.toLowerCase() : null

  // Enter is a question's default. A bare listener shows no choices, so it has
  // none, and Enter there is a key like any other.
  const pick = ({ choices, prompt }, name) => {
    if (Object.hasOwn(choices, name)) return name
    return name === 'enter' && prompt ? Object.keys(choices)[0] : null
  }

  const onData = (buf) => {
    const k = buf.toString()
    if (k === '\x03') return interrupt()
    const w = active()
    const name = keyName(k)
    const key = w && name && pick(w, name)
    if (!key) return
    waiting.splice(waiting.indexOf(w), 1)
    if (w.prompt) {
      erase()
      outWrite(`${w.prompt}${chalk.bold(w.choices[key])}\n`)
      lineOpen = false
    }
    draw()
    w.resolve(key)
  }

  const listen = () => {
    if (raw || restored) return
    enlist()
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
    raw = true
  }

  const unlisten = () => {
    if (!raw) return
    input.off('data', onData)
    input.setRawMode(false)
    input.pause()
    raw = false
  }

  // `[y]es` where the key is in the label, `[k] label` where it is not, and the
  // key Enter picks is upper-case — the `(Y/n)` prompt.js's confirm prints.
  const hint = ([key, label], i) => {
    if (key === 'enter' || key === 'esc') return `${chalk.dim(key)} ${label}`
    const shown = i === 0 ? key.toUpperCase() : key
    const at = label.toLowerCase().indexOf(key)
    return at < 0
      ? `${chalk.dim('[')}${chalk.bold(shown)}${chalk.dim(']')} ${label}`
      : `${label.slice(0, at)}${chalk.dim('[')}${chalk.bold(shown)}${chalk.dim(']')}${label.slice(at + key.length)}`
  }

  const refusal = (question) =>
    `tty.keys(${question == null ? 'null' : JSON.stringify(question)}) needs a person at a terminal, and this run has none` +
    (emit ? ' — fli gui runs a command with no terminal' : '') +
    '. Check tty.interactive before asking.'

  // ─── the surface ────────────────────────────────────────────────────────────

  const tty = {
    interactive,

    /**
     * One keypress from `choices` ({ key: label }), resolved with the key.
     * Enter picks the one named `enter`, else a question's first choice; Esc
     * picks the one named `esc` and is ignored otherwise. A null question
     * listens without taking the footer — a menu under a live line — and has no
     * default.
     */
    keys(question, choices) {
      const entries = Object.entries(choices ?? {})
      if (!entries.length) throw new TypeError('tty.keys needs at least one choice')
      if (question != null && yes) return Promise.resolve(entries[0][0])
      if (!interactive) return Promise.reject(new Error(refusal(question)))
      if (restored) return new Promise(() => {})
      return new Promise((resolve) => {
        const prompt = question == null ? null : `${question} ${entries.map(hint).join(' ')} `
        waiting.push({ choices, prompt, resolve })
        patch()
        listen()
        draw()
      })
    },

    /**
     * A footer from `render()`: a string, or an array whose parts drop from the
     * right to fit (`sep` joins them). null hides it. Redrawn on `update()` and
     * after every write, and only when it changed.
     */
    live(fn, { sep: joiner = ' · ' } = {}) {
      if (render) throw new Error('tty.live: a footer is already showing — stop() it first')
      render = fn
      sep = joiner
      patch()
      draw()
      return {
        update: () => { if (render === fn) draw() },
        stop:   () => { if (render !== fn) return; render = null; erase(); draw() },
      }
    },

    async aside(fn) {
      if (!interactive) return fn()
      enlist()
      if (asideDepth++ === 0) { erase(); if (raw) { unlisten(); lent = true } }
      try {
        return await fn()
      } finally {
        if (--asideDepth === 0) {
          if (lent) { lent = false; listen() }
          for (const f of held.splice(0)) f()
          draw()
        }
      }
    },

    onExit(fn) { hooks.push(fn); enlist() },

    title(text) {
      if (!interactive || restored) return
      enlist()
      outWrite(`\x1b]0;${text}\x07`)
      titled = true
    },

    wrap:  (text, n = cols()) => wrap(text, n),
    width,

    inAside: () => asideDepth > 0,

    /** The terminal as it was found. Synchronous — the `exit` event allows nothing else. */
    restore() {
      if (restored) return
      restored = true
      render = null
      waiting.length = 0
      erase()
      unlisten()
      if (titled) outWrite('\x1b]0;\x07')
      unpatch()
      for (const f of held.splice(0)) f()
      open.delete(tty)
    },

    /**
     * Restore, then run every onExit together under one cap. The terminal goes
     * back first so a second Ctrl-C is a real signal, and the runtime answers
     * that one without waiting.
     */
    close() {
      return (closing ??= (async () => {
        tty.restore()
        if (!hooks.length) return
        let timer
        const done = Promise.allSettled(hooks.map(fn => Promise.resolve().then(fn)))
        const late = new Promise(r => { timer = setTimeout(() => r('late'), cap) })
        const result = await Promise.race([done, late])
        clearTimeout(timer)
        if (result === 'late') errput.write(`onExit did not finish in ${cap / 1000}s; exiting anyway\n`)
        else for (const r of result) if (r.status === 'rejected') errput.write(`onExit: ${r.reason?.message ?? r.reason}\n`)
      })())
    },
  }

  return tty
}
