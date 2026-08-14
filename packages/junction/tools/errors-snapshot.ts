#!/usr/bin/env bun
// tools/errors-snapshot.ts
// What a thrown value becomes — `junction errors`.
//
// `toFrameworkError` is the one owner of "a thrown thing → an HTTP answer"
// (Invariant 4), and everything above it reads only the result. That makes the
// mapping invisible from both sides: a Litestone error class that gains a
// `status` silently stops being a 500, and one that never had one silently is a
// 500 while its message says otherwise. Neither breaks a test, because nothing
// asserts on a category nobody named.
//
// So this is EXECUTED, not restated. Every row below is a value actually thrown
// through `toFrameworkError()`, including real Litestone error instances — the
// cross-package half is the half that drifts, and a hand-written table of what
// junction "should" do about litestone's classes would be a second opinion
// rather than an observation.
//
// Usage:
//   junction errors              write errors.snapshot.md at the package root
//   junction errors --check      exit 1 if the committed file is stale (CI)
//   junction errors --stdout

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve }             from 'node:path'

import * as errors                    from '../src/core/errors.ts'
import { FrameworkError, toFrameworkError, fromStatusCode } from '../src/core/errors.ts'

const argv    = Bun.argv.slice(2)
const flag    = (name: string) => argv.includes(`--${name}`)
const getFlag = (name: string) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}

const rel = (p: string) => relative(process.cwd(), p) || basename(p)

// ─── running a value through the boundary ─────────────────────────────────────

interface Outcome { cls: string; status: number; retryable: string }

function outcomeOf(value: unknown): Outcome {
  const out = toFrameworkError(value)
  return {
    cls:       out.constructor.name,
    status:    out.code,
    retryable: typeof out.retryable === 'boolean' ? String(out.retryable) : '—',
  }
}

const named = (name: string, message = 'probe') =>
  Object.assign(new Error(message), { name })

// ─── the probes ───────────────────────────────────────────────────────────────
//
// One per branch `toFrameworkError` can take, in the order it takes them. A
// branch with no row here is a branch nothing records.

const PROBES: { label: string; make: () => unknown }[] = [
  { label: 'a `FrameworkError` (passes through unchanged)', make: () => new errors.NotFound('gone') },
  { label: 'a plain `Error`',                               make: () => new Error('boom') },
  { label: 'an `Error` whose `name` is a class name',       make: () => named('Forbidden') },
  { label: 'an `Error` whose `name` is mapped by name',     make: () => named('ValidationError') },
  { label: 'an `Error` whose `name` is unknown',            make: () => named('SomethingNobodyDeclared') },
  { label: 'a numeric `status`',                            make: () => Object.assign(new Error('x'), { status: 404 }) },
  { label: 'a numeric `statusCode`',                        make: () => Object.assign(new Error('x'), { statusCode: 429 }) },
  { label: 'a numeric `code`',                              make: () => Object.assign(new Error('x'), { code: 403 }) },
  { label: 'a status with no class of its own',             make: () => Object.assign(new Error('x'), { status: 423 }) },
  { label: 'a status outside 400–599',                      make: () => Object.assign(new Error('x'), { status: 200 }) },
  { label: 'a string `code` (an error code, not a status)', make: () => Object.assign(new Error('x'), { code: 'ACCESS_DENIED' }) },
  { label: 'a thrown string',                               make: () => 'just a string' },
  { label: 'a thrown object',                               make: () => ({ message: 'not an Error' }) },
  { label: 'a thrown `null`',                               make: () => null },
]

// ─── Litestone's own classes ──────────────────────────────────────────────────
//
// Instantiated for real, because `status` and `retryable` are set in the
// constructor and a class name alone cannot tell you either. Signatures differ,
// so several argument shapes are tried; one that refuses them all is reported as
// refusing them rather than guessed at, and its NAME is still run through the
// boundary — the name path is what would catch it in production anyway.

