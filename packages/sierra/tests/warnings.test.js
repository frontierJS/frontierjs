/**
 * tests/warnings.test.js — build warning tests
 */

import { describe, test, expect } from 'vitest'
import {
  warnUnexportedSnippets,
  warnDuplicateSnippets,
  extractLayoutProps,
} from '../src/build/warnings.js'

// ─── warnUnexportedSnippets ───────────────────────────────────────────────────

describe('warnUnexportedSnippets', () => {
  const routesDir = '/project/src/routes'

  function collectWarnings(source, id = '/project/src/routes/page.mesa') {
    const warnings = []
    warnUnexportedSnippets(source, id, routesDir, (msg) => warnings.push(msg))
    return warnings
  }

  test('no warning when snippet is exported from script module', () => {
    const source = `
<script module>
  export { sidebar }
</script>
<script>
  export let children = null
</script>
{#snippet sidebar()}
  <aside>content</aside>
{/snippet}
{@render children?.()}
`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('warns when top-level snippet is not exported', () => {
    const source = `
<script>
  export let children = null
</script>
{#snippet sidebar()}
  <aside>content</aside>
{/snippet}
{@render children?.()}
`
    const warnings = collectWarnings(source)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Snippet 'sidebar'")
    expect(warnings[0]).toContain('not exported from <script module>')
    expect(warnings[0]).toContain('export { sidebar }')
  })

  test('warns for each unexported snippet individually', () => {
    const source = `
{#snippet sidebar()}
  <aside />
{/snippet}
{#snippet toolbar()}
  <nav />
{/snippet}
`
    const warnings = collectWarnings(source)
    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes("'sidebar'"))).toBe(true)
    expect(warnings.some(w => w.includes("'toolbar'"))).toBe(true)
  })

  test('no warning when all snippets are exported', () => {
    const source = `
<script module>
  export { sidebar, toolbar }
</script>
{#snippet sidebar()}<aside />{/snippet}
{#snippet toolbar()}<nav />{/snippet}
`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('no warning for _module.mesa layout files', () => {
    const source = `
{#snippet sidebar()}
  <aside>not exported</aside>
{/snippet}
`
    const warnings = collectWarnings(source, '/project/src/routes/leads/_module.mesa')
    expect(warnings).toHaveLength(0)
  })

  test('no warning for files outside routes dir', () => {
    const source = `{#snippet foo()}<div />{/snippet}`
    const warnings = collectWarnings(source, '/project/src/components/Shared.mesa')
    expect(warnings).toHaveLength(0)
  })

  test('no warning when file has no snippets', () => {
    const source = `<h1>Hello</h1>`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('detects export function form in script module', () => {
    const source = `
<script module>
  export function sidebar(__anchor) {}
</script>
{#snippet sidebar()}<aside />{/snippet}
`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('includes suppression hint in warning message', () => {
    const source = `{#snippet sidebar()}<aside />{/snippet}`
    const warnings = collectWarnings(source)
    expect(warnings[0]).toContain('local helper')
  })

  test('no warning when snippet is passed to provideSlot()', () => {
    const source = `
{#snippet sidebar()}
  <aside>content</aside>
{/snippet}
{provideSlot('sidebar', sidebar)}
`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('no warning for provideSlot snippet even without script module', () => {
    const source = `
<script>
  import { provideSlot } from '@frontierjs/sierra/router'
</script>
{#snippet toolbar()}<nav />{/snippet}
{provideSlot('toolbar', toolbar)}
`
    expect(collectWarnings(source)).toHaveLength(0)
  })

  test('still warns for snippet that is neither exported nor provided', () => {
    const source = `
{#snippet sidebar()}<aside />{/snippet}
{#snippet toolbar()}<nav />{/snippet}
{provideSlot('sidebar', sidebar)}
`
    // sidebar is provided — no warn. toolbar is neither exported nor provided — warn.
    const warnings = collectWarnings(source)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("'toolbar'")
  })

  test('warning message now suggests provideSlot as the primary pattern', () => {
    const source = `{#snippet sidebar()}<aside />{/snippet}`
    const warnings = collectWarnings(source)
    expect(warnings[0]).toContain('provideSlot')
  })
})

// ─── extractLayoutProps ───────────────────────────────────────────────────────

describe('extractLayoutProps', () => {
  test('extracts export let props from script block', () => {
    const source = `
<script>
  export let children = null
  export let sidebar = null
  export let toolbar = null
  let internal = 0
</script>
`
    const props = extractLayoutProps(source)
    expect(props.has('children')).toBe(true)
    expect(props.has('sidebar')).toBe(true)
    expect(props.has('toolbar')).toBe(true)
    expect(props.has('internal')).toBe(false)
  })

  test('does not include export const or export var', () => {
    const source = `
<script>
  export let name = null
  export const id = 'abc'
  export var region = 'US'
</script>
`
    const props = extractLayoutProps(source)
    expect(props.has('name')).toBe(true)
    expect(props.has('id')).toBe(false)
    expect(props.has('region')).toBe(false)
  })

  test('handles export let without initializer', () => {
    const source = `<script>export let sidebar</script>`
    const props = extractLayoutProps(source)
    expect(props.has('sidebar')).toBe(true)
  })

  test('returns empty set for no script block', () => {
    const source = `<h1>No script</h1>`
    const props = extractLayoutProps(source)
    expect(props.size).toBe(0)
  })

  test('does not pick up props from script module block', () => {
    const source = `
<script module>
  export let moduleVar = null
</script>
<script>
  export let instanceProp = null
</script>
`
    const props = extractLayoutProps(source)
    expect(props.has('instanceProp')).toBe(true)
    expect(props.has('moduleVar')).toBe(false)
  })
})

// ─── warnDuplicateSnippets ────────────────────────────────────────────────────

describe('warnDuplicateSnippets', () => {
  function makeTree(nodes) {
    return {
      id: 'root', path: '/', file: null, layout: null,
      meta: {}, params: [], children: nodes
    }
  }

  function collectWarnings(tree, layoutPropMap) {
    const warnings = []
    warnDuplicateSnippets(tree, layoutPropMap, (msg) => warnings.push(msg))
    return warnings
  }

  test('no warning when different layouts declare different props', () => {
    const tree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/leads/_module.mesa', meta: {}, params: [], children: [
          {
            id: 'leads.[leadId]', path: '/leads/:leadId/',
            file: 'src/routes/leads/[leadId].mesa',
            layout: 'src/routes/leads/_module.mesa',
            meta: { dynamic: true }, params: ['leadId'], children: []
          }
        ]
      }
    ])

    const layoutPropMap = new Map([
      ['src/routes/_module.mesa', new Set(['children', 'sidebar'])],
      ['src/routes/leads/_module.mesa', new Set(['children', 'toolbar'])],
    ])

    expect(collectWarnings(tree, layoutPropMap)).toHaveLength(0)
  })

  test('warns when two layouts in same chain declare same prop', () => {
    const tree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/leads/_module.mesa', meta: {}, params: [], children: []
      }
    ])

    // Both root and leads layout declare 'sidebar'
    // For the chain to include root layout, the parent node must reference it
    const deepTree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/_module.mesa', meta: {}, params: [], children: [
          {
            id: 'leads.[leadId]', path: '/leads/:leadId/',
            file: 'src/routes/leads/[leadId].mesa',
            layout: 'src/routes/leads/_module.mesa',
            meta: { dynamic: true }, params: ['leadId'], children: []
          }
        ]
      }
    ])

    const layoutPropMap = new Map([
      ['src/routes/_module.mesa', new Set(['children', 'sidebar'])],
      ['src/routes/leads/_module.mesa', new Set(['children', 'sidebar'])],
    ])

    const warnings = collectWarnings(deepTree, layoutPropMap)
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain("'sidebar'")
    expect(warnings[0]).toContain('Both layouts will render the same snippet')
    expect(warnings[0]).toContain('sierra-ignore duplicate-snippet')
  })

  test('no warning for children — always present, not a snippet conflict', () => {
    const tree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/_module.mesa', meta: {}, params: [], children: [
          {
            id: 'leads.detail', path: '/leads/detail/',
            file: 'src/routes/leads/detail.mesa',
            layout: 'src/routes/leads/_module.mesa',
            meta: {}, params: [], children: []
          }
        ]
      }
    ])

    const layoutPropMap = new Map([
      ['src/routes/_module.mesa', new Set(['children'])],
      ['src/routes/leads/_module.mesa', new Set(['children'])],
    ])

    expect(collectWarnings(tree, layoutPropMap)).toHaveLength(0)
  })

  test('no warning for layouts not in the same chain', () => {
    // blog and leads have separate chains — same prop name is fine
    const tree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/leads/_module.mesa', meta: {}, params: [], children: []
      },
      {
        id: 'blog', path: '/blog/', file: 'src/routes/blog/index.mesa',
        layout: 'src/routes/blog/_module.mesa', meta: {}, params: [], children: []
      }
    ])

    const layoutPropMap = new Map([
      ['src/routes/leads/_module.mesa', new Set(['children', 'sidebar'])],
      ['src/routes/blog/_module.mesa', new Set(['children', 'sidebar'])],
    ])

    // Each chain has only 1 layout — no conflict
    expect(collectWarnings(tree, layoutPropMap)).toHaveLength(0)
  })

  test('no warning when layoutPropMap is empty', () => {
    const tree = makeTree([
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        layout: 'src/routes/leads/_module.mesa', meta: {}, params: [], children: []
      }
    ])
    expect(collectWarnings(tree, new Map())).toHaveLength(0)
  })
})

