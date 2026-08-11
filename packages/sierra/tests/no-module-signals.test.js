/**
 * tests/no-module-signals.test.js
 *
 * **Sierra exports no module-level signal, and that is the whole reason it hands
 * the Mesa compiler no `externalSignals` map.**
 *
 * It used to export ten of them — `activeRoute`, `params`, `page`, `connected`,
 * `reconnecting`, `theme` and more — and a bare template read of one is only
 * reactive if the name appears in a map held BY THE CONSUMING BUILD, in another
 * package, by hand. Omitting an entry failed in the worst possible way:
 *
 *   {connected ? 'ws connected' : 'ws offline'}
 *
 * compiled to a bare object reference. A signal object is always truthy, so the
 * badge read "ws connected" with the API stopped and across a page reload. No
 * error, no warning — the expression read nothing reactive, so it was hoisted as
 * static. `connected` and `reconnecting` were the two that were missing.
 *
 * The state is plain objects now (`page`, `status`, `theme`), made reactive per
 * component with a `$:` path watch, and `mesa-plugin.js` passes
 * `externalReactivityHints: 'strict'` so an uncovered read is reported. Both
 * halves depend on there being nothing left to declare. A new
 * `export const x = signal(...)` would be reactive nowhere and silent
 * everywhere, which is why this asserts the absence rather than a list.
 *
 * `signal()` itself is not gone: `presence(channelId)` returns one from a
 * function call, which no map could ever have described anyway.
 */

import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../src')

/** Walk src/ and collect `export const <name> = signal(...)` / `= createSignal(...)`. */
function moduleLevelSignals() {
  const found = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!p.endsWith('.js')) continue

      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/^export const (\w+)\s*=\s*(signal|createSignal)\(/gm)) {
        found.push({ file: relative(SRC, p).replace(/\\/g, '/'), name: m[1] })
      }
    }
  }
  walk(SRC)
  return found
}

describe('no module-level signals', () => {
  test('the walker actually reads the source', () => {
    // Guard against a regex that silently matches nothing: `signal(` must still
    // appear somewhere, or this suite passes for the wrong reason forever.
    const seen = readFileSync(resolve(SRC, 'presence/index.js'), 'utf8')
    expect(seen).toMatch(/signal\(/)
  })

  test('src/ exports none', () => {
    const found = moduleLevelSignals()
    expect(
      found.map(f => `${f.name} (src/${f.file})`),
      'a module-level signal is reactive nowhere: template reads of it need an ' +
      'externalSignals entry in the consuming build, which Sierra no longer ships. ' +
      'Make it a plain object and let components watch it with `$:`.'
    ).toEqual([])
  })
})

describe('the plugin declares no signals', () => {
  const plugin = readFileSync(resolve(SRC, 'build/mesa-plugin.js'), 'utf8')

  test('no hardcoded externalSignals map', () => {
    expect(plugin).not.toMatch(/externalSignals:\s*\{/)
  })

  test('strict reactivity hints are on', () => {
    expect(plugin).toContain("externalReactivityHints: 'strict'")
  })
})
