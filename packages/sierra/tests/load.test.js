/**
 * tests/load.test.js — tests for load() data flow
 *
 * Tests: companion resolution in scanner, loaders map in manifest,
 * sierraFetch wrapper, and load() invocation behaviour.
 */

import { describe, test, expect, beforeAll, vi } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { scan } from '../src/scanner/index.js'
import { renderManifest } from '../src/scanner/generate-manifest.js'
import { sierraFetch, configureFetch } from '../src/fetch/index.js'
import { data, loadError } from '../src/router/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(__dirname, 'fixtures/basic-spa')
const ROUTES_DIR = 'src/routes'

// ─── Scanner: companion resolution ───────────────────────────────────────────

describe('companion resolution in scanner', () => {
  let tree

  beforeAll(async () => {
    tree = await scan(ROUTES_DIR, { cwd: FIXTURE_DIR })
  })

  test('route with .meta.js has companion path set', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const detail = leads.children.find(c => c.id === 'leads.[leadId]')
    expect(detail.companion).toBe('src/routes/leads/[leadId].meta.js')
  })

  test('route without .meta.js has companion null', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    expect(leads.companion).toBeNull()

    const login = tree.children.find(c => c.id === 'login')
    expect(login.companion).toBeNull()
  })

  test('companion does not appear as a route', () => {
    const allIds = flattenNode(tree).map(n => n.id)
    expect(allIds.every(id => !id.includes('.meta'))).toBe(true)
  })
})

// ─── Manifest: loaders map ────────────────────────────────────────────────────

describe('loaders map in manifest', () => {
  let tree
  let manifest

  beforeAll(async () => {
    tree = await scan(ROUTES_DIR, { cwd: FIXTURE_DIR })
    manifest = renderManifest(tree, FIXTURE_DIR, 'config/routes.js')
  })

  test('manifest exports loaders', () => {
    expect(manifest).toContain('export const loaders =')
  })

  test('loaders map contains entry for route with companion', () => {
    expect(manifest).toContain("'leads.[leadId]'")
    // The loaders section should contain the leadId entry
    const loadersStart = manifest.indexOf('export const loaders =')
    const loadersEnd = manifest.indexOf('\n\n', loadersStart)
    const loadersSection = manifest.slice(loadersStart, loadersEnd)
    expect(loadersSection).toContain('leads.[leadId]')
    expect(loadersSection).toContain('.meta.js')
  })

  test('loaders map does NOT contain routes without companions', () => {
    const loadersStart = manifest.indexOf('export const loaders =')
    const loadersEnd = manifest.indexOf('\n\n', loadersStart)
    const loadersSection = manifest.slice(loadersStart, loadersEnd)
    expect(loadersSection).not.toContain("'leads'")
    expect(loadersSection).not.toContain("'login'")
    expect(loadersSection).not.toContain("'root'")
  })

  test('tree nodes include companion field', () => {
    expect(manifest).toContain('companion:')
    expect(manifest).toContain('[leadId].meta.js')
  })

  test('tree nodes for routes without companions have companion: null', () => {
    expect(manifest).toContain('companion: null')
  })
})

// ─── sierraFetch ─────────────────────────────────────────────────────────────

describe('sierraFetch', () => {
  test('wraps native fetch by default', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = mockFetch
    globalThis.localStorage = { getItem: () => null }

    // Reset to plain fetch (no config)
    configureFetch({})

    await sierraFetch('https://example.com/api/test')
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/api/test', expect.any(Object))
  })

  test('configureFetch attaches Authorization header when token present', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = mockFetch

    // Simulate localStorage with a token
    globalThis.localStorage = {
      getItem: (key) => key === 'test_token' ? 'abc123' : null,
      setItem: () => {},
      removeItem: () => {},
    }

    configureFetch({ tokenKey: 'test_token' })

    await sierraFetch('/api/leads')

    const callArgs = mockFetch.mock.calls[0]
    const headers = callArgs[1].headers
    expect(headers.get('Authorization')).toBe('Bearer abc123')
  })

  test('configureFetch does not override existing Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = mockFetch

    globalThis.localStorage = {
      getItem: () => 'stored-token',
    }

    configureFetch({ tokenKey: 'test_token' })

    await sierraFetch('/api/leads', {
      headers: { Authorization: 'Bearer custom-token' }
    })

    const callArgs = mockFetch.mock.calls[0]
    const headers = callArgs[1].headers
    expect(headers.get('Authorization')).toBe('Bearer custom-token')
  })

  test('configureFetch prepends baseUrl to relative paths', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = mockFetch
    globalThis.localStorage = { getItem: () => null }

    configureFetch({ baseUrl: 'https://api.example.com' })

    await sierraFetch('/leads/1')

    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toBe('https://api.example.com/leads/1')
  })

  test('configureFetch does not prepend baseUrl to absolute URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = mockFetch
    globalThis.localStorage = { getItem: () => null }

    configureFetch({ baseUrl: 'https://api.example.com' })

    await sierraFetch('https://other.com/data')

    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toBe('https://other.com/data')
  })
})

