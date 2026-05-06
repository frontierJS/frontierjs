// PagePort — wraps chrome.runtime.connect() for use by Pages and Islands.
//
// Surface (matches spec's ctx.harbor):
//   send(type, payload)           → bool  (false if no port available)
//   on(type, fn) → unsubscribe()
//   off(type, fn?)
//   session                       → latest 'session' payload or null
//   onDisconnect(fn) → unsubscribe()
//   onReconnect(fn)  → unsubscribe()
//
// Reconnect strategy: lazy. When the SW terminates, our port disconnects.
// We do NOT eagerly reconnect (would wake the SW for nothing if the page
// is idle). On the next send() call, we reconnect transparently. Spec ref:
// "If a Page is open during Harbor termination, port emits `disconnect`
// event the Page handles by reopening on next interaction."
//
// Protocol upgrade: when harbor sends `protocol:upgrade` or `runtime:reload-tab`,
// we reload the page. For Islands the host tab gets reloaded (Phase 4 wires
// the actual tabs.reload — until then it's location.reload, which is wrong
// for Islands but inert in non-island contexts).

import { makePortName } from './protocol.js'

export class PagePort {
  constructor({ type, id, runtime = defaultRuntime() }) {
    this.type     = type
    this.id       = id
    this.session  = null

    this._runtime    = runtime
    this._port       = null
    this._handlers   = new Map()    // type → Set<fn>
    this._lifecycleHandlers = {
      disconnect: new Set(),
      reconnect:  new Set(),
    }

    if (this._runtime) {
      this._connect()
    }
  }

  _connect() {
    if (!this._runtime) return
    const port = this._runtime.connect({ name: makePortName(this.type, this.id) })
    this._port = port

    port.onMessage.addListener((msg) => this._handleMessage(msg))
    port.onDisconnect.addListener(() => {
      // chrome sets runtime.lastError on the port when disconnect is due to error;
      // we don't surface it here — disconnect is normal MV3 behavior.
      this._port = null
      this._notifyLifecycle('disconnect')
    })

    // Ask harbor for the current session immediately. Harbor's connect handler
    // posts a stub `{ authenticated: false }` session before boot completes;
    // sending `init` triggers harbor to reply with the real session payload
    // (and current schema). Without this, an island/page opened AFTER the
    // user has signed in elsewhere would report `authenticated: false` until
    // the next login/logout broadcast — which may never happen if the user
    // doesn't re-auth.
    try { port.postMessage({ type: 'init', payload: {} }) }
    catch { /* port closed already; will reconnect lazily */ }
  }

  _ensureConnected() {
    if (!this._port && this._runtime) {
      this._connect()
      this._notifyLifecycle('reconnect')
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.type) return

    // Protocol-level messages from harbor — handled by framework, not app.
    if (msg.type === 'protocol:upgrade' || msg.type === 'runtime:reload-tab') {
      console.log('[jetty] reload requested by harbor:', msg.type)
      // location.reload() works in both contexts:
      //   - In a Page (Dock/Options/Pier), reloads that page.
      //   - In an Island content script, reloads the host tab's document
      //     (content scripts share the page's window/location).
      // Harbor-initiated tab reload (when the SW wants to reload all tabs
      // matching an island's pattern, not just one) goes through
      // chrome.tabs.reload() in islands.reloadTabsFor() — separate path.
      if (typeof location !== 'undefined' && location.reload) {
        location.reload()
      }
      return
    }

    // Update cached session on session messages — even if no handler is registered.
    if (msg.type === 'session') {
      this.session = msg.payload
    }

    const set = this._handlers.get(msg.type)
    if (!set) return
    for (const fn of set) {
      try { fn(msg.payload, msg) }
      catch (e) { console.error('[jetty] handler threw for', msg.type, e) }
    }
  }

  send(type, payload) {
    this._ensureConnected()
    if (!this._port) return false
    try {
      this._port.postMessage({ type, payload })
      return true
    } catch {
      // postMessage on a closed port throws. Drop the dead reference; next
      // send() reconnects.
      this._port = null
      return false
    }
  }

