/**
 * attr-escape.test.js — a `"` in a static attribute value must not mint a new
 * attribute.
 *
 * The emitter wraps every static attribute value in double quotes on its way
 * into the template string, which `innerHTML` parses back. A value carrying a
 * `"` — which a single-quoted or an unquoted source attribute can — closed its
 * own attribute, and the rest of the value was re-parsed as further attributes:
 * `title='a" onmouseover="alert(1)'` shipped a live handler. It reaches page
 * content through `.md`, where rehype runs with `allowDangerousHtml` (FJS-829).
 *
 * `&` is deliberately NOT escaped: the value here is the attribute's source
 * text, entities and all, so `&quot;` would become `&amp;quot;` and an author's
 * escape would render as literal text.
 */
import { describe, test, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import { renderComponent } from '../src/render-component.js'

async function template(src) {
  const ctx = await compile(src, { name: 'T', filename: '/t/T.mesa', css: false, loc: false, warning: () => {} })
  const m = ctx.result.match(/\$\$runtime\.template\(`([\s\S]*?)`, \d+\)/)
  return m?.[1] ?? null
}

describe('a static attribute value is escaped into the template', () => {

  test('a single-quoted value carrying a double quote', async () => {
    expect(await template(`<div title='a"b'>x</div>`))
      .toBe('<div title="a&quot;b">x</div>')
  })

  test('the injection: the handler stays inside the value', async () => {
    const out = await template(`<div title='a" onmouseover="alert(1)'>x</div>`)
    expect(out).toBe('<div title="a&quot; onmouseover=&quot;alert(1)">x</div>')
    expect(out).not.toContain(' onmouseover="')
  })

  test('an unquoted value carrying a double quote', async () => {
    expect(await template(`<div title=a"b>x</div>`))
      .toBe('<div title="a&quot;b">x</div>')
  })

  test('an ampersand is left alone, so an entity survives one pass', async () => {
    expect(await template(`<a href="?a=1&b=2">x</a>`))
      .toBe('<a href="?a=1&b=2">x</a>')
    expect(await template(`<div title="&quot;q&quot;">x</div>`))
      .toBe('<div title="&quot;q&quot;">x</div>')
  })

  test('class, which is diverted into the scope-class set and re-emitted', async () => {
    // `class` never reaches the serializer's escape: the value is split into
    // node.class and written again by the CSS scoper.
    const out = await template(`<div class='a" onmouseover="alert(1)'>x</div>`)
    // The scope class is appended after the authored names; the hash is not
    // the assertion here.
    expect(out).toMatch(/^<div class="a&quot; onmouseover=&quot;alert\(1\) \w+">x<\/div>$/)
    expect(out).not.toContain(' onmouseover="')
  })

  test('rendered, the handler is text rather than an attribute', async () => {
    const out = await renderComponent(`<span title='a" onmouseover="alert(1)'>hover</span>`, {
      filename: '/t/T.mesa'
    })
    const html = out.html ?? out
    // Asked of a parser rather than of the text: the point is how many
    // attributes the browser ends up with, not how the value was spelled.
    const host = document.createElement('div')
    host.innerHTML = html
    const el = host.querySelector('span')
    expect(el.getAttributeNames()).toEqual(['title'])
    expect(el.getAttribute('title')).toBe('a" onmouseover="alert(1)')
  })

})
