// Fable audit run 1.5 — what the relay trusts.
//
// Three seams between an arbitrary web page and Harbor's Junction client, each
// driven the way the page would drive it:
//
//   1. handleConnect reads the port NAME and nothing else — a port is believed
//      to be the dock because it says so.
//   2. makePageBridge accepts any message whose `source` is the page's own
//      window, which every script on the host page satisfies.
//   3. An island's shadow root is closed by default, so the host page cannot
//      read what the island renders or click what it renders (FJS-2335).
//
// Runs under plain node like the phase files. A check marked `failing(...)`
// asserts the behavior the package should have and fails today; it counts as a
// pass here until the fix lands, and then as a failure, which is the signal to
// turn it into ok().
//
// FJS-2336: the failing() below asserts the fixed behavior, so it fails until
// the fix lands; drop the failing() wrapper then.

import { JSDOM } from 'jsdom'

let pass = 0
let fail = 0
let knownFailing = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }
// The fixed behavior, stated; today it does not hold.
function failing(msg, holds) {
  if (holds) { bad(`${msg} — now holds; drop the failing() wrapper`) ; return }
  knownFailing++
  console.log('  ~', msg, '(fails today, expected)')
}

function mockPort(name, sender) {
  const messages = []
  const msgListeners = []
  const disconnectListeners = []
  return {
    name,
    sender,
    postMessage(msg) { messages.push(msg) },
    disconnect() {},
    onMessage:    { addListener(fn) { msgListeners.push(fn) } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn) } },
    _emitMessage(msg) { for (const fn of msgListeners) fn(msg) },
    _messages: () => messages,
  }
}

// ─── 1. the port name is the only credential ──────────────────────────────

group('handleConnect — what a port is believed to be')
{
  const { handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry, makePagesApi } = await import('../src/runtime/harbor-registry.js')

  const registry = makeHarborRegistry()
  const pages    = makePagesApi(registry)

  // A content script on a host page opens a port and names itself the dock.
  // chrome fills `sender` from the tab; Harbor never reads it.
  const impostor = mockPort('dock:dock:v1', {
    id:  'mock-ext-id',
    url: 'https://evil.example/article',
    tab: { id: 7, url: 'https://evil.example/article' },
  })
  handleConnect(impostor, registry, () => null)

  if (registry.countFor('dock') === 1) ok('a tab-origin port named dock:dock:v1 is registered as the dock')
  const delivered = pages.dock.send('app:secret', { forTheDockOnly: true })
  if (delivered && impostor._messages().some(m => m.type === 'app:secret')) {
    ok('pages.dock.send() reaches the tab-origin port')
  }
  failing('a port whose sender is a tab is refused the dock, options and pier names',
    registry.countFor('dock') === 0)
}

// ─── jsdom for the two DOM seams ──────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://host.example/' })
globalThis.window           = dom.window
globalThis.document         = dom.window.document
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.HTMLElement      = dom.window.HTMLElement
globalThis.Element          = dom.window.Element
globalThis.MessageEvent     = dom.window.MessageEvent
globalThis.chrome           = { runtime: { id: 'mock-ext-id' } }
globalThis.browser          = undefined

// ─── 2. the page bridge ───────────────────────────────────────────────────

group('makePageBridge — who may speak to the content script')
{
  const { makePageBridge } = await import('../src/island/page-script.js')
  const cs = makePageBridge('sdk', { side: 'cs' })
  const received = []
  cs.on((payload) => received.push(payload))

  // The HOST PAGE's own script, not jetty's injected one. In a browser a
  // same-window postMessage arrives with `source === window`; jsdom leaves
  // `source` unset, so the event is built with the value the browser would
  // give it.
  const spoof = { __jetty: true, channel: 'sdk', direction: 'page→cs', payload: { cmd: 'drain', to: 'evil' } }
  window.dispatchEvent(new MessageEvent('message', { data: spoof, origin: 'https://host.example', source: window }))
  if (received.length === 0) ok('a bridge message without the nonce the content script minted is ignored')
  else bad('a host-page script spoofed the content-script side', JSON.stringify(received))

  const guessed = { ...spoof, nonce: 'guess' }
  window.dispatchEvent(new MessageEvent('message', { data: guessed, origin: 'https://host.example', source: window }))
  if (received.length === 0) ok('a wrong nonce is ignored')
  else bad('a wrong nonce was accepted', JSON.stringify(received))

  // jsdom delivers a postMessage with no `source`, so the page side's own
  // send() is re-dispatched with the source a browser would give it.
  const page = makePageBridge('sdk', { side: 'page', nonce: cs.nonce })
  const sent = []
  const realPost = window.postMessage
  window.postMessage = (data) => sent.push(data)
  page.send({ cmd: 'hello' })
  window.postMessage = realPost
  window.dispatchEvent(new MessageEvent('message', { data: sent[0], origin: 'https://host.example', source: window }))
  if (received.length === 1 && received[0].cmd === 'hello') ok('the page side holding the nonce reaches the content-script side')
  else bad('the page side with the nonce did not arrive', JSON.stringify(received))

  try { makePageBridge('sdk', { side: 'page' }); bad('a page side without a nonce was accepted') }
  catch { ok('a page side without a nonce is refused') }
  page.destroy()
  cs.destroy()
}

// ─── 3. the island shadow root ────────────────────────────────────────────

group('runIsland — what the host page can reach inside an island')
{
  const { runIsland } = await import('../src/island/runtime.js')

  let clicks = 0
  const handle = await runIsland({
    app: (root) => {
      const btn = document.createElement('button')
      btn.textContent = 'Pay invoice'
      btn.addEventListener('click', () => { clicks++ })
      root.appendChild(btn)
      const who = document.createElement('p')
      who.textContent = 'Signed in as bob@x.test'
      root.appendChild(who)
    },
  }, { id: 'pay', type: 'island' })

  // The host page, trying to read and drive the island through its root.
  const host = document.querySelector('[data-jetty-island="pay"]')
  const root = host?.shadowRoot ?? null
  root?.querySelector('button')?.click()
  if (host && root === null) ok('an island shadow root is closed unless the island opts into open')
  else bad('the host page can reach host.shadowRoot', 'default root is open')
  if (clicks === 0) ok('the host page cannot click a control inside the island')
  handle.destroy()

  const openHandle = await runIsland({ app: (r) => { r.textContent = 'x' }, shadowMode: 'open' }, { id: 'dbg', type: 'island' })
  const openHost = document.querySelector('[data-jetty-island="dbg"]')
  if (openHost?.shadowRoot) ok('shadowMode: open still opts in')
  else bad('shadowMode: open was not honored')
  openHandle.destroy()
}

console.log(`\n${pass} passed, ${fail} failed, ${knownFailing} failing-as-expected`)
process.exit(fail > 0 ? 1 : 0)
