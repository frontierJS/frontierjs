// engine-seam.test.ts — the seam between Litestone and whatever runs its SQL
// (`core/engine.js`, `IDEAS/homestead.md` phase 4, `FJS-D305`).
//
// Three questions, and the third is the only one that could not be faked.
//
// **How many files know what SQL engine this is.** One. The count is the whole
// value of the seam: a tenth `new Database()` added anywhere else works
// perfectly on Bun and is invisible until somebody builds Litestone for a
// browser, at which point it is a resolution error in a bundle with no line
// number that means anything. Graded on IMPORTS rather than on the string,
// because `bun:sqlite` appears in half a dozen comments that explain a
// behavior and should keep saying so.
//
// **What an engine has to declare.** `sync: true`, refused by name at
// REGISTRATION — the cheapest moment. Litestone's internals call `.get()` and
// `.all()` from roughly 270 sites without awaiting, so an engine answering
// promises hands back a pending Promise where a row belongs. It reads as an
// object, it is truthy, and nothing throws: a filter simply stops filtering.
// This is not a hypothetical shape — it is `wa-sqlite`'s, whose `step` is
// `async function` in both its builds, and it is why the browser engine is
// SQLite's own synchronous `oo1` API over `opfs-sahpool` instead.
//
// **Whether the seam is actually the whole of the coupling.** A test that
// registers a stub engine proves only that the stub was called. So this one
// spawns NODE — a runtime with no `Bun` global and no `bun:sqlite` — under
// `--conditions=browser`, which is how `#sql-engine` resolves to nothing and
// `#host` resolves to the browser's paths, refusals and async-context shim,
// registers `node:sqlite` from the outside, and drives a real client through
// relations, includes, groupBy, aggregates, a transaction, a soft delete and a
// gate refusal. If some other Bun-ism is load-bearing in the query path, that
// is where it surfaces, and it surfaces as a failure naming the call.

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative }                      from 'path'
import { setEngine, clearEngine, currentEngine, openDatabase } from '../src/core/engine.js'

const SRC     = join(import.meta.dir, '../src')
const FIXTURE = join(import.meta.dir, 'fixtures/second-engine.mjs')

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