// ─── rewriteMesaSlots ─────────────────────────────────────────────────────────

import { rewriteMesaSlots } from '../src/build/slot-rewrite.js'

describe('rewriteMesaSlots', () => {
  test('no-op when no <mesa:slot> tags present', () => {
    const src = `<script>\nlet x = 1\n</script>\n<p>{x}</p>`
    expect(rewriteMesaSlots(src)).toBe(src)
  })

  test('rewrites a single slot to snippet + provideSlot', () => {
    const src = `<mesa:slot name="sidebar">\n  <div>hi</div>\n</mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('{#snippet sidebar()}')
    expect(out).toContain('{/snippet}')
    expect(out).toContain("{provideSlot('sidebar', sidebar)}")
    expect(out).not.toContain('<mesa:slot')
  })

  test('rewrites multiple slots independently', () => {
    const src = `
<mesa:slot name="sidebar"><div>side</div></mesa:slot>
<mesa:slot name="toolbar"><nav>nav</nav></mesa:slot>
<main>content</main>
`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('{#snippet sidebar()}')
    expect(out).toContain("{provideSlot('sidebar', sidebar)}")
    expect(out).toContain('{#snippet toolbar()}')
    expect(out).toContain("{provideSlot('toolbar', toolbar)}")
    expect(out).not.toContain('<mesa:slot')
  })

  test('preserves slot content exactly', () => {
    const src = `<mesa:slot name="sidebar">\n  <p class="foo">{params.id}</p>\n</mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('<p class="foo">{params.id}</p>')
  })

  test('auto-injects provideSlot into existing sierra/router import', () => {
    const src = `<script>\n  import { params, goto } from '@frontierjs/sierra/router'\n</script>\n<mesa:slot name="sidebar"><div/></mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain("import { params, goto, provideSlot } from '@frontierjs/sierra/router'")
  })

  test('auto-injects provideSlot into import ending with comma', () => {
    const src = `<script>\n  import {\n    params,\n    goto,\n  } from '@frontierjs/sierra/router'\n</script>\n<mesa:slot name="s"><div/></mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('provideSlot')
    expect(out).toContain("from '@frontierjs/sierra/router'")
  })

  test('auto-injects new import when no sierra/router import exists', () => {
    const src = `<script>\n  import { scan } from 'other'\n</script>\n<mesa:slot name="sidebar"><div/></mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain("import { provideSlot } from '@frontierjs/sierra/router'")
  })

  test('prepends script block when no script exists', () => {
    const src = `<mesa:slot name="sidebar"><div/></mesa:slot>\n<p>hello</p>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('<script>')
    expect(out).toContain("import { provideSlot } from '@frontierjs/sierra/router'")
  })

  test('does not double-inject provideSlot if already imported', () => {
    const src = `<script>\n  import { provideSlot } from '@frontierjs/sierra/router'\n</script>\n<mesa:slot name="s"><div/></mesa:slot>`
    const out = rewriteMesaSlots(src)
    const count = (out.match(/provideSlot/g) || []).length
    // Should appear: once in import, once in the rewritten call
    expect(count).toBe(2)
  })

  test('does not inject into <script module>', () => {
    const src = `<script module>\n  export const x = 1\n</script>\n<mesa:slot name="sidebar"><div/></mesa:slot>`
    const out = rewriteMesaSlots(src)
    // provideSlot import should NOT be inside the <script module> block
    const moduleBlock = out.match(/<script module>([\s\S]*?)<\/script>/)?.[1] ?? ''
    expect(moduleBlock).not.toContain('provideSlot')
    // Should have the import in a regular instance <script> block somewhere
    expect(out).toContain("import { provideSlot } from '@frontierjs/sierra/router'")
  })

  test('no warning emitted for <mesa:slot> named snippets', () => {
    // extractProvidedSlots should recognise mesa:slot tags
    const { warnUnexportedSnippets } = require('../src/build/warnings.js')
    // Use dynamic import for ESM
  })
})

