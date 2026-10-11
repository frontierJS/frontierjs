/*
 * A string spread onto a boolean-reflecting property (FJS-2518).
 *
 * `<Input spellcheck="false">` forwarded through {...$attributes} reaches the
 * element as `el.spellcheck = 'false'`, where any non-empty string is true. In
 * markup the attribute parser reads the string, so the spread hands a string to
 * the attribute and keeps the property for real booleans.
 *
 * happy-dom has no `spellcheck`, so the property is installed on the prototype
 * the way a browser has it: an enumerated attribute read through a boolean.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as rt from '../src/runtime.js'

const proto = HTMLInputElement.prototype

beforeAll(() => {
  Object.defineProperty(proto, 'spellcheck', {
    configurable: true,
    get() { return this.getAttribute('spellcheck') !== 'false' },
    set(v) { this.setAttribute('spellcheck', v ? 'true' : 'false') },
  })
})
afterAll(() => { delete proto.spellcheck })

const input = () => {
  const d = document.createElement('input')
  document.body.appendChild(d)
  return d
}

describe('a string spread onto a boolean property', () => {
  it('spellcheck="false" is read as false, not as a non-empty string', () => {
    const d = input()
    rt.spreadAttributes(d, () => ({ spellcheck: 'false' }))
    rt.flushSync()
    expect(d.getAttribute('spellcheck')).toBe('false')
    expect(d.spellcheck).toBe(false)
  })

  it('a real boolean still goes to the property', () => {
    const d = input()
    rt.spreadAttributes(d, () => ({ spellcheck: false, disabled: true }))
    rt.flushSync()
    expect(d.spellcheck).toBe(false)
    expect(d.disabled).toBe(true)
  })

  it('a string on a value property is still a property write', () => {
    const d = input()
    rt.spreadAttributes(d, () => ({ value: 'abc' }))
    rt.flushSync()
    expect(d.value).toBe('abc')
  })
})
