/**
 * tests/external-signals.test.js
 *
 * Sierra exports module-level signals — `activeRoute`, `connected`, `theme` and
 * so on. In a Mesa template a bare read of one of those has to be rewritten to
 * `name.get()` or it isn't reactive, and that rewrite is driven by the
 * `externalSignals` map that `mesa-plugin.js` hands the compiler.
 *
 * The map is hand-maintained, and omitting an entry fails silently in the worst
 * possible way. `connected` and `reconnecting` were missing, so:
 *
 *   {connected ? 'ws connected' : 'ws offline'}
 *
 * compiled to a bare object reference rather than `connected.get()`. A signal
 * object is always truthy, so the badge read "ws connected" permanently — with
 * the API stopped, and across a page reload. No error, no warning; the
 * expression was simply hoisted as static because it read nothing reactive.
 *
 * This test makes the two sides agree: every module-level signal Sierra exports
 * must be declared for its subpath, under both the scoped and bare specifier.
 */

import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../src')

/** Walk src/ and collect `export const <name> = signal(...)` per file. */
function exportedSignals() {
  const found = {}   // subpath → Set<name>

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!p.endsWith('.js')) continue

      const names = [...readFileSync(p, 'utf8')
        .matchAll(/^export const (\w+)\s*=\s*signal\(/gm)].map(m => m[1])
      if (!names.length) continue

      // src/router/index.js → 'router'; src/theme/index.js → 'theme'
      const rel = relative(SRC, p).replace(/\\/g, '/')
      const subpath = rel.replace(/\/index\.js$/, '').replace(/\.js$/, '')
      found[subpath] ??= new Set()
      for (const n of names) found[subpath].add(n)
    }
  }
  walk(SRC)
  return found
}

/** Parse the externalSignals map out of mesa-plugin.js. */
function declaredSignals() {
  const src = readFileSync(resolve(SRC, 'build/mesa-plugin.js'), 'utf8')
  const start = src.indexOf('externalSignals: {')
  expect(start).toBeGreaterThan(-1)

  const declared = {}
  const region = src.slice(start, src.indexOf('...(mesaOptions.externalSignals', start))
  for (const m of region.matchAll(/'((?:@frontierjs\/)?sierra\/[\w/]+)':\s*\[([^\]]*)\]/g)) {
    const names = [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1])
    declared[m[1]] = new Set(names)
  }
  return declared
}

describe('externalSignals covers every exported signal', () => {
  const exported = exportedSignals()
  const declared = declaredSignals()

  test('the fixture actually found signals', () => {
    // Guard against a regex that silently matches nothing.
    expect(Object.keys(exported).length).toBeGreaterThan(0)
    expect(Object.keys(declared).length).toBeGreaterThan(0)
  })

  for (const [subpath, names] of Object.entries(exportedSignals())) {
    for (const spec of [`@frontierjs/sierra/${subpath}`, `sierra/${subpath}`]) {
      test(`${spec} declares all of: ${[...names].join(', ')}`, () => {
        const got = declared[spec]
        expect(got, `no externalSignals entry for '${spec}'`).toBeDefined()
        for (const n of names) {
          expect([...got], `'${n}' exported from src/${subpath} but not declared`).toContain(n)
        }
      })
    }
  }
})

describe('externalSignals does not declare things that no longer exist', () => {
  const exported = exportedSignals()
  const declared = declaredSignals()

  // `node` is a deliberate alias for activeRoute rather than its own signal.
  const ALIASES = new Set(['node'])

  for (const [spec, names] of Object.entries(declared)) {
    test(`${spec} declares only real exports`, () => {
      const subpath = spec.replace(/^(@frontierjs\/)?sierra\//, '')
      const real = exported[subpath] ?? new Set()
      for (const n of names) {
        if (ALIASES.has(n)) continue
        expect([...real], `'${n}' declared for ${spec} but not exported`).toContain(n)
      }
    })
  }
})
