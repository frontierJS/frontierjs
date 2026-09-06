// ─── exec-options.test.js — an option `context.exec` does not have ────────────
//
// `config.exec` spread whatever it was handed straight into `execSync`, and an
// unrecognized key there changes nothing. `capture: true` is what that cost:
// four auth commands asked for the child's output, got `null` back from the
// default `stdio: 'inherit'`, parsed `''` out of it, and printed *Failed —
// check output above* directly beneath the output they were meant to read
// (`FJS-537`). The data was on screen and the command said it had failed.
//
// Two halves here and the second is the one with teeth. The first asserts the
// refusal; the second reads every `context.exec({…})` in every shipped command
// and grades the keys it passes, which is what would have caught the original
// four. Commands are markdown, so a compile is not a run and there is no other
// moment at which a wrong option is visible.

import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { EXEC_OPTIONS, refuseUnknownExecOptions } from '../core/runtime.js'

const COMMANDS = new URL('../commands', import.meta.url).pathname

describe('the option list is what execSync actually does', () => {

  // The reason the whole thing exists, asserted rather than asserted-about: an
  // unknown key is not an error to `execSync`, it is a no-op, and the default
  // `stdio: 'inherit'` then answers null.
  test('an unknown option is silently ignored by execSync itself', () => {
    const withUnknown = execSync('echo hello', { stdio: 'inherit', capture: true })
    expect(withUnknown).toBeNull()
    const piped = execSync('echo hello', { stdio: 'pipe' })
    expect(String(piped).trim()).toBe('hello')
  })

  test('every name on the list is one execSync accepts', () => {
    // A name that is not real would refuse nothing and mislead the message.
    // Asked by USING each one, at its cheapest legal value.
    const probes = {
      cwd: process.cwd(), input: '', stdio: 'pipe', env: process.env,
      shell: '/bin/sh', timeout: 5_000, killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true,
    }
    for (const [name, value] of Object.entries(probes)) {
      expect(() => execSync('echo x', { stdio: 'pipe', [name]: value })).not.toThrow()
    }
    // uid/gid are on the list and are NOT probed: setting either needs
    // privileges this process does not have, and a test that skips itself on
    // the developer's machine and runs as root in CI is worse than one row of
    // honest prose.
    expect(EXEC_OPTIONS.has('uid')).toBe(true)
    expect(EXEC_OPTIONS.has('gid')).toBe(true)
  })
})

