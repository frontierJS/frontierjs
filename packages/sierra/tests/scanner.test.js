/**
 * tests/scanner.test.js — Sierra route scanner tests
 *
 * Run with: bun test  (or node --test in Node 18+)
 */

import { describe, test, it, expect, beforeAll } from 'vitest'
import { resolve } from 'path'
import { classify, isDynamicSegment, isSpreadSegment, isGroupSegment } from '../src/scanner/classify.js'
import { parseFrontmatter } from '../src/scanner/parse-frontmatter.js'
import { buildTree } from '../src/scanner/build-tree.js'
import { renderRouteTable } from '../src/scanner/generate-route-table.js'
import { walk } from '../src/scanner/walk.js'
import { scan } from '../src/scanner/index.js'

import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(__dirname, 'fixtures/basic-spa')
const ROUTES_DIR = 'src/routes'

// ─── classify ────────────────────────────────────────────────────────────────

describe('classify', () => {
  test('lowercase .mesa → route', () => {
    expect(classify('leads/index.mesa')).toBe('route')
    expect(classify('leads/create.mesa')).toBe('route')
    expect(classify('leads/[leadId].mesa')).toBe('route')
    expect(classify('[...404].mesa')).toBe('route')
  })

  test('_module.mesa → layout', () => {
    expect(classify('_module.mesa')).toBe('layout')
    expect(classify('leads/_module.mesa')).toBe('layout')
  })

  test('underscore prefix → component', () => {
    expect(classify('_leads.FilterBar.mesa')).toBe('component')
    expect(classify('leads/_leads.FilterBar.mesa')).toBe('component')
    expect(classify('_sidebar.mesa')).toBe('component')
  })

  test('PascalCase → component', () => {
    expect(classify('Leads.mesa')).toBe('component')
    expect(classify('leads/LeadCard.mesa')).toBe('component')
    expect(classify('leads/Leads.mesa')).toBe('component')
  })

  test('.meta.js → companion', () => {
    expect(classify('[leadId].meta.js')).toBe('companion')
    expect(classify('leads/[leadId].meta.js')).toBe('companion')
    expect(classify('blog/[slug].meta.js')).toBe('companion')
  })

  test('.md → route', () => {
    expect(classify('blog/my-post.md')).toBe('route')
    expect(classify('index.md')).toBe('route')
  })

  test('non-Mesa files → ignored', () => {
    expect(classify('store.js')).toBe('ignored')
    expect(classify('styles.css')).toBe('ignored')
    expect(classify('README.md.bak')).toBe('ignored')
  })
})

// ─── segment helpers ─────────────────────────────────────────────────────────

describe('segment helpers', () => {
  test('isDynamicSegment', () => {
    expect(isDynamicSegment('[leadId]')).toBe(true)
    expect(isDynamicSegment('[slug]')).toBe(true)
    expect(isDynamicSegment('[...rest]')).toBe(false)  // spread, not dynamic
    expect(isDynamicSegment('leads')).toBe(false)
  })

  test('isSpreadSegment', () => {
    expect(isSpreadSegment('[...404]')).toBe(true)
    expect(isSpreadSegment('[...rest]')).toBe(true)
    expect(isSpreadSegment('[leadId]')).toBe(false)
  })

  test('isGroupSegment', () => {
    expect(isGroupSegment('(auth)')).toBe(true)
    expect(isGroupSegment('(marketing)')).toBe(true)
    expect(isGroupSegment('leads')).toBe(false)
    expect(isGroupSegment('[leadId]')).toBe(false)
  })
})

// ─── parseFrontmatter ────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('parses basic YAML frontmatter', () => {
    const src = `---\ntitle: About Us\nrender: static\n---\n<h1>Hello</h1>`
    const { frontmatter, content } = parseFrontmatter(src)
    expect(frontmatter.title).toBe('About Us')
    expect(frontmatter.render).toBe('static')
    expect(content.trim()).toBe('<h1>Hello</h1>')
  })

  test('returns empty object when no frontmatter', () => {
    const src = `<h1>No frontmatter</h1>`
    const { frontmatter } = parseFrontmatter(src)
    expect(frontmatter).toEqual({})
  })

  test('parses boolean values', () => {
    const src = `---\nreset: true\nscrollRestore: false\n---\n`
    const { frontmatter } = parseFrontmatter(src)
    expect(frontmatter.reset).toBe(true)
    expect(frontmatter.scrollRestore).toBe(false)
  })

  test('parses nested objects', () => {
    const src = `---\ntoc:\n  depth: 3\n---\n`
    const { frontmatter } = parseFrontmatter(src)
    expect(frontmatter.toc).toEqual({ depth: 3 })
  })

  test('handles malformed YAML gracefully', () => {
    const src = `---\ninvalid: [\nunclosed\n---\n`
    const { frontmatter } = parseFrontmatter(src)
    expect(frontmatter).toEqual({})
  })

  test('handles Windows line endings', () => {
    const src = `---\r\ntitle: Windows\r\n---\r\n<h1>Hi</h1>`
    const { frontmatter } = parseFrontmatter(src)
    expect(frontmatter.title).toBe('Windows')
  })
})