const ARG_SHAPES: unknown[][] = [
  ['probe'],
  [[{ path: ['x'], message: 'probe' }]],
  ['Model', 'field', 'from', 'to', ['allowed']],
  ['Model', 'field', ['a', 'b'], 'current'],
  ['Model', 1, 2],
]

function instantiate(Cls: new (...a: unknown[]) => unknown): unknown | null {
  for (const args of ARG_SHAPES) {
    try { return new Cls(...args) } catch { /* try the next shape */ }
  }
  return null
}

async function litestoneRows() {
  let mod: Record<string, unknown>
  try {
    mod = await import('@frontierjs/litestone') as Record<string, unknown>
  } catch {
    return null
  }

  const rows: { name: string; declared: string; outcome: Outcome | null }[] = []

  for (const name of Object.keys(mod).sort()) {
    if (!/Error$/.test(name)) continue
    const value = mod[name]
    if (typeof value !== 'function') continue

    const instance = instantiate(value as new (...a: unknown[]) => unknown)
    if (!instance) {
      // The name path, which is what junction would use for it in production.
      rows.push({ name, declared: 'constructor needs arguments a probe cannot supply', outcome: outcomeOf(named(name)) })
      continue
    }

    const e = instance as { status?: unknown; code?: unknown; retryable?: unknown }
    const declared = [
      typeof e.status === 'number' ? `status ${e.status}` : null,
      typeof e.code === 'number' ? `code ${e.code}` : typeof e.code === 'string' ? `code \`${e.code}\`` : null,
      typeof e.retryable === 'boolean' ? `retryable ${e.retryable}` : null,
    ].filter(Boolean).join(' · ')

    rows.push({ name, declared: declared || 'nothing', outcome: outcomeOf(instance) })
  }

  return rows
}

// ─── render ───────────────────────────────────────────────────────────────────

const STATUSES = [400, 401, 402, 403, 404, 405, 409, 410, 418, 422, 423, 429, 500, 501, 502, 503, 504, 599]

