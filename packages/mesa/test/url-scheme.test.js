/**
 * `href`, `src`, `action` and `formaction` may not name a scheme that executes.
 *
 * A URL out of a user-editable column reaches those four the way any other
 * bound attribute does, so `javascript:` there was script in the app's own
 * origin — and a static build baked the same string into a public file, since
 * the renderer runs this module too (FJS-858).
 *
 * Every refusal here is PAIRED with the legitimate value one character away.
 * A guard that refused `data:` outright, or that only fired on a lowercase
 * literal prefix, satisfies any test that asks about the attack alone.
 *
 * An attribute has one owner and three writers — `set_attribute`,
 * `bindAttribute` inside an effect, and `spreadAttributes` — and the compiler
 * picks between the first two per attribute, so a refusal in one of them is a
 * refusal that does not hold.
 */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as $rt from '../src/runtime.js'
import { compileSource } from '../src/compiler.js'
import { initRenderer, resetRenderer, renderToHTML } from '../src/render.js'

let warn
afterEach(() => { warn?.mockRestore(); warn = null })
const captureWarn = () => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) }

const spread = (el, obj) => {
  $rt.createRoot(() => $rt.spreadAttributes(el, () => obj))
  $rt.flushSync()
}

// The four sinks, each on the element that actually executes them.
const SINKS = [
  ['a', 'href'],
  ['img', 'src'],
  ['form', 'action'],
  ['button', 'formaction'],
]

const EXECUTABLE = [
  ['javascript:alert(1)',            'the plain scheme'],
  ['JaVaScRiPt:alert(1)',            'case'],
  ['Java\nscript:alert(1)',          'a newline inside the scheme'],
  ['java\tscript:alert(1)',          'a tab inside the scheme'],
  ['  \r\n javascript:alert(1)',     'leading whitespace'],
  ['\u0000javascript:alert(1)',      'a leading NUL'],
  ['data:text/html,<script>x</script>', 'a data document'],
  ['DATA:TEXT/HTML;base64,PHNjcmlwdD4=', 'a data document, base64 and uppercase'],
]

// The neighbours. Each is one character away from something above, or is the
// ordinary form of the same scheme.
const ORDINARY = [
  'https://example.com/x',
  '/orders/12',
  'orders/12',
  '//cdn.example.com/a.png',
  '#top',
  '?q=javascript:alert(1)',
  '/javascript:alert(1)',
  'mailto:someone@example.com',
  'tel:+441234567890',
  'blob:https://example.com/9a8b-7c6d',
  'data:image/png;base64,iVBORw0KGgo=',
  'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
]

describe('set_attribute — the static writer', () => {
  for (const [tag, attr] of SINKS) {
    for (const [value, why] of EXECUTABLE) {
      it(`drops ${attr} on <${tag}> — ${why}`, () => {
        captureWarn()
        const el = document.createElement(tag)
        $rt.set_attribute(el, attr, value)
        expect(el.getAttribute(attr)).toBeNull()
        expect(warn.mock.calls.join(' ')).toContain(attr)
      })
    }

    for (const value of ORDINARY) {
      it(`writes ${attr} on <${tag}> — ${value}`, () => {
        captureWarn()
        const el = document.createElement(tag)
        $rt.set_attribute(el, attr, value)
        expect(el.getAttribute(attr)).toBe(value)
        expect(warn).not.toHaveBeenCalled()
      })
    }
  }

  it('leaves an attribute that is not a URL sink alone', () => {
    captureWarn()
    const el = document.createElement('div')
    $rt.set_attribute(el, 'title', 'javascript:alert(1)')
    expect(el.getAttribute('title')).toBe('javascript:alert(1)')
    expect(warn).not.toHaveBeenCalled()
  })

  it('names the element and the attribute in the warning', () => {
    captureWarn()
    $rt.set_attribute(document.createElement('a'), 'href', 'javascript:alert(1)')
    const msg = warn.mock.calls[0].join(' ')
    expect(msg).toContain('[Mesa]')
    expect(msg).toContain('href')
    expect(msg).toContain('<a>')
  })
})