  /**
   * Request/response RPC pattern over the port.
   * Sends `{type, payload: {...payload, _requestId}}`, waits for a matching
   * `{type: 'response:<id>', payload: ...}`. Times out after `timeout` ms.
   *
   * Used internally by Mesa Resources (Phase 3). Exposed publicly for
   * advanced use cases (e.g. dev-tools panels).
   */
  async request(type, payload = {}, { timeout = 10000 } = {}) {
    if (!this._runtime) {
      return Promise.reject(new Error('PagePort.request: no runtime available'))
    }
    const requestId   = `r${Math.random().toString(36).slice(2, 10)}`
    const responseType = `response:${requestId}`

    return new Promise((resolve, reject) => {
      let unsubscribe = null
      const timer = setTimeout(() => {
        if (unsubscribe) unsubscribe()
        reject(new Error(`PagePort.request("${type}") timeout after ${timeout}ms`))
      }, timeout)

      unsubscribe = this.on(responseType, (responsePayload) => {
        clearTimeout(timer)
        unsubscribe()
        if (responsePayload?._error) {
          reject(new Error(responsePayload._error))
        } else {
          resolve(responsePayload?.value ?? responsePayload)
        }
      })

      const ok = this.send(type, { ...payload, _requestId: requestId })
      if (!ok) {
        clearTimeout(timer)
        unsubscribe()
        reject(new Error(`PagePort.request("${type}") failed: send returned false`))
      }
    })
  }

  /**
   * Subscribe to a Junction channel via the harbor.
   *
   * Sends `channel:subscribe` to harbor (which refcounts upstream Junction
   * subscriptions) and registers a handler for incoming `channel:event`
   * messages on this channel. Returns an unsubscribe fn.
   *
   * Auto-resubscribes after a port reconnect (lazy reconnect path triggers
   * a new subscribe). The harbor side has already cleaned up the prior
   * subscription on disconnect.
   *
   * Note: harbor responds to channel:subscribe with an ack. We don't await
   * the ack — subscription is fire-and-forget. The first event arrives
   * shortly after.
   */
  subscribe(channel, handler) {
    if (typeof channel !== 'string' || !channel) {
      throw new Error('PagePort.subscribe: channel must be a non-empty string')
    }
    if (typeof handler !== 'function') {
      throw new Error('PagePort.subscribe: handler must be a function')
    }

    const onEvent = (payload) => {
      if (payload?.channel === channel) {
        try { handler(payload.data, payload) }
        catch (e) { console.error(`[jetty] channel "${channel}" handler threw`, e) }
      }
    }

    const offEvent = this.on('channel:event', onEvent)
    this.send('channel:subscribe', { channel })

    const offReconnect = this.onReconnect(() => {
      // Port reconnected → harbor lost our subscription; re-subscribe.
      this.send('channel:subscribe', { channel })
    })

    return () => {
      offEvent()
      offReconnect()
      this.send('channel:unsubscribe', { channel })
    }
  }

  on(type, fn) {
    let set = this._handlers.get(type)
    if (!set) { set = new Set(); this._handlers.set(type, set) }
    set.add(fn)
    return () => this.off(type, fn)
  }

  off(type, fn) {
    if (!this._handlers.has(type)) return
    if (fn === undefined) { this._handlers.delete(type); return }
    this._handlers.get(type).delete(fn)
  }

  onDisconnect(fn) {
    this._lifecycleHandlers.disconnect.add(fn)
    return () => this._lifecycleHandlers.disconnect.delete(fn)
  }

  onReconnect(fn) {
    this._lifecycleHandlers.reconnect.add(fn)
    return () => this._lifecycleHandlers.reconnect.delete(fn)
  }

  _notifyLifecycle(kind) {
    for (const fn of this._lifecycleHandlers[kind]) {
      try { fn() } catch (e) { console.error(`[jetty] ${kind} handler threw`, e) }
    }
  }

  // Test/internal escape hatch.
  get _isConnected() { return this._port != null }
}

function defaultRuntime() {
  if (typeof browser !== 'undefined' && browser.runtime?.connect) return browser.runtime
  if (typeof chrome  !== 'undefined' && chrome.runtime?.connect)  return chrome.runtime
  return null
}
