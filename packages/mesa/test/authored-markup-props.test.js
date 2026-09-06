/**
 * An AUTHORED `innerHTML=` writes no markup — `FJS-D206`.
 *
 * `set_attribute` decided property-vs-attribute from a fixed list of DOM
 * property names, and three of them parse or replace content, so
 * `<div innerHTML={h}>` rendered `h` as markup. Not the spread hole
 * (`FJS-837`): there the KEY comes from data, here the author wrote it, which
 * is the same thing that makes `{@html}` acceptable.
 *
 * The objection is that there were two spellings and only one announces
 * itself. `{@html}` is a construct a reader stops at and VISION RULE 33 warns
 * about it; an attribute among other attributes reads as ordinary markup. The
 * three keys fall through to `setAttribute`, where they are inert.
 */

import { describe, it, expect } from 'vitest'
import * as $rt from '../src/runtime.js'

describe('{@html} is the only way to write markup from a value', () => {
  for (const key of ['innerHTML', 'textContent', 'innerText']) {
    it(`an authored ${key}= sets an attribute and replaces no content`, () => {
      const el = document.createElement('div')
      el.appendChild(document.createTextNode('kept'))
      $rt.set_attribute(el, key, '<i id="pwn">x</i>')
      expect(el.querySelector('#pwn')).toBeNull()
      expect(el.textContent).toBe('kept')
      expect(el.getAttribute(key)).toBe('<i id="pwn">x</i>')
    })

    it(`a null ${key} removes the attribute and still leaves content alone`, () => {
      const el = document.createElement('div')
      el.appendChild(document.createTextNode('kept'))
      $rt.set_attribute(el, key, 'x')
      $rt.set_attribute(el, key, null)
      expect(el.getAttribute(key)).toBeNull()
      expect(el.textContent).toBe('kept')
    })
  }

  it('{@html} still writes markup — the one owner of that job', () => {
    const frag = $rt.htmlToFragment('<i id="pwn">x</i>')
    const host = document.createElement('div')
    host.appendChild(frag)
    expect(host.querySelector('#pwn')).not.toBeNull()
  })

  it('value is still a property, so the dirty-flag rule is untouched', () => {
    const el = document.createElement('input')
    $rt.set_attribute(el, 'value', 'typed')
    expect(el.value).toBe('typed')
  })
})
