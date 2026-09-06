/*
 * A spread key the DOM refuses as an attribute name (FJS-872).
 *
 * A spread's keys come from data, so one of them can be any string at all. The
 * DOM answers a name it cannot accept with a thrown `InvalidCharacterError`,
 * and an unguarded throw inside `spreadAttributes`' effect escapes the render:
 * one bad key took the whole page down, naming neither the component nor the
 * attribute.
 *
 * Every refusal here is PAIRED with a legitimate key on the SAME element, which
 * is the whole test — a guard that skipped everything, or an element that failed
 * to render at all, satisfies any assertion that only asks about the bad key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as rt from '../src/runtime.js'

const el = () => {
  const d = document.createElement('div')
  document.body.appendChild(d)
  return d
}

describe('a spread key the DOM refuses as an attribute name', () => {
  let warn
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  it('skips the bad name and still writes the good ones', () => {
    const d = el()
    expect(() => {
      rt.spreadAttributes(d, () => ({ 'a b': 'x', title: 'kept', 'data-ok': '1' }))
      rt.flushSync()
    }).not.toThrow()
    expect(d.getAttribute('title')).toBe('kept')
    expect(d.getAttribute('data-ok')).toBe('1')
    expect(d.hasAttribute('a b')).toBe(false)
  })

  it('names the attribute and the element', () => {
    const d = el()
    rt.spreadAttributes(d, () => ({ 'a=b': 'x' }))
    rt.flushSync()
    const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(msg).toMatch(/a=b/)
    expect(msg).toMatch(/<div>/)
  })

  it('a quote in the name is refused the same way', () => {
    const d = el()
    expect(() => {
      rt.spreadAttributes(d, () => ({ 'a"b': 'x', title: 'kept' }))
      rt.flushSync()
    }).not.toThrow()
    expect(d.getAttribute('title')).toBe('kept')
  })

  // The negative controls. A guard that swallowed everything, or one that
  // treated any unusual key as hostile, passes every assertion above.
  it('an ordinary attribute is untouched', () => {
    const d = el()
    rt.spreadAttributes(d, () => ({ 'data-x': '1', 'aria-label': 'hi' }))
    rt.flushSync()
    expect(d.getAttribute('data-x')).toBe('1')
    expect(d.getAttribute('aria-label')).toBe('hi')
    expect(warn).not.toHaveBeenCalled()
  })

  it('an error that is not a bad name still escapes', () => {
    const d = el()
    Object.defineProperty(d, 'title', {
      set() { throw new TypeError('boom') }, configurable: true
    })
    expect(() => {
      rt.spreadAttributes(d, () => ({ title: 'x' }))
      rt.flushSync()
    }).toThrow(/boom/)
  })
})