describe('warnUnexportedSnippets — mesa:slot suppression', () => {
  const routesDir = '/project/src/routes'
  function collectWarnings(source, id = '/project/src/routes/page.mesa') {
    const { warnUnexportedSnippets } = require('../src/build/warnings.js')
    const warnings = []
    warnUnexportedSnippets(source, id, routesDir, (msg) => warnings.push(msg))
    return warnings
  }

  test('no warning for snippet declared via <mesa:slot name="X">', async () => {
    const { warnUnexportedSnippets } = await import('../src/build/warnings.js')
    const source = `
<script>
  import { params } from '@frontierjs/sierra/router'
</script>
<mesa:slot name="sidebar">
  <p>{params.id}</p>
</mesa:slot>
<div>page content</div>
`
    const warnings = []
    warnUnexportedSnippets(source, '/project/src/routes/page.mesa', routesDir, (m) => warnings.push(m))
    expect(warnings).toHaveLength(0)
  })
})

// ─── Reserved frontmatter keys ────────────────────────────────────────────────
//
// Frontmatter is spread onto `page`, so `{page.title}` works directly — but the
// router assigns its own fields afterwards and wins. A route declaring `data:`
// or `path:` would see its value silently replaced by the loader result or the
// URL. PAGE_RESERVED names those fields; this warns rather than letting it pass.

