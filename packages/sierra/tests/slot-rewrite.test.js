/**
 * slot-rewrite.test.js — Tests for Sierra's slot compile-time rewrites
 */
import { describe, it, expect } from 'vitest'
import { rewriteLayoutSlots, rewriteMesaSlots } from '../src/build/slot-rewrite.js'

// ── rewriteMesaSlots (page side) ──────────────────────────────────────────────

describe('rewriteMesaSlots', () => {
  it('rewrites <mesa:slot name="X"> to snippet + provideSlot', () => {
    const src = `
<mesa:slot name="sidebar">
  <div>Sidebar content</div>
</mesa:slot>
<p>Main</p>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('{#snippet sidebar()}')
    expect(out).toContain("{provideSlot('sidebar', sidebar)}")
    expect(out).toContain('Sidebar content')
  })

  it('auto-injects provideSlot import when missing', () => {
    const src = `<mesa:slot name="sidebar"><p>hi</p></mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain("import { provideSlot } from '@frontierjs/sierra/router'")
  })

  it('adds provideSlot to existing sierra/router import', () => {
    const src = `
<script>
  import { params } from '@frontierjs/sierra/router'
</script>
<mesa:slot name="sidebar"><p>hi</p></mesa:slot>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('params, provideSlot')
    // Should not duplicate the import
    expect(out.split("from '@frontierjs/sierra/router'").length).toBe(2)
  })

  it('does not modify source with no mesa:slot tags', () => {
    const src = `<p>Hello world</p>`
    expect(rewriteMesaSlots(src)).toBe(src)
  })

  it('handles multiple named slots', () => {
    const src = `
<mesa:slot name="header"><h1>Title</h1></mesa:slot>
<mesa:slot name="sidebar"><nav>Nav</nav></mesa:slot>
<p>Main</p>`
    const out = rewriteMesaSlots(src)
    expect(out).toContain('{#snippet header()}')
    expect(out).toContain('{#snippet sidebar()}')
    expect(out).toContain("provideSlot('header', header)")
    expect(out).toContain("provideSlot('sidebar', sidebar)")
  })
})

// ── rewriteLayoutSlots (layout side) ─────────────────────────────────────────

describe('rewriteLayoutSlots', () => {
  it('rewrites <slot name="X" /> to a page.slots conditional render', () => {
    const src = `
<script>
  export let children = null
</script>
<div>
  <slot name="sidebar" />
  <slot />
</div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('__slot_sidebar')
    expect(out).toContain('{@render __slot_sidebar()}')
    expect(out).toContain('{@render children?.()}')
  })

  it('rewrites <slot name="X">fallback</slot> with fallback content', () => {
    const src = `
<script>import { page } from '@frontierjs/sierra/router'</script>
<div>
  <slot name="sidebar">
    <p>Default sidebar</p>
  </slot>
</div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('{:else}')
    expect(out).toContain('Default sidebar')
    expect(out).toContain('__slot_sidebar')
  })

  it('rewrites $slots.X to __slot_X', () => {
    const src = `
<script>import { page } from '@frontierjs/sierra/router'</script>
<div>
  {#if $slots.sidebar}
    <aside><slot name="sidebar" /></aside>
  {/if}
</div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('__slot_sidebar')
    expect(out).not.toContain('$slots.sidebar')
  })

  it('auto-injects the page import when missing', () => {
    const src = `
<script>
  export let children = null
</script>
<div><slot name="sidebar" /><slot /></div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain("import { page } from '@frontierjs/sierra/router'")
  })

  it('adds page to an existing sierra/router import', () => {
    const src = `
<script>
  import { isActive } from '@frontierjs/sierra/router'
  export let children = null
</script>
<div><slot name="sidebar" /><slot /></div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('isActive, page')
  })

  it('injects __slot_ let + page.slots watch for each named slot', () => {
    const src = `
<script>
  import { pageSlots } from '@frontierjs/sierra/router'
</script>
<div><slot name="sidebar" /><slot /></div>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('let __slot_sidebar = null')
    expect(out).toContain("$: page.slots, () => { __slot_sidebar = page.slots.sidebar ?? null }")
  })

  it('does not modify source with no slot elements', () => {
    const src = `<div><p>No slots here</p></div>`
    expect(rewriteLayoutSlots(src)).toBe(src)
  })

  it('rewrites default <slot /> to children render', () => {
    const src = `
<script>import { page } from '@frontierjs/sierra/router'</script>
<main><slot /></main>`
    const out = rewriteLayoutSlots(src)
    expect(out).toContain('{@render children?.()}')
    expect(out).not.toContain('<slot />')
  })
})

// ── default slot must declare the prop it renders ────────────────────────────
//
// `<slot />` expands to {@render children?.()}. Nothing declared `children`, so
// the Mesa compiler emitted a reference to $$snippet_children and the layout
// threw "ReferenceError: $$snippet_children is not defined" at mount — a blank
// page, with the build reporting success.
//
// The test above this block passed the whole time: it asserted the rewritten
// STRING contained {@render children?.()}, which was true. Nothing ever ran it.

describe('rewriteLayoutSlots — default slot prop declaration', () => {

  it('declares children when <slot /> is used with an existing script', () => {
    const out = rewriteLayoutSlots(`
<script>
  import { page } from '@frontierjs/sierra/router'
</script>
<div><slot /></div>`)

    expect(out).toContain('export let children = null')
    expect(out).toContain('{@render children?.()}')
  })

  it('declares children for <slot>fallback</slot> too', () => {
    const out = rewriteLayoutSlots(`
<script>
  let x = 1
</script>
<div><slot>nothing here</slot></div>`)

    expect(out).toContain('export let children = null')
  })

  it('creates a script block for a layout that has none', () => {
    const out = rewriteLayoutSlots(`<main><slot /></main>`)

    expect(out).toContain('<script>')
    expect(out).toContain('export let children = null')
    expect(out).toContain('{@render children?.()}')
  })

  it('does not double-declare when the author already did', () => {
    const out = rewriteLayoutSlots(`
<script>
  export let children = null
</script>
<div><slot /></div>`)

    expect(out.match(/export\s+let\s+children/g)).toHaveLength(1)
  })

  it('declares children alongside named slot locals when both are used', () => {
    const out = rewriteLayoutSlots(`
<script>
  import { page } from '@frontierjs/sierra/router'
</script>
<div><slot name="sidebar" /><slot /></div>`)

    expect(out).toContain('export let children = null')
    expect(out).toContain('__slot_sidebar')
  })

  it('does not declare children when only named slots are used', () => {
    // A phantom `children` prop on a layout that never renders it would be
    // dead surface area, and would change what the component accepts.
    const out = rewriteLayoutSlots(`
<script>
  import { page } from '@frontierjs/sierra/router'
</script>
<div><slot name="sidebar" /></div>`)

    expect(out).not.toContain('export let children')
    expect(out).toContain('__slot_sidebar')
  })

  it('never injects into <script module>', () => {
    // An export there is a module export, not a prop declaration.
    const out = rewriteLayoutSlots(`
<script module>
  export const prerender = true
</script>
<script>
  let x = 1
</script>
<div><slot /></div>`)

    const moduleBlock = out.slice(out.indexOf('<script module>'), out.indexOf('</script>'))
    expect(moduleBlock).not.toContain('export let children')
    expect(out).toContain('export let children = null')
  })

  it('leaves a layout with no slots completely untouched', () => {
    const src = `
<script>
  let x = 1
</script>
<div>no slots here</div>`
    expect(rewriteLayoutSlots(src)).toBe(src)
  })
})

// ── a name the rewriter cannot express ───────────────────────────────────────
//
// A slot name becomes a snippet name, so it has to be a legal identifier. That
// constraint used to live only in the MATCH: a tag whose name did not fit was
// simply not rewritten, Mesa dropped the unknown element and everything inside
// it, and the content and the fallback both vanished with nothing said
// (`FJS-800`). `side-bar` and `page-header` are the natural spellings.

describe('a slot name that is not a bare identifier', () => {
  it('refuses a hyphenated name on the page side, naming the file', () => {
    expect(() => rewriteMesaSlots('<mesa:slot name="side-bar">hi</mesa:slot>', 'src/routes/a.mesa'))
      .toThrow(/src\/routes\/a\.mesa.*side-bar/s)
  })

  it('refuses a hyphenated name on the layout side', () => {
    expect(() => rewriteLayoutSlots('<div><slot name="side-bar">fb</slot></div>', 'src/routes/_module.mesa'))
      .toThrow(/side-bar/)
  })

  it('refuses a self-closing hyphenated slot, which rewrites through a different branch', () => {
    expect(() => rewriteLayoutSlots('<div><slot name="page-header" /></div>'))
      .toThrow(/page-header/)
  })

  it('refuses an expression name — the value is not knowable at compile time', () => {
    expect(() => rewriteLayoutSlots('<div><slot name={x}>fb</slot></div>'))
      .toThrow(/\{x\}/)
  })

  it('names a spelling that would work', () => {
    expect(() => rewriteMesaSlots('<mesa:slot name="side-bar">hi</mesa:slot>'))
      .toThrow(/'sideBar'/)
  })

  // The negative controls. A guard that refuses every slot satisfies every
  // assertion above (`FJS-351`), so the legal spellings have to keep rewriting
  // — including the two nameless forms, which carry no name to judge.
  it('a legal name still rewrites, both sides', () => {
    expect(rewriteMesaSlots('<mesa:slot name="sideBar">hi</mesa:slot>'))
      .toContain("{provideSlot('sideBar', sideBar)}")
    expect(rewriteLayoutSlots('<div><slot name="sideBar">fb</slot></div>'))
      .toContain('__slot_sideBar')
  })

  it('a default slot carries no name and is untouched', () => {
    expect(rewriteLayoutSlots('<div><slot /></div>')).toContain('{@render children?.()}')
    expect(rewriteLayoutSlots('<div><slot>fallback</slot></div>')).toContain('{@render children?.()}')
  })
})