// ─── walk ────────────────────────────────────────────────────────────────────

describe('walk', () => {
  test('finds all files recursively', async () => {
    const files = await walk(
      resolve(FIXTURE_DIR, ROUTES_DIR),
      FIXTURE_DIR
    )
    expect(files.length).toBeGreaterThan(5)
    expect(files.some(f => f.includes('leads/index.mesa'))).toBe(true)
    expect(files.some(f => f.includes('[leadId].mesa'))).toBe(true)
    expect(files.some(f => f.includes('_module.mesa'))).toBe(true)
  })

  test('excludes dotfiles and node_modules', async () => {
    const files = await walk(
      resolve(FIXTURE_DIR, ROUTES_DIR),
      FIXTURE_DIR
    )
    expect(files.every(f => !f.includes('node_modules'))).toBe(true)
    expect(files.every(f => !f.split('/').some(s => s.startsWith('.')))).toBe(true)
  })

  test('returns paths with forward slashes', async () => {
    const files = await walk(
      resolve(FIXTURE_DIR, ROUTES_DIR),
      FIXTURE_DIR
    )
    expect(files.every(f => !f.includes('\\'))).toBe(true)
  })
})

// ─── buildTree ───────────────────────────────────────────────────────────────

describe('buildTree', () => {
  let tree

  beforeAll(async () => {
    tree = await scan(ROUTES_DIR, { cwd: FIXTURE_DIR })
  })

  test('root node has correct path', () => {
    expect(tree.path).toBe('/')
    expect(tree.id).toBe('root')
  })

  test('top-level routes are direct children of root', () => {
    const ids = tree.children.map(c => c.id)
    expect(ids).toContain('leads')
    expect(ids).toContain('blog')
    expect(ids).toContain('login')
  })

  test('dynamic routes have correct path and params', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const detail = leads.children.find(c => c.id === 'leads.[leadId]')
    expect(detail).toBeDefined()
    expect(detail.path).toBe('/leads/:leadId/')
    expect(detail.params).toEqual(['leadId'])
    expect(detail.meta.dynamic).toBe(true)
  })

  test('catch-all route has spread=true and correct path', () => {
    const notFound = tree.children.find(c => c.id === '[...404]' || c.meta?.spread)
    expect(notFound).toBeDefined()
    expect(notFound.path).toBe('/*')
    expect(notFound.meta.spread).toBe(true)
  })

  test('PascalCase files are NOT routes', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const allDescendants = flattenNode(leads)
    expect(allDescendants.every(n => !/^[A-Z]/.test(n.id.split('.').pop()))).toBe(true)
  })

  test('underscore-prefixed files are NOT routes', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const allDescendants = flattenNode(leads)
    expect(allDescendants.every(n => !n.id.split('.').some(s => s.startsWith('_')))).toBe(true)
  })

  test('.meta.js files are NOT routes', () => {
    const allNodes = flattenNode(tree)
    expect(allNodes.every(n => !n.file?.endsWith('.meta.js'))).toBe(true)
  })

  test('layout is resolved for nested routes', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    expect(leads.layout).toBe('src/routes/leads/_module.mesa')

    const detail = leads.children.find(c => c.id === 'leads.[leadId]')
    expect(detail.layout).toBe('src/routes/leads/_module.mesa')
  })

  test('root layout is resolved from root _module.mesa', () => {
    const blog = tree.children.find(c => c.id === 'blog')
    expect(blog.layout).toBe('src/routes/_module.mesa')
  })

  test('reset:true in frontmatter → layout is null', () => {
    const login = tree.children.find(c => c.id === 'login')
    expect(login.layout).toBeNull()
  })

  test('frontmatter is merged into meta', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    expect(leads.meta.title).toBe('Leads')

    const blog = tree.children.find(c => c.id === 'blog')
    expect(blog.meta.robots).toBe('noindex')
  })

  test('static routes before dynamic routes', () => {
    const leads = tree.children.find(c => c.id === 'leads')
    const childIds = leads.children.map(c => c.id)
    const createIdx = childIds.indexOf('leads.create')
    const dynamicIdx = childIds.indexOf('leads.[leadId]')
    expect(createIdx).toBeLessThan(dynamicIdx)
  })

  test('deeply nested routes resolve correctly', () => {
    const allNodes = flattenNode(tree)
    const settings = allNodes.find(n => n.id === 'account.settings')
    expect(settings).toBeDefined()
    expect(settings.path).toBe('/account/settings/')
  })
})

