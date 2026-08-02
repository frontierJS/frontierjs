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
