// @vitest-environment happy-dom
/**
 * tests/dev-overlay.test.js — the dev overlay renders text somebody else wrote.
 *
 * The overlay is a string of client JS that builds its panel with `innerHTML`.
 * That was self-inflicted while every value in it came off the local disk — a
 * filename. It is not any more: the router reports 'redirect', 'navigation' and
 * 'component' failures through `__sierraReportError`, and two of those three
 * pass a URL, which carries whatever a link on the page put in it.
 *
 * The script cannot be imported — it is source, not a module, and it uses
 * `import.meta` — so it is evaluated here the way a browser would, with the hot
 * handle stubbed. That is what makes this a test of the shipped string rather
 * than of a copy.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { generateOverlayScript } from '../src/build/dev-overlay.js'

/** Evaluate the generated overlay against this document. */
function bootOverlay() {
  const src = generateOverlayScript()
    // `import.meta` is a syntax error inside `new Function`, and the guard is
    // the only thing that reads it.
    .replace('import.meta.env.DEV && import.meta.hot', 'true')
    .replace(/import\.meta\.hot/g, '__hot')
  const hot = { on() {}, send() {} }
  new Function('__hot', 'window', 'document', src)(hot, globalThis.window, globalThis.document)
  return globalThis.window.__sierraError
}

const PAYLOAD = '"><img src=x onerror="globalThis.__pwned=1">'

describe('dev overlay escaping', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete globalThis.__pwned
  })

  test('the generated script is parseable JS', () => {
    expect(() => bootOverlay()).not.toThrow()
  })

  test('a hostile file value cannot inject an element', () => {
    const show = bootOverlay()
    show({ message: 'boom', file: `/orders/${PAYLOAD}`, type: 'navigation' })

    const overlay = document.getElementById('__sierra_overlay__')
    expect(overlay).toBeTruthy()
    expect(overlay.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    // …and the value is still SHOWN. A guard that dropped the field entirely
    // would satisfy the assertion above and make the overlay useless.
    expect(overlay.textContent).toContain('img src=x')
  })

  test('a hostile file value cannot break out of the copy button attribute', () => {
    const show = bootOverlay()
    show({ message: 'boom', file: `/orders/${PAYLOAD}`, type: 'navigation' })

    const btn = document.querySelector('[data-file]')
    // The attribute round-trips to the value the caller passed — escaping is
    // not truncation.
    expect(btn.dataset.file).toBe(`/orders/${PAYLOAD}`)
    expect(document.querySelector('img')).toBe(null)
  })

  test('message, stack and type are escaped too — every field, not the one that was reported', () => {
    const show = bootOverlay()
    show({ message: PAYLOAD, file: null, type: PAYLOAD, stack: `at x\n${PAYLOAD}` })

    const overlay = document.getElementById('__sierra_overlay__')
    expect(overlay.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    expect(document.querySelector('[data-type]').dataset.type).toBe(PAYLOAD)
  })

  test('a message that is not a string does not throw', () => {
    const show = bootOverlay()
    // `message.replace(…)` was called directly on the field.
    expect(() => show({ message: undefined, file: undefined, type: 'error' })).not.toThrow()
  })
})