describe('bindAttribute — the reactive writer', () => {
  it('drops a refused href, and clears one already written', () => {
    captureWarn()
    const el = document.createElement('a')
    const [href, setHref] = $rt.createSignal('/orders/12')
    $rt.createRoot(() => $rt.bindAttribute(el, 'href', href))
    $rt.flushSync()
    expect(el.getAttribute('href')).toBe('/orders/12')

    setHref('javascript:alert(1)')
    $rt.flushSync()
    // The old destination is not kept: a link pointing somewhere the component
    // no longer says is a different lie from a missing href.
    expect(el.getAttribute('href')).toBeNull()
    expect(warn.mock.calls.join(' ')).toContain('href')
  })

  it('recovers when the value moves back to an ordinary URL', () => {
    captureWarn()
    const el = document.createElement('img')
    const [src, setSrc] = $rt.createSignal('javascript:alert(1)')
    $rt.createRoot(() => $rt.bindAttribute(el, 'src', src))
    $rt.flushSync()
    expect(el.getAttribute('src')).toBeNull()

    setSrc('data:image/png;base64,iVBORw0KGgo=')
    $rt.flushSync()
    expect(el.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})

describe('spreadAttributes — the third writer', () => {
  it('refuses href, which the property path would otherwise write', () => {
    captureWarn()
    const el = document.createElement('a')
    spread(el, { href: 'javascript:alert(1)' })
    expect(el.getAttribute('href')).toBeNull()
    expect(warn.mock.calls.join(' ')).toContain('href')
  })

  it('refuses the IDL spelling a spread key carries', () => {
    captureWarn()
    const el = document.createElement('button')
    spread(el, { formAction: 'javascript:alert(1)' })
    expect(el.getAttribute('formaction')).toBeNull()
    expect(el.formAction === '' || el.formAction == null ||
      !/^javascript:/.test(el.formAction)).toBe(true)
  })

  it('carries the ordinary neighbour', () => {
    captureWarn()
    const el = document.createElement('a')
    spread(el, { href: 'https://example.com/x' })
    expect(el.getAttribute('href')).toBe('https://example.com/x')
    expect(warn).not.toHaveBeenCalled()
  })

  it('clears a refused value that replaces one already carried', () => {
    captureWarn()
    const el = document.createElement('img')
    const [rec, setRec] = $rt.createSignal({ src: '/a.png' })
    $rt.createRoot(() => $rt.spreadAttributes(el, rec))
    $rt.flushSync()
    expect(el.getAttribute('src')).toBe('/a.png')

    setRec({ src: 'JaVaScRiPt:alert(1)' })
    $rt.flushSync()
    expect(el.getAttribute('src')).toBeNull()
  })
})

// ─── The prerendered half ─────────────────────────────────────────────────────
// A static build writes the answer into a file a CDN caches, so a refusal the
// browser makes and the renderer does not is a refusal that ships broken.

let n = 0
async function build(src) {
  const ctx = await compileSource(src, { filename: `/U${n}.mesa`, dev: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_url_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }
}

describe('the static render refuses what the runtime refuses', () => {
  beforeAll(() => { initRenderer() })
  afterAll(() => { resetRenderer() })

  const SRC = `
<script>
  export let link = ''
  export let photo = ''
</script>
<a href={link}>go</a>
<img src={photo}>
`

  it('bakes no javascript: URL into the output', async () => {
    captureWarn()
    const Comp = await build(SRC)
    const html = await renderToHTML(Comp, {
      link:  'Java\nscript:alert(1)',
      photo: 'javascript:alert(2)',
    })
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/Java\s*script:/i)
    expect(warn.mock.calls.join(' ')).toContain('href')
  })

  it('bakes the ordinary neighbour', async () => {
    captureWarn()
    const Comp = await build(SRC)
    const html = await renderToHTML(Comp, {
      link:  '/orders/12',
      photo: 'data:image/png;base64,iVBORw0KGgo=',
    })
    expect(html).toContain('href="/orders/12"')
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(warn).not.toHaveBeenCalled()
  })
})
