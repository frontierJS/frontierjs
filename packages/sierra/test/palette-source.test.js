/**
 * test/palette-source.test.js — paletteSource(client, { models, link }): the
 * hits junction's `search` service answers, as `CommandPalette` rows
 * (`FJS-D970`, `IDEAS/shipped/cross-model-search.md` 3.1).
 *
 * Against a REAL junction client and a REAL hosted `searchService`
 * (`fixtures/palette-source-server.ts`), because the row is built from what
 * the wire carries — a hit read off a hand-written array would pass while the
 * envelope, the comma-joined `models` and the 400 all went unread. The router
 * is mocked so an `action` can be followed to the path it goes to.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../src/router/index.js', () => ({ goto: vi.fn(async () => {}) }))

const { goto }          = await import('../src/router/index.js')
const { paletteSource } = await import('../src/resource/palette-source.js')
const { createJunctionClient } = await import('@frontierjs/junction/client')

const PKG  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 7928
const API  = `http://127.0.0.1:${PORT}`

let server

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`[palette-source] nothing answered ${url} within ${ms}ms`)
}

beforeAll(async () => {
  server = spawn('bun', ['test/fixtures/palette-source-server.ts', String(PORT)], { cwd: PKG, stdio: 'ignore' })
  await waitFor(`${API}/ping`)
}, 30000)

afterAll(() => { server?.kill() })

/** A socket that never opens, so every call takes the client's HTTP path. */
class DeadSocket {
  static OPEN = 1
  constructor() { this.readyState = 0 }
  send() {}
  close() { this.readyState = 3 }
}

beforeEach(() => {
  globalThis.WebSocket = DeadSocket
  goto.mockClear()
})

afterEach(() => { delete globalThis.WebSocket })

function client() {
  const c = createJunctionClient({ url: API })
  c.setToken('ana-token')
  return c
}

describe('paletteSource', () => {

  test('one call answers every mounted model as rows: group, label, sub, a unique id', async () => {
    const rows = await paletteSource(client())('quasar')
    const byGroup = Object.fromEntries(rows.map(r => [r.group, r]))
    expect(Object.keys(byGroup).sort()).toEqual(['Issues', 'Persons', 'Product Variants'])
    expect(byGroup.Issues).toMatchObject({ id: 'search:issue:i/1', label: 'quasar lattice', sub: 'ENG-1' })
    expect(byGroup['Product Variants']).toMatchObject({ id: 'search:productVariant:7', label: 'quasar blue' })
    expect(rows.every(r => typeof r.action === 'function')).toBe(true)
  })

  // `fli scaffold` writes the route directory as the service name and the
  // scanner serves it lowercased, so a two-word or irregular model is where a
  // hand-composed plural goes wrong.
  test('a row goes to the scaffolded route by default, the id encoded as one segment', async () => {
    const rows = await paletteSource(client())('quasar')
    for (const r of rows) await r.action()
    expect(goto.mock.calls.map(c => c[0]).sort()).toEqual(['/issues/i%2F1', '/persons/3', '/productvariants/7'])
  })

  test('a link override wins for its model, and may answer a promise', async () => {
    const rows = await paletteSource(client(), {
      models: ['issue', 'productVariant'],
      link:   { issue: async hit => `/board/${hit.sub}` },
    })('quasar')
    for (const r of rows) await r.action()
    expect(goto.mock.calls.map(c => c[0]).sort()).toEqual(['/board/ENG-1', '/productvariants/7'])
  })

  test('models narrows the mount', async () => {
    const rows = await paletteSource(client(), { models: ['productVariant'] })('quasar')
    expect(rows.map(r => r.id)).toEqual(['search:productVariant:7'])
  })

  test('a model outside the mount is the service\'s refusal, by name', async () => {
    const err = await paletteSource(client(), { models: ['secret'] })('quasar').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain(`'secret' is not in this search`)
  })

  test('an empty box answers no rows', async () => {
    expect(await paletteSource(client())('  ')).toEqual([])
  })

  test('a link naming a model outside models is refused at construction', () => {
    expect(() => paletteSource(client(), { models: ['issue'], link: { isue: () => '/x' } }))
      .toThrow(`link names 'isue', which is not in models (issue)`)
  })

  test('no client is refused by name', () => {
    expect(() => paletteSource(null)).toThrow('takes a junction client')
  })
})
