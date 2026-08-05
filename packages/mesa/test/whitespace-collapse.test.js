/**
 * whitespace-collapse.test.js
 *
 * A newline inside a text node is whitespace, not nothing.
 *
 * compactDOM used to delete every newline-plus-indent run in a text node, so any
 * paragraph wrapped across source lines came out with the words welded
 * together — `its 401s and its\n  400s` → `its400s`. It was found by reading a
 * rendered page, because nothing about the source looks wrong.
 *
 * The rule now: a text node with content collapses whitespace runs to one
 * space (what HTML says they mean); a whitespace-only node keeps the old
 * behaviour, because the DOM traversal counts those nodes and changing which
 * ones survive desyncs refer().
 */

import { describe, it, expect } from 'vitest'
import { renderComponent } from '../src/render-component.js'

const render = (src) => renderComponent(src, { cwd: '/tmp/mesa', target: 'fragment' })

describe('compactDOM — whitespace in text nodes', () => {
  it('a newline between two words is a space', async () => {
    const { html } = await render(`<p>alpha beta\n  gamma delta</p>`)
    expect(html).toContain('alpha beta gamma delta')
  })

  it('a newline after an inline element is a space', async () => {
    const { html } = await render(`<p>one <code>two</code>\n  three</p>`)
    expect(html).toContain('<code>two</code> three')
  })

  it('a newline before an inline element is a space', async () => {
    const { html } = await render(`<p>one\n  <code>two</code></p>`)
    expect(html).toContain('one <code>two</code>')
  })

  it('collapses a run of whitespace rather than preserving it', async () => {
    const { html } = await render(`<p>alpha\n\n\n     beta</p>`)
    expect(html).toContain('alpha beta')
  })

  it('still drops the indentation between block elements', async () => {
    const { html } = await render(`<div>\n  <span>a</span>\n  <span>b</span>\n</div>`)
    expect(html).toContain('<span>a</span><span>b</span>')
  })

  it('keeps a deliberate single space between inline elements', async () => {
    const { html } = await render(`<p><b>a</b> <b>b</b></p>`)
    expect(html).toContain('<b>a</b> <b>b</b>')
  })

  it('interpolation is unaffected — the text around it still spaces', async () => {
    const { html } = await renderComponent(
      `<script>export let n = 2</script><p>one\n  {n}\n  three</p>`,
      { data: { n: 2 }, cwd: '/tmp/mesa', target: 'fragment' },
    )
    expect(html.replace(/<!--[^>]*-->/g, '')).toContain('one 2 three')
  })
})