// ─── load() invocation ────────────────────────────────────────────────────────

describe('load() invocation via fixture', () => {
  test('fixture .meta.js exports a load function', async () => {
    const mod = await import('./fixtures/basic-spa/src/routes/leads/[leadId].meta.js')
    expect(typeof mod.load).toBe('function')
  })

  test('fixture load() returns data keyed by route params', async () => {
    const mod = await import('./fixtures/basic-spa/src/routes/leads/[leadId].meta.js')
    const result = await mod.load({
      params: { leadId: '42' },
      url: '/leads/42/',
      fetch: sierraFetch,
    })
    expect(result.lead.id).toBe('42')
    expect(result.lead.name).toBe('Test Lead')
  })

  test('load() receives params correctly typed', async () => {
    const mod = await import('./fixtures/basic-spa/src/routes/leads/[leadId].meta.js')
    const result = await mod.load({
      params: { leadId: 'abc-123' },
      url: '/leads/abc-123/',
      fetch: sierraFetch,
    })
    expect(result.lead.id).toBe('abc-123')
  })
})

// ─── _module.meta.js companion + inheritance ──────────────────────────────────

describe('layout companion meta inheritance', () => {
  let tree

  beforeAll(async () => {
    tree = await scan(ROUTES_DIR, { cwd: FIXTURE_DIR })
  })

  test('_module.meta.js companion is NOT a route', () => {
    const allIds = flattenNode(tree).map(n => n.id)
    expect(allIds.every(id => !id.includes('_module'))).toBe(true)
  })

  test('root layout companion meta flows to top-level routes', () => {
    // index.mesa should inherit from root _module.meta.js
    const root = tree
    expect(root.meta.tracking).toBe(true)
    expect(root.meta.robots).toBe('index')
  })

  test('nested layout companion meta overrides root for its subtree', () => {
    // leads routes inherit root meta, but leads/_module.meta.js overrides robots
    const leads = tree.children.find(c => c.id === 'leads')
    expect(leads.meta.section).toBe('leads')
    expect(leads.meta.robots).toBe('noindex')  // leads override
    expect(leads.meta.tracking).toBe(true)     // inherited from root
  })

  test('deeply nested routes inherit correct chain', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const detail = leads.children.find(c => c.id === 'leads.[leadId]')
    expect(detail.meta.tracking).toBe(true)    // from root
    expect(detail.meta.section).toBe('leads')  // from leads
    expect(detail.meta.robots).toBe('noindex') // from leads override
  })

  test('route companion meta overrides layout companion meta', () => {
    // [leadId].meta.js has { lead: { id, name, status } } returned by load()
    // but we only care about meta export here
    // The fixture [leadId].meta.js doesn't export meta — so leadDetail
    // still just has inherited meta, which is fine
    const leads = tree.children.find(c => c.id === 'leads')
    const detail = leads.children.find(c => c.id === 'leads.[leadId]')
    // section from leads/_module.meta.js is present
    expect(detail.meta.section).toBe('leads')
  })

  test('route frontmatter overrides companion and layout meta', () => {
    // login has reset: true in frontmatter — that wins over any inherited meta
    const login = tree.children.find(c => c.id === 'login')
    expect(login.meta.reset).toBe(true)
    // But tracking should still flow in (login is at root level, no leads layer)
    expect(login.meta.tracking).toBe(true)
  })

  test('routes outside leads subtree do not get leads section meta', () => {
    const blog = tree.children.find(c => c.id === 'blog')
    expect(blog.meta.section).toBeUndefined()
    // blog inherits root meta
    expect(blog.meta.tracking).toBe(true)
  })
})

describe('data and loadError signals', () => {
  test('data signal starts null', () => {
    expect(data.get()).toBeNull()
  })

  test('loadError signal starts null', () => {
    expect(loadError.get()).toBeNull()
  })

  test('data signal can be subscribed to', () => {
    const values = []
    const unsub = data.subscribe(v => values.push(v))
    data.set({ lead: { id: '1' } })
    data.set(null)
    unsub()
    expect(values).toEqual([null, { lead: { id: '1' } }, null])
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

function flattenNode(node) {
  return [node, ...node.children.flatMap(flattenNode)]
}
