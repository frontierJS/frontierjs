// @vitest-environment happy-dom
/**
 * tests/widget-runtime.test.js — the two cases a taken tag can be, which the
 * registry alone cannot tell apart.
 *
 * `customElements.define` throws on a name already taken, so `embed` guards on
 * `customElements.get(tag)` — correct, and it makes *the same widget's script
 * loaded twice* (fine, and the common case) look exactly like *this tag belongs
 * to somebody else* (the widget never renders and nothing says so). A stamp on
 * the class is what separates them.
 *
 * Everything else about the runtime needs a real browser and is in
 * `tests/fixtures/widget-site/test/verify.mjs`: shadow isolation, a delegated
 * click, a CSP, a DOM move, a host element that cannot be mounted into.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { embed } from '../src/widget/index.js'

const Component = (anchor, props) => {}

let warned
beforeEach(() => { warned = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warned.mockRestore())

describe('a tag that is already registered', () => {
  test('the same widget loaded twice says nothing', () => {
    // Two copies of one script on a host page — a tag manager firing again, the
    // snippet in a header template and in a page block. The second copy finds a
    // Sierra widget on the tag and leaves it alone.
    embed(Component, { name: 'Twice', prefix: 'mt-' })
    embed(Component, { name: 'Twice', prefix: 'mt-' })
    expect(warned).not.toHaveBeenCalled()
  })

  test('a tag the host page already owns is reported', () => {
    // The negative control's other half: identical from the registry's point of
    // view, and a completely different thing. The widget will not render, and
    // silence here is a merchant looking at a blank box.
    customElements.define('mt-squatter', class extends HTMLElement {})
    embed(Component, { name: 'Squatter', prefix: 'mt-' })
    expect(warned).toHaveBeenCalledTimes(1)
    expect(String(warned.mock.calls[0][0])).toMatch(/mt-squatter/)
  })

  test('the widget still answers its own tag and selector', () => {
    customElements.define('mt-taken', class extends HTMLElement {})
    const w = embed(Component, { name: 'Taken', prefix: 'mt-', selector: '.mt-taken' })
    expect(w.tag).toBe('mt-taken')
    expect(w.selector).toBe('.mt-taken')
  })
})

describe('the tag itself', () => {
  test('a dashless tag is refused where it is computed', () => {
    expect(() => embed(Component, { name: 'Solo', prefix: '' })).toThrow(/valid custom element name/)
  })

  test('…and the same name under a prefix is not', () => {
    expect(() => embed(Component, { name: 'Solo', prefix: 'mt-' })).not.toThrow()
  })
})