describe('warnReservedFrontmatter', () => {
  const RESERVED = ['path', 'params', 'meta', 'route', 'pending', 'data', 'error', 'slots']

  const collect = async (tree) => {
    const { warnReservedFrontmatter } = await import('../src/build/warnings.js')
    const out = []
    warnReservedFrontmatter(tree, RESERVED, (m) => out.push(m))
    return out
  }

  test('flags a reserved key', async () => {
    const out = await collect({
      id: 'blog', file: 'src/routes/blog/index.mesa',
      meta: { title: 'Blog', data: 'oops' }, children: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("'data' is reserved")
    expect(out[0]).toContain('page.meta.data')
  })

  test('ignores non-reserved keys', async () => {
    const out = await collect({
      id: 'blog', file: 'x.mesa',
      meta: { title: 'Blog', description: 'd', robots: 'index' }, children: [],
    })
    expect(out).toEqual([])
  })

  test('walks the whole tree', async () => {
    const out = await collect({
      id: 'root', file: 'a.mesa', meta: {}, children: [
        { id: 'a', file: 'b.mesa', meta: { path: '/x' }, children: [
          { id: 'b', file: 'c.mesa', meta: { slots: {} }, children: [] },
        ] },
      ],
    })
    expect(out).toHaveLength(2)
  })

  test('reports each file+key pair once', async () => {
    const node = { id: 'a', file: 'dup.mesa', meta: { data: 1, error: 2 }, children: [] }
    const out = await collect({ id: 'root', file: 'r.mesa', meta: {}, children: [node, node] })
    expect(out).toHaveLength(2)
  })

  test('tolerates a missing tree', async () => {
    expect(await collect(null)).toEqual([])
  })
})
