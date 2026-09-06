/**
 * `{...obj}` may not write markup or install a handler from a string.
 *
 * spreadAttributes decides attribute-vs-property by asking whether the key has
 * a setter anywhere on the prototype chain, so `innerHTML`, `outerHTML`,
 * `srcdoc` and every `on*` reached the property. The keys of a spread come from
 * DATA — `{...record}` over a fetched row, and `{...$attributes}` through every
 * kit component — so an object a remote party influences was a script sink with
 * the compiled component looking entirely ordinary (FJS-837).
 *
 * A refused key is WARNED by name: a spread that quietly stops carrying a key
 * is the silence FJS-612 was paid for.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as $rt from '../src/runtime.js'

const spread = (el, obj) => {
  $rt.createRoot(() => $rt.spreadAttributes(el, () => obj))
  $rt.flushSync()
}

let warn
afterEach(() => { warn?.mockRestore(); warn = null })
const captureWarn = () => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) }

describe('spreadAttributes — markup sinks', () => {
  for (const key of ['innerHTML', 'outerHTML']) {
    it(`refuses ${key} and leaves the element alone`, () => {
      captureWarn()
      const el = document.createElement('div')
      el.textContent = 'kept'
      spread(el, { [key]: '<i id="pwn">x</i>' })
      expect(el.querySelector('#pwn')).toBeNull()
      expect(el.textContent).toBe('kept')
      expect(el.getAttribute(key)).toBeNull()
      expect(warn.mock.calls.join(' ')).toContain(key)
    })
  }

  it('refuses srcdoc on an iframe, by property and by attribute', () => {
    captureWarn()
    const el = document.createElement('iframe')
    spread(el, { srcdoc: '<script>parent.__pwn=1<\/script>' })
    expect(el.getAttribute('srcdoc')).toBeNull()
    expect(el.srcdoc == null || el.srcdoc === '').toBe(true)
    expect(warn.mock.calls.join(' ')).toContain('srcdoc')
  })

  it('refuses text, which is a script element body', () => {
    captureWarn()
    const el = document.createElement('div')
    spread(el, { text: 'window.__pwn=1' })
    expect(el.textContent).toBe('')
    expect(el.getAttribute('text')).toBeNull()
  })

  it('names the element and the key in the warning', () => {
    captureWarn()
    spread(document.createElement('div'), { innerHTML: '<i></i>' })
    const msg = warn.mock.calls.join(' ')
    expect(msg).toContain('[Mesa]')
    expect(msg).toContain('innerHTML')
    expect(msg).toContain('{@html}')
  })
})

describe('spreadAttributes — event handlers', () => {
  it('refuses an on* key whose value is a string', () => {
    captureWarn()
    const el = document.createElement('button')
    spread(el, { onclick: 'window.__pwn=1' })
    expect(el.onclick).toBeFalsy()
    expect(el.getAttribute('onclick')).toBeNull()
    expect(warn.mock.calls.join(' ')).toContain('onclick')
  })

  it('still forwards a FUNCTION handler — the documented {...$attributes} case', () => {
    const el = document.createElement('button')
    let hits = 0
    spread(el, { onclick: () => { hits++ } })
    el.click()
    expect(hits).toBe(1)
  })
})

describe('spreadAttributes — ordinary keys are untouched', () => {
  it('writes plain attributes and DOM properties as before', () => {
    const el = document.createElement('input')
    spread(el, { id: 'a', 'data-x': '1', value: 'hello', title: 'ok' })
    expect(el.id).toBe('a')
    expect(el.getAttribute('data-x')).toBe('1')
    expect(el.value).toBe('hello')
    expect(el.getAttribute('title')).toBe('ok')
  })

  it('a key that merely CONTAINS html is not refused', () => {
    const el = document.createElement('div')
    spread(el, { 'data-innerhtml-note': 'x', htmlfor: 'y' })
    expect(el.getAttribute('data-innerhtml-note')).toBe('x')
  })
})