describe('refuseUnknownExecOptions', () => {

  test('names the key it does not take', () => {
    expect(() => refuseUnknownExecOptions({ nonsense: 1 })).toThrow(/`nonsense`/)
  })

  test('names all of them, not just the first', () => {
    expect(() => refuseUnknownExecOptions({ alpha: 1, beta: 2 })).toThrow(/`alpha`, `beta`/)
  })

  test('points `capture` at the thing it was reaching for', () => {
    expect(() => refuseUnknownExecOptions({ capture: true })).toThrow(/stdio/)
  })

  // The pair. A guard that refused everything would satisfy all three above.
  test('accepts what commands actually pass', () => {
    expect(() => refuseUnknownExecOptions({})).not.toThrow()
    expect(() => refuseUnknownExecOptions({ cwd: '/tmp' })).not.toThrow()
    expect(() => refuseUnknownExecOptions({ stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
    expect(() => refuseUnknownExecOptions({ cwd: '/tmp', env: {}, input: 'x' })).not.toThrow()
  })
})

describe('allowFailure — a non-zero exit the caller is asking about', () => {

  // Built the way `config.exec` builds it, because the option is destructured
  // off there and the behavior under test is the catch arm.
  const exec = ({ command, allowFailure, ...opts }) => {
    try { return execSync(command, { stdio: 'inherit', ...opts }) }
    catch (err) {
      if (allowFailure && err.signal !== 'SIGINT' && err.signal !== 'SIGTERM') return err
      throw err
    }
  }

  test('a failing command throws without it — which is what two commands got', () => {
    expect(() => exec({ command: 'exit 3', stdio: 'pipe' })).toThrow()
  })

  test('and answers the exit code with it', () => {
    const out = exec({ command: 'exit 3', stdio: 'pipe', allowFailure: true })
    expect(out?.status).toBe(3)
  })

  test('the output is on the same key either way', () => {
    const ok   = exec({ command: 'echo yes', stdio: 'pipe' })
    const fail = exec({ command: 'echo no; exit 1', stdio: 'pipe', allowFailure: true })
    expect(String(ok?.stdout ?? ok ?? '').trim()).toBe('yes')
    expect(String(fail?.stdout ?? fail ?? '').trim()).toBe('no')
  })

  // The pair: a success is not turned into an error object.
  test('a command that succeeds still answers its output', () => {
    const out = exec({ command: 'echo fine', stdio: 'pipe', allowFailure: true })
    expect(out instanceof Error).toBe(false)
    expect(String(out).trim()).toBe('fine')
  })
})

// ── The corpus ───────────────────────────────────────────────────────────────
// Every shipped command, read as source. `command`, `dry` and `describe` are
// destructured off before the check, so they are legal here too.

const OWN = new Set(['command', 'dry', 'describe', 'allowFailure'])

function markdownFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) markdownFiles(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

/** The keys of each `exec({ … })` literal in one file.
 *
 *  A character scan rather than a line scan, because the shape that started
 *  this is a ONE-LINE call — `exec({ command: …, capture: true })` — and a
 *  reader that only looks at the start of a line sees `command` and nothing
 *  else. It cost this test its own negative control: reintroducing the bug
 *  into a command passed.
 *
 *  A key is an identifier followed by `:` at depth 0 in KEY POSITION — after
 *  the opening brace or a top-level comma — which is what keeps the `:` of a
 *  ternary out. Strings and template literals are skipped, since a URL inside
 *  one is full of both colons and braces.
 */
function execKeysIn(source) {
  const found = []
  const re = /\bexec\(\{/g
  let m
  while ((m = re.exec(source)) !== null) {
    const keys = []
    let i = m.index + m[0].length
    let depth = 1
    let expectKey = true
    while (i < source.length && depth > 0) {
      const c = source[i]

      if (c === "'" || c === '"' || c === '`') {
        const quote = c
        i++
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue }
          if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
            let d = 1; i += 2
            while (i < source.length && d > 0) {
              if (source[i] === '{') d++
              else if (source[i] === '}') d--
              i++
            }
            continue
          }
          if (source[i] === quote) { i++; break }
          i++
        }
        expectKey = false
        continue
      }

      if (c === '{' || c === '[' || c === '(') { depth++; i++; continue }
      if (c === '}' || c === ']' || c === ')') { depth--; i++; continue }
      if (depth === 1 && c === ',') { expectKey = true; i++; continue }

      if (expectKey && /[A-Za-z_$]/.test(c)) {
        const id = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))[0]
        const after = source.slice(i + id.length).match(/^\s*:/)
        if (after) { keys.push(id); expectKey = false }
        i += id.length
        continue
      }

      if (!/\s/.test(c)) expectKey = false
      i++
    }
    found.push({ keys, at: m.index })
  }
  return found
}

describe('every shipped command passes options exec has', () => {

  const files = markdownFiles(COMMANDS)

  test('the corpus is not empty — a walk that found nothing passes vacuously', () => {
    expect(files.length).toBeGreaterThan(20)
    const total = files.reduce((n, f) => n + execKeysIn(readFileSync(f, 'utf8')).length, 0)
    expect(total).toBeGreaterThan(30)
  })

  test('and none of them names an option it does not have', () => {
    const bad = []
    for (const file of files) {
      for (const call of execKeysIn(readFileSync(file, 'utf8'))) {
        for (const key of call.keys) {
          if (!OWN.has(key) && !EXEC_OPTIONS.has(key)) {
            bad.push(`${file.replace(COMMANDS, 'commands')}: ${key}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })
})
