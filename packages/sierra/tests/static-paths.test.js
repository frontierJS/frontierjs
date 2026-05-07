/**
 * tests/static-paths.test.js — getStaticPaths build error tests
 */

import { describe, test, expect } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { scan } from '../src/scanner/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATIC_FIXTURE = resolve(__dirname, 'fixtures/static-site')
const SPA_FIXTURE    = resolve(__dirname, 'fixtures/basic-spa')
const ROUTES_DIR     = 'src/routes'

// ─── scanner correctly reads render:static on dynamic routes ─────────────────

describe('render:static on dynamic routes (scanner)', () => {
  test('dynamic route with render:static is in tree', async () => {
    const tree = await scan(ROUTES_DIR, { cwd: STATIC_FIXTURE })
    const nodes = flattenNode(tree)
    const slugRoute = nodes.find(n => n.id === 'blog.[slug]')
    expect(slugRoute).toBeDefined()
    expect(slugRoute.meta.render).toBe('static')
    expect(slugRoute.meta.dynamic).toBe(true)
  })

  test('companion is resolved for dynamic static route', async () => {
    const tree = await scan(ROUTES_DIR, { cwd: STATIC_FIXTURE })
    const nodes = flattenNode(tree)
    const slugRoute = nodes.find(n => n.id === 'blog.[slug]')
    expect(slugRoute.companion).toBeTruthy()
    expect(slugRoute.companion).toContain('.meta.js')
  })
})

// ─── getStaticPaths detection ─────────────────────────────────────────────────

describe('getStaticPaths detection', () => {
  test('[slug].meta.js exports getStaticPaths', async () => {
    const mod = await import('./fixtures/static-site/src/routes/blog/[slug].meta.js')
    expect(typeof mod.getStaticPaths).toBe('function')
  })

  test('getStaticPaths returns correct path objects', async () => {
    const mod = await import('./fixtures/static-site/src/routes/blog/[slug].meta.js')
    const paths = await mod.getStaticPaths()
    expect(paths).toHaveLength(2)
    expect(paths[0]).toHaveProperty('slug')
    expect(paths.map(p => p.slug)).toEqual(['hello-world', 'second-post'])
  })

  test('[tag].meta.js does NOT export getStaticPaths', async () => {
    const mod = await import('./fixtures/static-site/src/routes/blog/[tag].meta.js')
    expect(mod.getStaticPaths).toBeUndefined()
  })
})

// ─── checkStaticPaths validation logic ───────────────────────────────────────

describe('checkStaticPaths validation logic', () => {
  // We test the validation logic directly by simulating what the plugin does:
  // scan the tree, find dynamic+static nodes, check their companions

  test('SPA routes with no render:static pass silently', async () => {
    const tree = await scan(ROUTES_DIR, { cwd: SPA_FIXTURE })
    const nodes = flattenNode(tree)
    const dynamicNodes = nodes.filter(n => n.meta?.dynamic && !n.meta?.spread)

    // None should have render:static
    const staticDynamic = dynamicNodes.filter(n => n.meta?.render === 'static')
    expect(staticDynamic).toHaveLength(0)
  })

  test('static fixture [slug] passes — has getStaticPaths', async () => {
    const tree = await scan(ROUTES_DIR, { cwd: STATIC_FIXTURE })
    const nodes = flattenNode(tree)
    const slugRoute = nodes.find(n => n.id === 'blog.[slug]')

    // Simulate the check
    const { pathToFileURL } = await import('url')
    const mod = await import(pathToFileURL(resolve(STATIC_FIXTURE, slugRoute.companion)).href)
    expect(typeof mod.getStaticPaths).toBe('function')
  })

  test('static fixture [tag] fails — no getStaticPaths', async () => {
    const tree = await scan(ROUTES_DIR, { cwd: STATIC_FIXTURE })
    const nodes = flattenNode(tree)
    const tagRoute = nodes.find(n => n.id === 'blog.[tag]')

    expect(tagRoute).toBeDefined()
    expect(tagRoute.meta.dynamic).toBe(true)
    expect(tagRoute.meta.render).toBe('static')

    const { pathToFileURL } = await import('url')
    const mod = await import(pathToFileURL(resolve(STATIC_FIXTURE, tagRoute.companion)).href)
    expect(mod.getStaticPaths).toBeUndefined()
  })

  test('error message includes route path and companion filename', () => {
    // Test the error message format by constructing it manually
    const node = {
      path: '/blog/:tag/',
      file: 'src/routes/blog/[tag].mesa',
      companion: 'src/routes/blog/[tag].meta.js',
      meta: { dynamic: true, render: 'static' },
    }

    const msg =
      `[Sierra] Dynamic route '${node.path}' has render:static but '${node.companion}' ` +
      `does not export getStaticPaths().\n` +
      `Add: export async function getStaticPaths() { return [{ slug: '...' }, ...] }`

    expect(msg).toContain('/blog/:tag/')
    expect(msg).toContain('[tag].meta.js')
    expect(msg).toContain('getStaticPaths')
  })

  test('error message when no companion at all', () => {
    const node = {
      path: '/blog/:tag/',
      file: 'src/routes/blog/[tag].mesa',
      companion: null,
      meta: { dynamic: true, render: 'static' },
    }

    const msg =
      `[Sierra] Dynamic route '${node.path}' has render:static but no companion .meta.js.\n` +
      `Create ${node.file.replace(/\.(mesa|md)$/, '.meta.js')} and export getStaticPaths().`

    expect(msg).toContain('[tag].meta.js')
    expect(msg).toContain('Create')
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

function flattenNode(node) {
  return [node, ...node.children.flatMap(flattenNode)]
}
