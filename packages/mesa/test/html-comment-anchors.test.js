/**
 * `{@html}` content and Mesa's own anchors are both Comment nodes, and the
 * static renderer strips the anchors (`FJS-906`).
 *
 * They used to be told apart by shape — a named anchor is space-padded — which
 * is exactly what a hand-written comment looks like, so an author's comment was
 * deleted from their own markup on every static render. The anchors are now
 * `$`-prefixed and the prefix is the whole of the test.
 *
 * A node property cannot carry this: the named anchors are written into the
 * compiled TEMPLATE STRING and become Comment nodes by parsing, never by
 * `createComment`, so there is nothing to mark at the point they are made.
 */
import { describe, it, expect } from 'vitest'
import { renderComponent } from '../src/render-component.js'

const render = (src, opts = {}) => renderComponent(src, { cwd: '/tmp/mesa', ...opts })

describe('an author comment through {@html}', () => {
  it('survives the anchor strip', async () => {
    const { html } = await render(
      `<script>const h = '<p><!-- keep me --></p>'</script>\n<div>{@html h}</div>`)
    expect(html).toContain('<!-- keep me -->')
  })

  it('survives beside a block directive, whose anchors do not', async () => {
    const { html } = await render(
      `<script>let n = 1\nconst h = '<!-- mine -->'</script>\n` +
      `<div>{#if n}<p>a</p>{/if}{@html h}</div>`)
    expect(html).toContain('<!-- mine -->')
    expect(html).not.toContain('<!---->')
    expect(html).not.toContain('mesa-root')
  })

  it('a conditional comment for Outlook still survives', async () => {
    // The email kit emits these through {@html}; they have no `$`.
    const { html } = await render(
      `<script>const h = '<!--[if mso]>x<![endif]-->'</script>\n<div>{@html h}</div>`)
    expect(html).toContain('[if mso]')
  })
})

describe('Mesa\'s own anchors are still removed', () => {
  it('the empty block anchors and the root', async () => {
    const { html } = await render(
      `<script>let n = 1</script>\n<div>{#if n}<p>a</p>{/if}{#each [1, 2] as x}<b>{x}</b>{/each}</div>`)
    expect(html).not.toMatch(/<!--/)
    expect(html).toContain('<b>1</b><b>2</b>')     // the content is still there
  })

  it('a $-prefixed comment an author writes is taken as Mesa\'s', async () => {
    // Stated rather than defended: the prefix is a claim on the namespace, so
    // a deliberate collision goes the same way it always did.
    const { html } = await render(
      `<script>const h = '<!--$ mine -->'</script>\n<div>{@html h}</div>`)
    expect(html).not.toContain('mine')
  })
})

describe('an EMPTY comment through {@html} (Svelte #14323\'s shape)', () => {
  // Rendering a component to a string and splicing it into {@html} is how this
  // is met in practice: the output is full of `<!---->` block anchors, and a
  // renderer that treats an empty comment as its own eats them. Svelte hit it
  // from the hydration side and the answer was the same — mark your own and
  // ignore every other comment.
  it('survives', async () => {
    const { html } = await render(
      `<script>const h = '<p>a<!---->b</p>'</script>\n<div>{@html h}</div>`)
    expect(html).toContain('<!---->')
    expect(html).toContain('a<!---->b')
  })

  it('and Mesa\'s own block anchors in the same render still go', async () => {
    const { html } = await render(
      `<script>let n = 1\nconst h = '<i><!----></i>'</script>\n` +
      `<div>{#if n}<p>a</p>{/if}{@html h}</div>`)
    expect(html).toContain('<i><!----></i>')
    expect(html).not.toContain('<!--$')
    expect(html).not.toContain('mesa-root')
  })
})