export async function renderErrorsSnapshot(): Promise<string> {
  const out: string[] = []

  out.push('# Error boundary snapshot')
  out.push('')
  // The machine half: scripts/ci.mjs reads this line and reruns the command
  // with --check from this file's own directory.
  out.push('<!-- generated by: junction errors -->')
  out.push('')
  out.push('Generated by `junction errors`. **Do not edit.**')
  out.push('')
  out.push('Every row is a value actually thrown through `toFrameworkError()` — the one')
  out.push('owner of "a thrown thing → an HTTP answer". Everything above it reads only the')
  out.push('result, which is what makes a change here invisible: an error class that gains')
  out.push('a `status` stops being a 500 and nothing fails, and one that never had a status')
  out.push('is a 500 while its message says otherwise.')
  out.push('')
  out.push('`retryable` is on the wire because a status cannot carry it. A 409 that is')
  out.push('retryable means *the row moved, re-read and re-apply*; a 409 that is not means')
  out.push('*this is not a legal move*. A client that cannot tell them apart has to phrase')
  out.push('both as the weaker one.')
  out.push('')

  // ── The classes ──
  const classes = Object.keys(errors)
    .filter(k => {
      const v = (errors as Record<string, unknown>)[k]
      return typeof v === 'function' && v !== FrameworkError &&
             Object.prototype.isPrototypeOf.call(FrameworkError, v)
    })
    .sort()

  out.push('## The classes')
  out.push('')
  out.push('Throw one of these anywhere and the transport serialises it. Status is set in')
  out.push('the constructor, so a class is its status.')
  out.push('')
  out.push('| Class | Status | Default message |')
  out.push('| --- | --- | --- |')
  for (const name of classes) {
    const Cls = (errors as Record<string, unknown>)[name] as new () => FrameworkError
    const e   = new Cls()
    out.push(`| \`${name}\` | ${e.code} | ${e.message} |`)
  }
  out.push('')

  // ── Thrown → answered ──
  out.push('## What a thrown value becomes')
  out.push('')
  out.push('In the order `toFrameworkError` tries them: already a `FrameworkError` →')
  out.push('a registered mapper → a numeric `status`/`statusCode`/`code` in 400–599 →')
  out.push('the thrown `name` → `GeneralError`. Registered mappers are an app\'s own and')
  out.push('are not part of this file; **most-recently-registered wins**, so an app can')
  out.push('override any row below.')
  out.push('')
  out.push('| Thrown | Class | Status | Retryable |')
  out.push('| --- | --- | --- | --- |')
  for (const probe of PROBES) {
    const o = outcomeOf(probe.make())
    out.push(`| ${probe.label} | \`${o.cls}\` | ${o.status} | ${o.retryable} |`)
  }
  out.push('')

  // ── fromStatusCode ──
  out.push('## Status → class')
  out.push('')
  out.push('A status with no class of its own keeps the STATUS and loses only the class,')
  out.push('which is the part nothing on the wire reads. A number outside 400–599 is not a')
  out.push('status at all and falls to 500.')
  out.push('')
  out.push('| Status | Class | Answers |')
  out.push('| --- | --- | --- |')
  for (const status of STATUSES) {
    const e = fromStatusCode(status)
    out.push(`| ${status} | \`${e.constructor.name}\` | ${e.code} |`)
  }
  out.push('')

  // ── Litestone ──
  const rows = await litestoneRows()
  out.push('## Litestone\'s errors, through this boundary')
  out.push('')
  out.push('The cross-package half, and the half that drifts. **If you own the error class,')
  out.push('give it a `status`** — `registerErrorMapper()` is for errors you cannot modify.')
  out.push('A row landing on 500 with a message about a conflict is a client told to retry')
  out.push('something that will never work, or not to retry something that would.')
  out.push('')
  if (!rows) {
    out.push('Litestone is not resolvable from here, so this section is empty rather than')
    out.push('assumed. That is itself worth seeing in a diff.')
  } else {
    out.push('| Litestone class | Declares | Becomes | Status | Retryable |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const r of rows) {
      const o = r.outcome!
      out.push(`| \`${r.name}\` | ${r.declared} | \`${o.cls}\` | ${o.status} | ${o.retryable} |`)
    }
  }
  out.push('')

  return out.join('\n').replace(/\n+$/, '\n')
}

// ─── main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const body    = await renderErrorsSnapshot()
  const outPath = getFlag('out')
    ? resolve(getFlag('out') as string)
    : resolve(import.meta.dir, '..', 'errors.snapshot.md')

  if (flag('stdout')) {
    process.stdout.write(body)
  } else if (flag('check')) {
    if (!existsSync(outPath)) {
      console.error(`\n  ✗  No snapshot at ${rel(outPath)} — run \`junction errors\` and commit it.\n`)
      process.exit(1)
    }
    const committed = readFileSync(outPath, 'utf8')
    if (committed === body) {
      console.log(`  ✓  ${rel(outPath)} is current`)
    } else {
      const was = committed.split('\n')
      const now = body.split('\n')
      const changed: string[] = []
      for (let i = 0; i < Math.max(was.length, now.length); i++) {
        if (was[i] === now[i]) continue
        changed.push(`    - ${was[i] ?? '(absent)'}`)
        changed.push(`    + ${now[i] ?? '(absent)'}`)
        if (changed.length >= 20) break
      }
      console.log(`  ✗  ${rel(outPath)} does not match the boundary\n`)
      console.log(changed.join('\n'))
      if (changed.length >= 20) console.log('    …')
      console.log()
      console.log('  What a thrown value becomes changed. Run `junction errors` and review the diff before committing.')
      console.log()
      process.exit(1)
    }
  } else {
    writeFileSync(outPath, body, 'utf8')
    console.log(`  ✓  ${rel(outPath)}`)
  }
}
