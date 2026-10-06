// ─── shell.js — `$`, the command in progress, and the shell it runs ─────────
//
// A command body is one function with one argument, `$`. It is the context —
// `$.flag`, `$.exec`, `$.paths`, everything README § The context lists — and it
// is CALLABLE as a template tag, so `` await $`git rev-parse HEAD` `` runs a
// shell. One object, no copy: `commandContext()` makes the function and the
// fields are defined on it, so the thing parallel steps share is unchanged.
//
// The shell is Bun's (`FJS-D593`). What it adds to `Bun.$` is fli's rules:
//
//   - **captures by default**, prints under `--verbose`. Bun's default is the
//     opposite, so `.quiet()` is applied unless the person asked to watch.
//   - **`--dry` runs nothing**, logs the command at `dry` level and resolves to
//     an empty result — `$.exec`'s rule, through the same `log.dry` owner.
//   - **a non-zero exit throws** with the command in the message, plus Bun's own
//     `.exitCode`, `.stdout`, `.stderr`; `.nothrow()` opts out.
//   - **`.stdout` is a Buffer**, read it with `.text()`.
//
// Bun's shell is not bash: no heredoc and no `for`/`while` (both exit 1). A
// body that needs bash spells `` $`bash -c ${script}` `` and passes the script
// as one interpolation, which the shell hands over as a single argument.
// ─────────────────────────────────────────────────────────────────────────────

import { $ as bunShell } from 'bun'
import { isVerbose } from './verbosity.js'

const CONTEXT = Symbol.for('fli.context')

/** A callable context: the function is the shell tag, the fields are the context. */
export function commandContext(fields = {}) {
  const $ = (strings, ...values) => runShell($, strings, values)
  // defineProperty rather than assign: a function already owns `name` and
  // `length`, both read-only, and a field spelled either way would throw.
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty($, key, { value, writable: true, enumerable: true, configurable: true })
  }
  Object.defineProperty($, CONTEXT, { value: true })
  return $
}

/** Is this value the context — a `$` built here — rather than a spread copy of one? */
export const isCommandContext = (v) => typeof v === 'function' && v[CONTEXT] === true

/** The command as a person would type it: an interpolation quoted where a shell would need it. */
export function renderShell(strings, values) {
  const show = (v) =>
    Array.isArray(v) ? v.map(show).join(' ')
      : v && typeof v === 'object' && 'raw' in v ? String(v.raw)
        : /^[\w@%+=:,./-]+$/.test(String(v)) ? String(v) : bunShell.escape(String(v))
  return strings.raw.reduce((out, s, i) => out + s + (i < values.length ? show(values[i]) : ''), '')
}

const EMPTY = Object.freeze({
  exitCode: 0,
  stdout:   Buffer.alloc(0),
  stderr:   Buffer.alloc(0),
  text:  () => '',
  json:  () => null,
})

// A dry run answers like a run that printed nothing, chain methods included,
// so `` await $`x`.quiet() `` under --dry neither runs nor throws on `.quiet`.
const DRY = {
  quiet()   { return this },
  nothrow() { return this },
  throws()  { return this },
  cwd()     { return this },
  env()     { return this },
  then(ok, fail) { return Promise.resolve(EMPTY).then(ok, fail) },
}

// Bun's ShellError says `Failed with exit code 3` and nothing else, and a
// command that failed is the one thing the person needs named.
const decorate = (err, rendered) => {
  if (err && typeof err.exitCode === 'number') {
    const stderr = err.stderr?.toString().trim()
    err.message = `${rendered} failed (exit ${err.exitCode})${stderr ? `\n${stderr}` : ''}`
  }
  return err
}

/**
 * What `` $`…` `` returns: Bun's ShellPromise behind fli's rules. The chain
 * methods set up the run and `then` starts it, as Bun's own does.
 */
class ShellRun {
  #inner
  #rendered
  #after
  constructor(inner, rendered, after) { this.#inner = inner; this.#rendered = rendered; this.#after = after }

  quiet()      { this.#inner.quiet();    return this }
  nothrow()    { this.#inner.nothrow();  return this }
  throws(on)   { this.#inner.throws(on); return this }
  cwd(dir)     { this.#inner.cwd(dir);   return this }
  env(vars)    { this.#inner.env(vars);  return this }

  then(ok, fail) {
    return this.#inner
      .then(
        (out) => { this.#after?.(out); return out },
        (err) => { this.#after?.(err); throw decorate(err, this.#rendered) },
      )
      .then(ok, fail)
  }
  catch(fail)  { return this.then(undefined, fail) }
  finally(fn)  { return this.then().finally(fn) }

  text(enc)    { return this.then(r => r.text(enc)) }
  json()       { return this.then(r => r.json()) }
  // An array, not Bun's async iterator: a command reads a listing whole.
  lines()      { return this.then(r => { const t = r.text(); return t === '' ? [] : t.replace(/\n$/, '').split('\n') }) }
  bytes()      { return this.then(r => r.bytes()) }
  arrayBuffer(){ return this.then(r => r.arrayBuffer()) }
  blob()       { return this.then(r => r.blob()) }

  get [Symbol.toStringTag]() { return 'ShellRun' }
}

/** The tag's body: `$` is the context it was built as. */
export function runShell($, strings, values) {
  if (!Array.isArray(strings) || !('raw' in strings)) {
    throw new TypeError('$ is a template tag — write $`git status`, not $(\'git status\'); $.exec runs a string')
  }
  const rendered = renderShell(strings, values)
  if ($.flag?.dry) {
    $.log.dry(rendered)
    return new ShellRun(DRY, rendered)
  }
  const verbose = isVerbose()
  const emit    = $.emit ?? null
  if (verbose) $.log.detail(`$ ${rendered}`)
  const inner = bunShell(strings, ...values)
  // A web run has no stdout to inherit: capture, and hand the output over
  // afterwards when the person asked to see it.
  if (!verbose || emit) inner.quiet()
  const after = verbose && emit
    ? (out) => { for (const s of [out?.stdout, out?.stderr]) { const text = s?.toString(); if (text) emit({ type: 'output', text }) } }
    : null
  return new ShellRun(inner, rendered, after)
}