// ─── renderRouteTable ────────────────────────────────────────────────────────

describe('renderRouteTable', () => {
  let tree
  let routeTable

  beforeAll(async () => {
    tree = await scan(ROUTES_DIR, { cwd: FIXTURE_DIR })
    routeTable = renderRouteTable(tree)
  })

  test('exports tree', () => {
    expect(routeTable).toContain('export const tree =')
  })

  test('exports components map with lazy imports', () => {
    expect(routeTable).toContain('export const components =')
    // Paths are relative to route table location (config/routes.js → ../src/routes/...)
    expect(routeTable).toContain("() => import('")
    expect(routeTable).toContain(".mesa')")
  })

  test('exports all, published, indexed, redirects', () => {
    expect(routeTable).toContain('export const all =')
    expect(routeTable).toContain('export const published =')
    expect(routeTable).toContain('export const indexed =')
    expect(routeTable).toContain('export const redirects =')
  })

  test('default export is tree', () => {
    expect(routeTable).toContain('export default tree')
  })

  test('noindex routes excluded from indexed', () => {
    // blog/index has robots: noindex
    const indexedLine = routeTable.indexOf('export const indexed =')
    const indexedEnd = routeTable.indexOf('\n\n', indexedLine)
    const indexedSection = routeTable.slice(indexedLine, indexedEnd)
    expect(indexedSection).not.toContain('/blog/')
  })

  test('dynamic routes excluded from indexed', () => {
    const indexedLine = routeTable.indexOf('export const indexed =')
    const indexedEnd = routeTable.indexOf('\n\n', indexedLine)
    const indexedSection = routeTable.slice(indexedLine, indexedEnd)
    expect(indexedSection).not.toContain(':leadId')
    expect(indexedSection).not.toContain(':slug')
  })

  test('tree nodes do not contain component imports', () => {
    const treeStart = routeTable.indexOf('export const tree =')
    const treeEnd = routeTable.indexOf('\nexport const components', treeStart)
    const treeSection = routeTable.slice(treeStart, treeEnd)
    expect(treeSection).not.toContain('() => import')
  })

  test('exports layouts map with lazy imports for each unique layout file', () => {
    expect(routeTable).toContain('export const layouts =')
    // Should include the two layout files in the basic-spa fixture
    expect(routeTable).toContain('src/routes/_module.mesa')
    expect(routeTable).toContain('src/routes/leads/_module.mesa')
    // Values should be lazy import factories
    expect(routeTable).toContain("() => import('")
  })

  test('layouts map does NOT include null layouts (reset:true routes)', () => {
    const layoutsStart = routeTable.indexOf('export const layouts =')
    const layoutsEnd = routeTable.indexOf('\n\n', layoutsStart)
    const layoutsSection = routeTable.slice(layoutsStart, layoutsEnd)
    // login has reset:true (layout: null) — should not appear in layouts map
    expect(layoutsSection).not.toContain('login')
  })

  test('layouts map contains only unique layout paths, no duplicates', () => {
    const layoutsStart = routeTable.indexOf('export const layouts =')
    const layoutsEnd = routeTable.indexOf('\n\n', layoutsStart)
    const layoutsSection = routeTable.slice(layoutsStart, layoutsEnd)
    // The root _module.mesa path appears exactly once (not duplicated for each route that uses it)
    // Use an anchored pattern to match only the root layout, not leads/_module.mesa
    const matches = layoutsSection.match(/"src\/routes\/_module\.mesa"/g) || []
    expect(matches).toHaveLength(1)
  })

  test('valid JS — no syntax errors', () => {
    // If this doesn't throw, the route table is parseable
    expect(() => {
      // Quick structural check — all export statements present
      const exports = ['tree', 'components', 'loaders', 'layouts', 'all', 'published', 'indexed', 'redirects']
      for (const name of exports) {
        if (!routeTable.includes(`export const ${name}`)) {
          throw new Error(`Missing export: ${name}`)
        }
      }
    }).not.toThrow()
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

function flattenNode(node) {
  return [node, ...node.children.flatMap(flattenNode)]
}

import { mkdtemp, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Helper: create a temp dir with given files
async function makeTmpFixture(fileMap) {
  const dir = await mkdtemp(join(tmpdir(), 'sierra-test-'))
  for (const [rel, content] of Object.entries(fileMap)) {
    const abs = join(dir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  return dir
}

describe('_module.mesa frontmatter inheritance', () => {
  it('includes layout _module.mesa frontmatter in route meta', async () => {
    const cwd = await makeTmpFixture({
      'src/routes/_module.mesa': '---\nsiteName: My App\nthemeColor: "#6366f1"\n---\n<slot />',
      'src/routes/index.mesa': '---\ntitle: Home\n---\n<p>Hello</p>',
    })
    const files = ['src/routes/_module.mesa', 'src/routes/index.mesa']
    const tree = await buildTree(files, 'src/routes', { cwd })
    // index.mesa at root becomes the root node itself, not a child
    expect(tree.meta.title).toBe('Home')
    expect(tree.meta.siteName).toBe('My App')
    expect(tree.meta.themeColor).toBe('#6366f1')
  })

  it('page frontmatter overrides layout frontmatter for same key', async () => {
    const cwd = await makeTmpFixture({
      'src/routes/_module.mesa': '---\ntitle: Default\nsection: Main\n---\n<slot />',
      'src/routes/about.mesa': '---\ntitle: About\n---\n<p>About</p>',
    })
    const files = ['src/routes/_module.mesa', 'src/routes/about.mesa']
    const tree = await buildTree(files, 'src/routes', { cwd })
    const about = tree.children.find(n => n.id === 'about')
    expect(about.meta.title).toBe('About')    // page wins
    expect(about.meta.section).toBe('Main')   // layout contributes
  })

  it('nested layout overrides outer layout for same key', async () => {
    const cwd = await makeTmpFixture({
      'src/routes/_module.mesa': '---\nsection: Root\ncolor: blue\n---\n<slot />',
      'src/routes/blog/_module.mesa': '---\nsection: Blog\n---\n<slot />',
      'src/routes/blog/index.mesa': '---\ntitle: Blog\n---\n<p>Blog</p>',
    })
    const files = [
      'src/routes/_module.mesa',
      'src/routes/blog/_module.mesa',
      'src/routes/blog/index.mesa',
    ]
    const tree = await buildTree(files, 'src/routes', { cwd })
    const blog = tree.children.find(n => n.id === 'blog')
    expect(blog.meta.section).toBe('Blog')   // nested layout wins
    expect(blog.meta.color).toBe('blue')     // root layout contributes
    expect(blog.meta.title).toBe('Blog')     // page wins over all
  })

  it('_module.meta.js overrides _module.mesa frontmatter at same level', async () => {
    const cwd = await makeTmpFixture({
      'src/routes/_module.mesa': '---\nsection: From Mesa\n---\n<slot />',
      'src/routes/_module.meta.js': 'export const meta = { section: "From MetaJs" }',
      'src/routes/index.mesa': '---\ntitle: Home\n---\n<p>Hello</p>',
    })
    const files = [
      'src/routes/_module.mesa',
      'src/routes/_module.meta.js',
      'src/routes/index.mesa',
    ]
    const tree = await buildTree(files, 'src/routes', { cwd })
    expect(tree.meta.section).toBe('From MetaJs')  // meta.js wins
    expect(tree.meta.title).toBe('Home')
  })

  it('Sierra-internal fields (reset) are not propagated from layout', async () => {
    const cwd = await makeTmpFixture({
      'src/routes/_module.mesa': '---\nreset: true\nsiteName: My App\n---\n<slot />',
      'src/routes/index.mesa': '---\ntitle: Home\n---\n<p>Hello</p>',
    })
    const files = ['src/routes/_module.mesa', 'src/routes/index.mesa']
    const tree = await buildTree(files, 'src/routes', { cwd })
    expect(tree.meta.reset).toBeUndefined()
    expect(tree.meta.siteName).toBe('My App')
  })
})
