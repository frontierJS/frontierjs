/**
 * text-entities.test.js — an entity beside an `{expression}` decodes (FJS-1537).
 *
 * A text node holding only text reaches the page through innerHTML (or
 * htmlEntitiesToText), which decode. One that also holds an `{expression}` is
 * written with `nodeValue = \`…\``, which decodes nothing: `&copy; {year}`
 * showed "&copy; 2026" on the client and "&amp;copy; 2026" from the server.
 * Asserted on RENDERED output, because what the reader sees is the claim.
 */

import { describe, it, expect } from 'vitest'
import { renderComponent } from '../src/render-component.js'
import { htmlEntitiesToText } from '../src/compiler.js'

const render = async (body, script = 'const year = 2026\n  const n = 3') => {
  const { html } = await renderComponent(
    `<script>\n  ${script}\n</script>\n${body}`,
    { cwd: '/tmp/mesa', target: 'fragment' }
  )
  return html
}

describe('entity beside an expression', () => {
  it('decodes a named entity', async () => {
    expect(await render('<p>&copy; {year} X</p>')).toContain('© 2026 X')
  })

  it('decodes &amp; and does not re-escape the result', async () => {
    const html = await render('<p>{n} &amp; more</p>')
    expect(html).toContain('3 &amp; more')
    expect(html).not.toContain('&amp;amp;')
  })

  it('decodes a numeric reference', async () => {
    expect(await render('<p>&#169; {year} &#x2014; {n}</p>')).toContain('© 2026 — 3')
  })

  it('decodes in ONE pass: &amp;lt; is the text "&lt;", never "<"', async () => {
    expect(await render('<p>{n} &amp;lt;</p>')).toContain('3 &amp;lt;')
  })

  it('leaves an unknown name as written', async () => {
    expect(await render('<p>&nosuchthing; {n}</p>')).toContain('&amp;nosuchthing; 3')
  })

  it('matches the same entity with no expression beside it', async () => {
    expect(await render('<p>&copy; 2026</p>')).toContain('© 2026')
  })

  it('does not decode what an expression evaluated to', async () => {
    expect(await render("<p>&copy; {'&copy;'}</p>")).toContain('© &amp;copy;')
  })
})

describe('htmlEntitiesToText', () => {
  it('decodes in one pass', () => {
    expect(htmlEntitiesToText('&amp;lt; &lt; &copy; &#169;')).toBe('&lt; < © ©')
  })
})
