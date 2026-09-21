// health-target.test.js — where an app answers health, and whether it does.
//
// The case this exists for: `fli new` declares the plugin in
// api/config/junction.config.js, and both readers used to grep only the API
// source — so the scaffold warned, in its own output, about the app it had
// just written.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync }              from 'fs'
import { resolve, dirname }                              from 'path'
import { fileURLToPath }                                 from 'url'

import { resolveHealthPath, declaresHealth, configDeclaresHealth } from '../core/health-target.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

let TMP
beforeEach(() => {
  TMP = resolve(ROOT, `.tmp-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(resolve(TMP, 'api/src'),    { recursive: true })
  mkdirSync(resolve(TMP, 'api/config'), { recursive: true })
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

const write = (rel, body) => writeFileSync(resolve(TMP, rel), body, 'utf8')

const appTs    = (extra = '') => `import { createApp } from '@frontierjs/junction'\nconst app = createApp({ config: { port: 3000, apiPrefix: '/api' } })\n${extra}\nexport default app\n`
const configJs = (plugins) => `export default {\n  app: { name: 'x', apiPrefix: '/api' },\n  plugins: ${plugins},\n}\n`

// ─── resolveHealthPath ───────────────────────────────────────────────────────

describe('resolveHealthPath', () => {
  test('app.ts wins over the config — createApp merges opts over the file', () => {
    write('api/src/app.ts', appTs())
    write('api/config/junction.config.js', `export default { app: { apiPrefix: '/other' } }\n`)
    const h = resolveHealthPath(TMP)
    expect(h.path).toBe('/api/health')
    expect(h.prefix).toBe('/api')
  })

  test('falls back to the config when app.ts states no prefix', () => {
    write('api/src/app.ts', `const app = createApp({ config: { port: 3000 } })\n`)
    write('api/config/junction.config.js', configJs('{ health: true }'))
    expect(resolveHealthPath(TMP).path).toBe('/api/health')
  })

  test('no prefix anywhere is a bare /health', () => {
    write('api/src/app.ts', `const app = createApp({ config: { port: 3000 } })\n`)
    expect(resolveHealthPath(TMP)).toEqual({ path: '/health', from: null, prefix: '' })
  })
})

// ─── configDeclaresHealth ────────────────────────────────────────────────────

describe('configDeclaresHealth', () => {
  test('true, and an options object, both declare it', () => {
    expect(configDeclaresHealth(configJs('{ health: true, manifest: true }'))).toBe(true)
    expect(configDeclaresHealth(configJs(`{ health: { path: '/_internal' }, manifest: true }`))).toBe(true)
  })

  test('false does not — a key written to turn it OFF reads the same to a substring search', () => {
    expect(configDeclaresHealth(configJs('{ health: false, manifest: true }'))).toBe(false)
  })

  test('an options object does not close the block early', () => {
    // A lazy `[^}]*` stops at the INNER brace, so `manifest` lands outside the
    // block and every option shape grades as absent.
    expect(configDeclaresHealth(configJs(`{ manifest: true, health: { path: '/x' } }`))).toBe(true)
  })

  test('a comment mentioning health is not a declaration', () => {
    expect(configDeclaresHealth(`export default {\n  // health serves /health and /metrics\n  plugins: { manifest: true },\n}\n`)).toBe(false)
  })

  test('no plugins block at all', () => {
    expect(configDeclaresHealth(`export default { services: { dir: './api/src/services' } }\n`)).toBe(false)
  })
})

// ─── declaresHealth ──────────────────────────────────────────────────────────

describe('declaresHealth', () => {
  test('the scaffold shape — declared in the config, nothing in the source', () => {
    write('api/src/app.ts', appTs())
    write('api/config/junction.config.js', configJs('{ health: true, manifest: true }'))
    const d = declaresHealth(TMP, '/api/health')
    expect(d.declared).toBe(true)
    expect(d.sources).toEqual([{ how: 'config', file: 'api/config/junction.config.js' }])
    expect(d.clash).toBe(false)
  })

  test('configured by hand in the API source', () => {
    write('api/src/app.ts', appTs('app.configure(healthPlugin())'))
    const d = declaresHealth(TMP, '/api/health')
    expect(d.declared).toBe(true)
    expect(d.sources[0].how).toBe('plugin-call')
  })

  test('both is a clash — start() refuses it by name', () => {
    write('api/src/app.ts', appTs('app.configure(healthPlugin())'))
    write('api/config/junction.config.js', configJs('{ health: true }'))
    expect(declaresHealth(TMP, '/api/health').clash).toBe(true)
  })

  test('a hand-written route is graded against the CONFIGURED path', () => {
    write('api/src/app.ts', `app.get('/healthz', (ctx) => ctx.json({ ok: true }))\n`)
    expect(declaresHealth(TMP, '/healthz').declared).toBe(true)
    expect(declaresHealth(TMP, '/api/health').declared).toBe(false)
  })

  test('the plugin cannot answer a path that does not end in /health', () => {
    write('api/src/app.ts', appTs('app.configure(healthPlugin())'))
    write('api/config/junction.config.js', configJs('{ health: true }'))
    expect(declaresHealth(TMP, '/status').declared).toBe(false)
  })

  test('nothing anywhere', () => {
    write('api/src/app.ts', appTs())
    write('api/config/junction.config.js', configJs('{ manifest: true }'))
    const d = declaresHealth(TMP, '/api/health')
    expect(d.declared).toBe(false)
    expect(d.sources).toEqual([])
  })
})
