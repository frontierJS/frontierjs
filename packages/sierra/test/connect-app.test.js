/**
 * test/connect-app.test.js — a Resource over ANOTHER FrontierJS app.
 *
 * `connectApp()` answers a handle, `createResource(name, { app })` takes it,
 * and the resource is then sierra's own over that app: its schema, its gate,
 * its calls. Asserted against a REAL junction client, a REAL hosted Junction
 * app and a real forward in front of it (`fixtures/connect-app-server.ts`).
 *
 * The page registers its own `Customer` with a different column, so every
 * assertion that reads the hosted schema would fail if the page's table were
 * consulted — which is the failure this exists for: a relation resolved against
 * the page names the wrong model, or none.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const HOSTED_PORT = 7926   // the hosted app, reached only through the forward
const PAGE_PORT   = 7927   // the page's own API, which forwards /hosted/h1/*
const PAGE        = `http://127.0.0.1:${PAGE_PORT}`

// ─── The servers ─────────────────────────────────────────────────────────────

let server

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`[connect-app] nothing answered ${url} within ${ms}ms`)
}

const seen      = () => fetch(`${PAGE}/__seen`).then(r => r.json())
const resetSeen = () => fetch(`${PAGE}/__seen/reset`)
const schema    = () => fetch(`${PAGE}/hosted/h1/__schema`).then(r => r.json())

beforeAll(async () => {
  server = spawn('bun', ['test/fixtures/connect-app-server.ts', String(HOSTED_PORT), String(PAGE_PORT)], {
    cwd: PKG, stdio: 'ignore',
  })
  await waitFor(`${PAGE}/ping`)
}, 30000)

afterAll(() => { server?.kill() })

// ─── Environment ─────────────────────────────────────────────────────────────

/** A socket that never opens, so every call takes the client's HTTP path. */
class DeadSocket {
  static OPEN = 1
  constructor() { this.readyState = 0 }
  send() {}
  close() { this.readyState = 3 }
}

beforeEach(() => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  globalThis.WebSocket = DeadSocket
  globalThis.window = { location: { origin: PAGE, pathname: '/', search: '' }, addEventListener() {} }
  globalThis.document = { addEventListener() {}, querySelectorAll: () => [] }
})

afterEach(() => {
  delete globalThis.localStorage
  delete globalThis.WebSocket
  delete globalThis.window
  delete globalThis.document
})

/** The page's own app: a `Customer` that is not the hosted one. */
const PAGE_DEFS = {
  Customer: {
    type: 'object', title: 'Customer',
    properties: { title: { type: 'string' } },
    required: ['title'],
    'x-gate': { read: 0, create: 0, update: 0, delete: 0 },
  },
}

async function boot({ token = null } = {}) {
  vi.resetModules()
  const J = await import('../src/resource/index.js')
  J.registerSchemas(PAGE_DEFS, ['Customer'])
  J.initJunction({ url: PAGE })
  if (token) J.getClient().setToken(token)
  return J
}

// ─── The handle ──────────────────────────────────────────────────────────────

describe('connectApp', () => {

  test('a url on the page\'s API origin is accepted, relative or absolute', async () => {
    const J = await boot()
    const s = await schema()
    expect(J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: s }).client.origin).toBe(`${PAGE}/hosted/h1`)
    expect(J.connectApp({ url: `${PAGE}/hosted/h1`, schema: s }).client.origin).toBe(`${PAGE}/hosted/h1`)
  })

  test('and one on any other origin is refused, because it would be sent the page\'s session', async () => {
    const J = await boot()
    const s = await schema()
    expect(() => J.connectApp({ url: 'https://elsewhere.test/api', schema: s }))
      .toThrow(/not this page's API origin/)
  })

  test('a handle missing a half is refused by createResource rather than falling back to the page', async () => {
    const J = await boot()
    const { client } = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })
    expect(() => J.createResource('customers', { app: { client } })).toThrow(/connectApp\(\)/)
  })
})

// ─── The schema is the hosted app's ──────────────────────────────────────────

describe('a resource over the hosted app reads that app\'s schema', () => {

  test('fields are the hosted model\'s, and the page\'s own resource still reads the page\'s', async () => {
    const J = await boot()
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })

    expect(Object.keys(J.createResource('customers', { app: hosted }).fields)).toEqual(['email'])
    expect(Object.keys(J.createResource('customers').fields)).toEqual(['title'])
  })

  test('a relation resolves against the hosted table — the page has no Order at all', async () => {
    const J = await boot()
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })
    const customers = J.createResource('customers', { app: hosted })

    expect(customers.children()).toEqual([
      { field: 'orders', model: 'Order', service: 'orders', foreignKey: 'customerId' },
    ])
    expect(J.createResource('orders', { app: hosted }).fields.customerId.references)
      .toMatchObject({ model: 'Customer', field: 'id' })
  })

  test('can() answers from the hosted gate', async () => {
    const J = await boot()
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })
    const customers = J.createResource('customers', { app: hosted })

    // The page's Customer is public on every verb; the hosted one is not.
    expect(customers.can('read', 4)).toBe(true)
    expect(customers.can('delete', 4)).toBe(false)
    expect(customers.can('delete', 6)).toBe(true)
  })
})

// ─── The calls go to the hosted app ──────────────────────────────────────────

describe('a resource over the hosted app calls that app, through the forward', () => {

  test('with the page\'s credential, and the hosted app answers the owner\'s rows', async () => {
    await resetSeen()
    const J = await boot({ token: 'studio-token' })
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })

    const rows = await J.createResource('customers', { app: hosted }).load()
    expect(rows).toEqual([{ id: 1, email: 'ada@hosted.test' }])
    expect(await seen()).toEqual([
      { path: '/hosted/h1/api/customers', from: 'Bearer studio-token', forwarded: 'Bearer owner-token' },
    ])
  })

  test('the handle follows the page\'s sign-in, and a refusal there leaves the page\'s token alone', async () => {
    await resetSeen()
    const J = await boot()
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })
    const customers = J.createResource('customers', { app: hosted })

    // Signed out: the forward refuses, and nothing is clearable on the page.
    await expect(customers.load()).rejects.toBeTruthy()

    J.getClient().setToken('studio-token')
    expect(hosted.client.token).toBe('studio-token')
    expect(await customers.load()).toEqual([{ id: 1, email: 'ada@hosted.test' }])
    expect(J.getClient().token).toBe('studio-token')
    expect(globalThis.localStorage.getItem('junction_token')).toBe('studio-token')

    hosted.close()
    J.getClient().setToken('someone-else')
    expect(hosted.client.token).toBe('studio-token')
  })

  test('a related resource inherits the handle, so a picker lists the hosted rows', async () => {
    await resetSeen()
    const J = await boot({ token: 'studio-token' })
    const hosted = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema: await schema() })

    const { options } = await J.createResource('orders', { app: hosted }).options('customerId')
    expect(options.map(o => o.value)).toEqual([1])
    expect((await seen()).every(s => s.path.startsWith('/hosted/h1/'))).toBe(true)
  })
})
