// @vitest-environment happy-dom
/**
 * tests/devtools-escaping.test.js — the toolbar renders text somebody else wrote.
 *
 * Every value here arrives over the devtools WebSocket, which is
 * unauthenticated, and the toolbar sits at `z-index: 2147483647` on the page
 * where the app's own tokens live. Dev-only is why this is not S2; it is not
 * why it is safe.
 *
 * The tabs each carried their own copy of an `esc()` helper and applied it to
 * six of the eight interpolations that needed one — `transport` went into a
 * `class=""` attribute whole, and `log.level` went into a text position whole.
 * So this file grades EVERY field of every row rather than the one that was
 * reported: the defect is the per-site helper, and a test that only covers the
 * site that was found leaves the class in place.
 *
 * The negative control runs beside each refusal — the hostile value is still
 * SHOWN, and a legitimate value still gets its class. A renderer that dropped
 * or blanked the field satisfies any assertion that only checks for the absence
 * of the injected element.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { createBuffer } from '../src/devtools/buffer.js'
import { createRequestsTab } from '../src/devtools/tabs/requests.js'
import { createLogsTab } from '../src/devtools/tabs/logs.js'
import { createEventsTab } from '../src/devtools/tabs/events.js'
import { createConnectionsTab } from '../src/devtools/tabs/connections.js'
import { buildWaterfallEl } from '../src/devtools/waterfall.js'
import { html, classSuffix, num } from '../src/devtools/html.js'

const ATTR = 'http" onmouseover="globalThis.__pwned=1" x="'
const TEXT = '<img src=x onerror="globalThis.__pwned=1">'

function req(extra = {}) {
  return {
    id: 'r1', ts: Date.now(), durationMs: 5, status: 'ok',
    service: 'orders', method: 'find', user: 'alice', transport: 'ws',
    ...extra,
  }
}

beforeEach(() => { delete globalThis.__pwned })

describe('the requests row', () => {
  test('a hostile transport cannot break out of the badge class attribute', () => {
    const buf = createBuffer()
    buf.addRequest(req({ transport: ATTR }))
    const tab = createRequestsTab(buf, {})
    tab.render()

    expect(tab.el.querySelector('[onmouseover]')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    // …and it is still readable. Escaping is not truncation.
    expect(tab.el.textContent).toContain('onmouseover')
  })

  test('an unrecognised transport takes a stated class, not the value it carried', () => {
    const buf = createBuffer()
    buf.addRequest(req({ transport: 'http probes' }))
    const tab = createRequestsTab(buf, {})
    tab.render()

    const badge = tab.el.querySelector('.fjs-badge')
    expect([...badge.classList]).toEqual(['fjs-badge', 'fjs-badge-other'])
  })

  test('…and a transport the stylesheet knows still gets its own class', () => {
    const buf = createBuffer()
    buf.addRequest(req({ transport: 'WS' }))
    const tab = createRequestsTab(buf, {})
    tab.render()

    // The negative control for the row above: a rule that answered 'other' for
    // everything would pass it and make every badge look the same.
    expect(tab.el.querySelector('.fjs-badge-ws')).toBeTruthy()
    expect(tab.el.querySelector('.fjs-badge-ws').textContent).toBe('WS')
  })

  test('service, method and user are escaped', () => {
    const buf = createBuffer()
    buf.addRequest(req({ service: TEXT, method: TEXT, user: TEXT }))
    const tab = createRequestsTab(buf, {})
    tab.render()

    expect(tab.el.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
  })

  test('a durationMs that is not a number reaches neither the text nor the style', () => {
    const buf = createBuffer()
    buf.addRequest(req({ durationMs: TEXT }))
    const tab = createRequestsTab(buf, {})
    tab.render()

    expect(tab.el.querySelector('img')).toBe(null)
    const bar = tab.el.querySelector('.fjs-dur-bar')
    expect(bar.getAttribute('style')).toBe('width:0%')
  })
})

describe('the sibling tabs — the same helper, forgotten in the same way', () => {
  test('a hostile log level cannot inject, and its class comes off the map', () => {
    const buf = createBuffer()
    buf.initFromState({ logs: [{ level: TEXT, message: TEXT, ts: Date.now() }] })
    const tab = createLogsTab(buf)
    tab.render()

    expect(tab.el.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    // The class is a lookup, so an unknown level falls back rather than landing
    // in the attribute.
    expect(tab.el.querySelector('.fjs-level').classList.contains('fjs-level-info')).toBe(true)
  })

  test('an event name and payload are escaped', () => {
    const buf = createBuffer()
    buf.initFromState({ events: [{ name: TEXT, data: { x: TEXT } }] })
    const tab = createEventsTab(buf)
    tab.render()

    expect(tab.el.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
  })

  test('a connection user and ip are escaped', () => {
    const tab = createConnectionsTab()
    tab.setConnections([{ user: TEXT, ip: TEXT, connectedAt: Date.now() }])

    expect(tab.el.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    expect(tab.el.textContent).toContain('img src=x')
  })

  test('a waterfall label and detail are escaped, and a non-numeric duration does not throw', () => {
    const frag = buildWaterfallEl({
      durationMs: 10,
      hooks: [{ phase: TEXT, hookName: TEXT, durationMs: TEXT, status: 'error', errorMsg: TEXT }],
    }, {})
    const host = document.createElement('div')
    host.appendChild(frag)

    expect(host.querySelector('img')).toBe(null)
    expect(globalThis.__pwned).toBe(undefined)
    expect(host.querySelector('.fjs-wf-ms').textContent).toBe('0.0ms')
  })
})

describe('the tag itself — escaping by default is what makes the omission unwritable', () => {
  test('a value is escaped without the caller asking', () => {
    expect(String(html`<p>${'<b>&"\''}</p>`))
      .toBe('<p>&lt;b&gt;&amp;&quot;&#39;</p>')
  })

  test('a nested html result passes through, so markup can be composed', () => {
    const inner = html`<b>${'<i>'}</b>`
    expect(String(html`<p>${inner}</p>`)).toBe('<p><b>&lt;i&gt;</b></p>')
  })

  test('a plain string that LOOKS like markup does not', () => {
    // The negative control for the row above: if pass-through were decided by
    // sniffing the text rather than by the marker, this would be raw.
    expect(String(html`<p>${'<b>x</b>'}</p>`)).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>')
  })

  test('null and undefined render as nothing rather than as words', () => {
    expect(String(html`<p>${null}${undefined}</p>`)).toBe('<p></p>')
  })

  test('classSuffix chooses from the list and is case-insensitive', () => {
    expect(classSuffix('HTTP', ['ws', 'http'], 'other')).toBe('http')
    expect(classSuffix('http x', ['ws', 'http'], 'other')).toBe('other')
    expect(classSuffix(null, ['ws', 'http'], 'other')).toBe('other')
  })

  test('num answers a number or the fallback', () => {
    expect(num('12')).toBe(12)
    expect(num(TEXT)).toBe(0)
    expect(num(Infinity, 7)).toBe(7)
  })
})
