// build-imports.test.js — importing the app's own modules at build time.
//
// `FJS-551`: a module whose top-level `await` throws reports its real error
// exactly once, and every import after that is a TDZ naming whichever binding
// the next reader touched. A static build imports the app's db from several
// places, so what it usually holds is the second kind — and both of Sierra's
// doors used to `catch { return null }`, which threw the one true error away.
//
// The mechanism is the runtime's and cannot be fixed here. What is asserted is
// that the build KEEPS the truth: the first real failure is recorded, a module
// that failed is not imported a second time to manufacture a TDZ, and a TDZ
// that reaches a message carries the recorded cause with it.

import { describe, test, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join }   from 'path'
import { tmpdir } from 'os'

import { importAppModule, firstRealFailure, beginBuildImports } from '../src/build/app-import.js'
import { explainModuleInitFailure }                             from '../src/build/warnings.js'

const dir = mkdtempSync(join(tmpdir(), 'sierra-import-'))
let n = 0

/** A module file with a fresh name, so no two cases share a runtime cache entry. */
const mod = (body) => {
  const file = join(dir, `m${n++}.mjs`)
  writeFileSync(file, body)
  return file
}

beforeEach(() => beginBuildImports())

describe('importAppModule', () => {
  test('separates a module that is not there from one that threw', async () => {
    const missing = await importAppModule(join(dir, 'nope.mjs'))
    expect(missing).toEqual({ ok: false, reason: 'missing' })

    const broken = await importAppModule(mod(`throw new Error('the real one')\n`))
    expect(broken.ok).toBe(false)
    expect(broken.reason).toBe('threw')
    expect(broken.error.message).toBe('the real one')
  })

  test('a module that loads comes back whole', async () => {
    const res = await importAppModule(mod(`export const db = { $tapQuery() {} }\n`))
    expect(res.ok).toBe(true)
    expect(typeof res.module.db.$tapQuery).toBe('function')
  })

  // The heart of it. Re-importing a failed module is what MAKES the lie, so the
  // second reader is handed the first failure instead of a fresh half-built
  // namespace.
  test('a module that failed once answers with the same error, not a TDZ', async () => {
    const file = mod(
      `const CONST = 'x'\n` +
      `async function open() { throw new Error('schema.lite has errors: line 837') }\n` +
      `export const db = await open()\n` +
      `export const other = CONST\n`)

    const first  = await importAppModule(file)
    const second = await importAppModule(file)

    expect(first.error.message).toMatch(/line 837/)
    expect(second.error).toBe(first.error)
    expect(second.repeated).toBe(true)
    expect(second.error.message).not.toMatch(/before initialization/)
  })

  // The negative control, and it has to be spawned.
  //
  // Vitest imports through Vite's own module runner, which RE-THROWS the
  // original error on a second import — so under this suite the bug does not
  // reproduce and the recording above would look like belt with no trousers.
  // The static build runs under `bun --bun vite`, whose native loader is where
  // a failed TLA module hands back a half-built namespace. So the control is
  // measured in that runtime: if this ever stops being true, the recording has
  // stopped being load-bearing, and this is the test that should say so.
  test('the runtime really does lose it — the negative control', () => {
    const probe = `
      import { writeFileSync, mkdtempSync } from 'node:fs'
      import { join } from 'node:path'
      import { tmpdir } from 'node:os'
      const f = join(mkdtempSync(join(tmpdir(), 'tla-')), 'boom.mjs')
      writeFileSync(f, "const C = 'x'\\nasync function open() { throw new Error('the real one') }\\nexport const db = await open()\\nexport const other = C\\n")
      const said = []
      // Reading a binding is what fires the TDZ — the import itself resolves.
      for (let i = 0; i < 2; i++) { try { const m = await import(f); said.push('read:' + m.other) } catch (e) { said.push(e.message) } }
      console.log(JSON.stringify(said))
    `

    let out
    try { out = execFileSync('bun', ['-e', probe], { encoding: 'utf8' }) }
    catch (err) {
      if (err?.code === 'ENOENT') return console.warn('  [skip] bun is not on PATH — the TLA control needs the build\'s own loader')
      throw err
    }

    const said = JSON.parse(out.trim().split('\n').pop())
    expect(said[0]).toBe('the real one')
    expect(said[1]).toMatch(/before initialization/)
  })
})

describe('firstRealFailure', () => {
  test('is the earliest failure that was not itself a TDZ', async () => {
    expect(firstRealFailure()).toBe(null)

    await importAppModule(mod(`throw new Error('the cause')\n`))
    await importAppModule(mod(`throw new Error('Cannot access "x" before initialization.')\n`))

    expect(firstRealFailure().error.message).toBe('the cause')
  })

  test('a TDZ alone leaves nothing recorded — there is no cause to offer', async () => {
    await importAppModule(mod(`throw new Error('Cannot access "x" before initialization.')\n`))
    expect(firstRealFailure()).toBe(null)
  })

  test('a build forgets the previous build', async () => {
    await importAppModule(mod(`throw new Error('the cause')\n`))
    expect(firstRealFailure()).not.toBe(null)
    beginBuildImports()
    expect(firstRealFailure()).toBe(null)
  })
})

