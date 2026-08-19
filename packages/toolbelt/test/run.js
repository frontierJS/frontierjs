#!/usr/bin/env bun
/*
 * run.js — the @frontierjs/toolbelt test driver.
 *
 * One file, no dependencies, runs under bun or node. Every export here is a
 * pure function, so there is nothing to start, nothing to mock and nothing
 * to tear down — a harness heavier than this would be testing itself.
 *
 *   bun run test          all specs
 *   bun run test glow     only specs whose filename matches
 */

import { readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))

const results = []
let current = ''

// A spec body may be async — the /hooks kit is a pipeline of awaited calls, and
// a returned promise nobody awaits is a rejection that reports as a PASS.
const pending = []

globalThis.test = function (name, fn) {
  const file = current
  const failed = (e) => results.push({ file, name, ok: false, error: (e && e.message) || String(e) })
  let out
  try {
    out = fn()
  } catch (e) {
    failed(e)
    return
  }
  if (out && typeof out.then === 'function') {
    pending.push(out.then(() => results.push({ file, name, ok: true }), failed))
    return
  }
  results.push({ file, name, ok: true })
}

globalThis.assert = {
  ok(v, msg) {
    if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v))
  },
  equal(a, b, msg) {
    if (a !== b) {
      throw new Error(
        (msg ? msg + '\n      ' : '') + 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)
      )
    }
  },
  // The first kit here that REFUSES rather than answering. Every other export is
  // total, so this had no reason to exist until /history: an occurrence key that
  // silently accepted a missing part would become a jobs-table primary key every
  // fire of a job shares, so the refusals are the behaviour under test and a
  // spec has to be able to name one.
  throws(fn, pattern, msg) {
    let threw = null
    try { fn() } catch (e) { threw = e }
    if (!threw) throw new Error((msg ? msg + '\n      ' : '') + 'expected a throw, got none')
    if (pattern && !pattern.test(String(threw.message))) {
      throw new Error(
        (msg ? msg + '\n      ' : '') + 'expected a message matching ' + pattern +
        '\n      got      ' + JSON.stringify(threw.message)
      )
    }
  },
  // /signature is the first kit that answers a REASON rather than a boolean —
  // a clock 40 seconds out and a wrong secret are the same refusal to a caller
  // and completely different problems to whoever is fixing it. A spec asserting
  // only `ok === false` would pass against a verifier that refused everything
  // for one reason, which is the failure this kit is most likely to have.
  match(value, pattern, msg) {
    if (!pattern.test(String(value))) {
      throw new Error(
        (msg ? msg + '\n      ' : '') + 'expected a value matching ' + pattern +
        '\n      got      ' + JSON.stringify(value)
      )
    }
  },
  // A kit that answers an object needs this, and JSON is enough of a comparison
  // for one: every value these kits produce is JSON-shaped, and key ORDER is
  // meaningful in some of them — a directive table read in a different order is
  // a different table.
  deepEqual(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
    if (x !== y) {
      throw new Error((msg ? msg + '\n      ' : '') + 'expected ' + y + '\n      got      ' + x)
    }
  },
}

let specs = readdirSync(join(here, 'specs'))
  .filter((f) => f.endsWith('.spec.js'))
  .sort()

if (filters.length) specs = specs.filter((f) => filters.some((x) => f.includes(x)))

for (const f of specs) {
  current = basename(f, '.spec.js')
  await import(join(here, 'specs', f))
}

await Promise.all(pending)

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

const byFile = new Map()
for (const r of results) {
  if (!byFile.has(r.file)) byFile.set(r.file, [])
  byFile.get(r.file).push(r)
}

console.log('')
for (const [file, rows] of byFile) {
  const bad = rows.filter((r) => !r.ok).length
  console.log(`${bad ? red('✗') : green('✓')} ${file} ${dim(`(${rows.length - bad}/${rows.length})`)}`)
  for (const r of rows) {
    if (!r.ok) console.log(`    ${red('✗')} ${r.name}\n      ${r.error}`)
  }
}

const failures = results.filter((r) => !r.ok)
console.log('')
console.log(
  failures.length
    ? red(`${failures.length} failing`) + dim(`, ${results.length - failures.length} passing`)
    : green(`${results.length} passing`)
)
console.log('')

process.exit(failures.length ? 1 : 0)