describe('one file knows what the engine is', () => {
  // An import, not a mention. `/^import .* from 'bun:sqlite'/` and the dynamic
  // form both count; a comment naming the module does not.
  const importers = jsFiles(SRC)
    .filter(p => /(^|\n)\s*(import[^\n]*from\s*|await\s+import\()\s*['"]bun:sqlite['"]/.test(readFileSync(p, 'utf8')))
    .map(p => relative(SRC, p))

  it('is exactly src/engines/bun-sqlite.js and nothing else', () => {
    expect(importers).toEqual(['engines/bun-sqlite.js'])
  })

  // The other half of the same rule. `new Database()` outside the engine file
  // is the shape this seam exists to stop, and it does not have to import
  // anything to be written — a file that already had the symbol in scope would
  // pass the check above.
  it('nothing outside it constructs a Database', () => {
    const offenders = jsFiles(SRC)
      .filter(p => !p.endsWith('engines/bun-sqlite.js'))
      .filter(p => readFileSync(p, 'utf8').split('\n')
        .some(l => /new Database\s*\(/.test(l) && !l.trimStart().startsWith('//') && !l.includes('* ')))
      .map(p => relative(SRC, p))
    expect(offenders).toEqual([])
  })
})

describe('what an engine must declare', () => {
  const restore = () => { const e = currentEngine(); return () => { clearEngine(); if (e) setEngine(e) } }

  it('the bun engine is registered by the subpath import, with no side-effect line anywhere', () => {
    expect(currentEngine()?.name).toBe('bun:sqlite')
  })

  it('refuses an asynchronous engine by name, at registration', () => {
    const put = restore()
    try {
      expect(() => setEngine({ name: 'wa-sqlite', open: async () => ({}) } as any))
        .toThrow(/wa-sqlite.*does not declare sync/s)
    } finally { put() }
  })

  it('refuses an engine that will not say what it is', () => {
    const put = restore()
    try {
      expect(() => setEngine({ sync: true, open: () => ({}) } as any)).toThrow(/name itself/)
    } finally { put() }
  })

  it('refuses one with no open()', () => {
    const put = restore()
    try {
      expect(() => setEngine({ name: 'x', sync: true } as any)).toThrow(/no open\(\)/)
    } finally { put() }
  })

  it('says what to do when nothing is registered', () => {
    const put = restore()
    clearEngine()
    try {
      expect(() => openDatabase(':memory:')).toThrow(/no SQL engine is registered[\s\S]*setEngine/)
    } finally { put() }
  })
})

// ─── The conformance drive ────────────────────────────────────────────────

describe('a second engine, on a runtime that is not Bun', () => {
  // node:sqlite landed in Node 22.5 and is still flagged experimental. An
  // older node is a NAMED skip rather than a quiet pass: a conformance drive
  // that reports nothing when it ran nothing is the failure this whole file is
  // about.
  const probe = Bun.spawnSync(['node', '-e', "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))"])
  const available = probe.exitCode === 0

  it.skipIf(!available)('runs the real client end to end against node:sqlite', () => {
    const run = Bun.spawnSync(['node', '--conditions=browser', '--no-warnings', FIXTURE], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const out = run.stdout.toString() + run.stderr.toString()
    expect(out).not.toContain('FAIL')
    expect(run.exitCode).toBe(0)

    // Named individually, because `not.toContain('FAIL')` also passes against
    // a fixture that printed nothing at all.
    for (const step of [
      'engine-is-not-bun', 'create', 'relation-include', 'groupBy', 'aggregate',
      'transaction', 'softDelete', 'orderBy-limit', 'gate-refusal',
    ]) expect(out).toContain(`OK ${step}`)
  })

  it('reports the skip rather than passing silently', () => {
    if (!available) console.warn('[skip] node:sqlite is unavailable — the second-engine drive did not run')
    expect(typeof available).toBe('boolean')
  })
})

// ─── and nothing in that graph reaches a node builtin by its own name ────────
//
// `#host` exists so the browser half can answer, refuse or shim every host
// facility the client's graph touches — but a module that writes `from 'fs'`
// bypasses it silently. It bypasses it silently on NODE, which is why the drive
// above cannot see it: `--conditions=browser` changes how `#host` resolves and
// changes nothing about `fs`, which node has either way.
//
// A BUNDLER is where it bites, and it bites at the worst possible moment. Vite
// replaces a bare node builtin with a proxy that throws on the first property
// ACCESS — so `import { statSync } from 'fs'` throws when the module is merely
// imported, before a line of it runs. Three modules did it, the worker died on
// import, and the page reported only that it had fallen back to the list cache
// — which is what the feature working also looks like (`FJS-1179`).
//
// Walked from the two browser entries rather than declared, so a module that
// joins the graph later is graded the day it joins.
describe('the browser graph', () => {
  const BUILTINS = new Set([
    'fs', 'path', 'os', 'crypto', 'url', 'util', 'module', 'stream', 'zlib',
    'child_process', 'worker_threads', 'perf_hooks', 'async_hooks', 'buffer',
    'events', 'net', 'tls', 'http', 'https', 'dns', 'readline', 'tty', 'vm',
  ])
  const isBuiltin = (spec: string) =>
    spec.startsWith('node:') || spec.startsWith('bun:') || BUILTINS.has(spec)

  // `#host` and `#sql-engine` are the seam itself: resolved by CONDITION, so
  // the browser build never sees the node file behind them.
  const CONDITIONAL = new Set(['#host', '#sql-engine'])

  const specifiersIn = (source: string): string[] => {
    const out: string[] = []
    for (const m of source.matchAll(/from\s*['"]([^'"]+)['"]/g))       out.push(m[1]!)
    for (const m of source.matchAll(/import\s+['"]([^'"]+)['"]/g))     out.push(m[1]!)
    for (const m of source.matchAll(/import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]!)
    return out
  }

  it('reaches every host facility through #host, never by the builtin name', () => {
    const seen = new Set<string>()
    const offenders: string[] = []

    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      let source: string
      try { source = readFileSync(file, 'utf8') } catch { return }

      for (const spec of specifiersIn(source)) {
        if (CONDITIONAL.has(spec)) continue
        if (isBuiltin(spec)) {
          offenders.push(`${relative(SRC, file)} imports '${spec}'`)
          continue
        }
        if (!spec.startsWith('.')) continue          // a package, not our graph
        const target = join(file, '..', spec)
        walk(target)
      }
    }

    walk(join(SRC, 'browser/client.js'))
    walk(join(SRC, 'browser/worker.js'))
    walk(join(SRC, 'host/browser.js'))

    // The walk having seen nothing and the walk having found nothing are one
    // answer otherwise — a renamed entry file would report a clean graph.
    expect(seen.size).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