describe('explainModuleInitFailure', () => {
  test('a message that is not a TDZ is left exactly as it was', () => {
    expect(explainModuleInitFailure('plain trouble', 'x.js')).toBe('plain trouble')
  })

  test('with a cause recorded, it prints the cause instead of the advice', async () => {
    await importAppModule(mod(`throw new Error('schema.lite has errors: line 837')\n`))
    const out = explainModuleInitFailure("Cannot access 'db' before initialization.", 'db.ts')

    expect(out).toMatch(/This is not the real error/)
    expect(out).toMatch(/schema.lite has errors: line 837/)
    expect(out).not.toMatch(/import it once on its own/)
  })

  test('with nothing recorded, it says how to get the cause', () => {
    const out = explainModuleInitFailure("Cannot access 'db' before initialization.", 'db.ts')
    expect(out).toMatch(/import it once on its own/)
  })
})

// ─── the prerender is bounded ─────────────────────────────────────────────────
//
// `FJS-549` / `FJS-550`: a prerender that hangs writes nothing and says
// nothing, forever. The bound does not diagnose either cause — it converts
// silence into a message naming the route and the phase, which is the whole
// difference between a bug that can be reported and one that cannot.

describe('prerenderRoutes — a route that never finishes', () => {
  test('stops waiting and names the route, the phase and the known causes', async () => {
    const { prerenderRoutes } = await import('../src/build/prerender.js')
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan }            = await import('../src/scanner/index.js')
    const { mkdirSync, writeFileSync } = await import('fs')
    const { resolve }         = await import('path')

    const root = mkdtempSync(join(tmpdir(), 'sierra-hang-'))
    mkdirSync(resolve(root, 'src/routes/slow'), { recursive: true })
    writeFileSync(resolve(root, 'src/routes/slow/index.mesa'), `---\nrender: static\n---\n<h1>hi</h1>\n`)
    writeFileSync(resolve(root, 'src/routes/slow/index.meta.js'),
      `export async function load() { await new Promise(() => {}) }\n`)

    const tree = await scan('src/routes', { cwd: root })
    const out  = await prerenderRoutes({
      tree, root,
      outDir: mkdtempSync(join(tmpdir(), 'sierra-hang-out-')),
      renderComponent,
      timeout: 150,
    })

    const reason = out.skipped.map(s => s.reason).join('\n')
    expect(reason).toMatch(/load\(\)/)
    expect(reason).toMatch(/did not finish within/)
    // The build treats `load() threw` as fatal, so this reaches a person.
    expect(reason).toMatch(/an island marker inside a LAYOUT/)
  }, 30_000)

  test('a route that finishes is untouched by the clock', async () => {
    const { prerenderRoutes } = await import('../src/build/prerender.js')
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan }            = await import('../src/scanner/index.js')
    const { mkdirSync, writeFileSync } = await import('fs')
    const { resolve }         = await import('path')

    const root = mkdtempSync(join(tmpdir(), 'sierra-ok-'))
    mkdirSync(resolve(root, 'src/routes'), { recursive: true })
    writeFileSync(resolve(root, 'src/routes/index.mesa'), `---\nrender: static\n---\n<h1>hi</h1>\n`)

    const out = await prerenderRoutes({
      tree: await scan('src/routes', { cwd: root }),
      root,
      outDir: mkdtempSync(join(tmpdir(), 'sierra-ok-out-')),
      renderComponent,
      timeout: 15_000,
    })
    expect(out.written.length).toBe(1)
    expect(out.skipped).toEqual([])
  }, 30_000)
})

// ─── the shape that used to hang ──────────────────────────────────────────────
//
// `FJS-549` / `FJS-550`, which were one failure wearing two descriptions: a
// LAYOUT holding an island, and that island's graph reaching
// `@frontierjs/sierra/junction` through a store. It hung with nothing written
// and nothing said. Neither reproduces now — most likely closed by the route
// table dropping a companion's loaders instead of importing them, which is what
// used to pull the app's own server modules into the browser graph — and this
// is what says so on every run rather than once, in a shell, by hand.
//
// The prerender's own clock is what makes a return of it a failure: a stall
// here fails with the route and the phase named instead of never finishing.

describe('a layout that holds an island reaching junction', () => {
  test('prerenders every route rather than stopping on the first', async () => {
    const { prerenderRoutes } = await import('../src/build/prerender.js')
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan }            = await import('../src/scanner/index.js')
    const { fileURLToPath }   = await import('url')
    const { dirname, resolve } = await import('path')

    const here = dirname(fileURLToPath(import.meta.url))
    const root = resolve(here, 'fixtures/layout-island')

    const out = await prerenderRoutes({
      tree: await scan('src/routes', { cwd: root }),
      root,
      outDir: mkdtempSync(join(tmpdir(), 'sierra-layout-island-')),
      renderComponent,
      islands: true,
      timeout: 20_000,
    })

    expect(out.skipped).toEqual([])
    expect(out.written.length).toBe(2)
    // The island is in the LAYOUT, so it is on every page rather than one.
    expect(out.urls.sort()).toEqual(['/', '/deep/'])
  }, 60_000)
})
