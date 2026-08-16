// Default Junction Adapter — PLACEHOLDER.
//
// This is a working WebSocket-based adapter that lets jetty boot end-to-end
// without external code, but is NOT real Junction. Replace before production
// by passing { adapter: yourRealJunction } in jetty.config.js → junction.adapter.
//
// Wire format (envelope-on-JSON):
//   Out: { kind: 'call',      id, service, method, args }
//   Out: { kind: 'subscribe', id, channel }
//   Out: { kind: 'unsubscribe',id, channel }
//   Out: { kind: 'auth',      token }
//   Out: { kind: 'schema' }
//   Out: { kind: 'schema:version' }
//
//   In:  { kind: 'result',    id, ok: boolean, value? | error? }
//   In:  { kind: 'event',     channel, event, payload }
//   In:  { kind: 'schema',    version, schema }
//   In:  { kind: 'schema:version', version }
//
// Reconnect: on close, exponential backoff up to 30s, retries forever while
// not explicitly disconnected. Pending calls reject with `connection lost`
// when the socket dies; subscriptions auto-resubscribe on reconnect.

export function createDefaultJunctionAdapter() {
  let socket          = null
  let url             = null
  let token           = null
  let connectedFlag   = false
  let explicitClose   = false
  let backoffMs       = 1000
  const BACKOFF_MAX   = 30000
  const BACKOFF_BASE  = 1000

  const pending       = new Map() // id → { resolve, reject }
  const subscriptions = new Map() // channel → handler  (one handler per channel; jetty layer fans out)
  const lifecycle     = { connect: new Set(), disconnect: new Set(), reconnect: new Set(), error: new Set() }
  let nextId          = 1

  function emit(eventName, ...args) {
    for (const fn of lifecycle[eventName]) {
      try { fn(...args) } catch (e) { console.error('[junction] lifecycle handler threw', e) }
    }
  }

  function makeId() { return `j${nextId++}` }

  function openSocket() {
    return new Promise((resolve, reject) => {
      let ws
      try {
        ws = new WebSocket(url)
      } catch (e) {
        reject(e); return
      }
      socket = ws

      ws.onopen = async () => {
        connectedFlag = true
        backoffMs = BACKOFF_BASE
        // First message: auth handshake (token or null)
        try { ws.send(JSON.stringify({ kind: 'auth', token })) } catch {}
        // Resubscribe channels after reconnect
        for (const channel of subscriptions.keys()) {
          try { ws.send(JSON.stringify({ kind: 'subscribe', id: makeId(), channel })) } catch {}
        }
        emit('connect')
        resolve()
      }

      ws.onmessage = (evt) => {
        let msg
        try { msg = JSON.parse(evt.data) } catch { return }
        handleIncoming(msg)
      }

      ws.onerror = (err) => {
        emit('error', err)
        // onclose follows; reject the connect promise once if still pending
      }

      ws.onclose = () => {
        const wasConnected = connectedFlag
        connectedFlag = false
        socket = null

        // Reject all pending calls — server is gone, they'll never resolve.
        for (const { reject } of pending.values()) {
          reject(new Error('junction: connection lost'))
        }
        pending.clear()

        if (wasConnected) emit('disconnect')

        if (!explicitClose) {
          // Schedule reconnect.
          setTimeout(() => {
            if (explicitClose) return
            openSocket().then(() => emit('reconnect')).catch(() => {})
            backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX)
          }, backoffMs)
        }
      }
    })
  }

  function handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'result') {
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.value)
      else        entry.reject(new Error(msg.error?.message || 'junction: call failed'))
      return
    }
    if (msg.kind === 'event' && typeof msg.channel === 'string') {
      const handler = subscriptions.get(msg.channel)
      if (handler) {
        // (data, event) — a channel carries many events and the subscriber has
        // to be told which one this is.
        try { handler(msg.payload, msg.event) }
        catch (e) { console.error('[junction] event handler threw', e) }
      }
      return
    }
    // Other kinds (schema, schema:version) are response-style and arrive via
    // the same `result` path when issued by call() with a kind-tagged id.
    if (msg.kind === 'schema' || msg.kind === 'schema:version') {
      // Allow direct (non-id'd) push as well — find the most-recent matching pending.
      // Simpler: ignore; consumers should request via call() which tags an id.
      return
    }
  }

  function ensureSocketOrThrow() {
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      throw new Error('junction: not connected')
    }
  }

  return {
    async connect(opts = {}) {
      url   = opts.url   ?? url
      token = opts.token ?? token
      if (!url) throw new Error('junction: connect requires { url }')
      explicitClose = false
      if (connectedFlag) return
      await openSocket()
    },

    async disconnect() {
      explicitClose = true
      if (socket) {
        try { socket.close() } catch {}
      }
      connectedFlag = false
    },

    isConnected() { return connectedFlag },

    async call(service, method, args) {
      ensureSocketOrThrow()
      const id = makeId()
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          socket.send(JSON.stringify({ kind: 'call', id, service, method, args }))
        } catch (e) {
          pending.delete(id)
          reject(e)
        }
      })
    },

    async setToken(newToken) {
      token = newToken
      if (connectedFlag && socket) {
        try { socket.send(JSON.stringify({ kind: 'auth', token })) } catch {}
      }
      // Real Junction may require disconnect+reconnect for security reasons.
      // Default adapter does in-band token swap; replace if your protocol differs.
    },

    async subscribe(channel, handler) {
      if (subscriptions.has(channel)) {
        throw new Error(`junction: already subscribed to "${channel}" (default adapter allows one handler per channel)`)
      }
      subscriptions.set(channel, handler)
      if (connectedFlag && socket) {
        try { socket.send(JSON.stringify({ kind: 'subscribe', id: makeId(), channel })) } catch {}
      }
      return () => {
        subscriptions.delete(channel)
        if (connectedFlag && socket) {
          try { socket.send(JSON.stringify({ kind: 'unsubscribe', id: makeId(), channel })) } catch {}
        }
      }
    },

    on(event, fn) {
      if (!lifecycle[event]) throw new Error(`junction: unknown event "${event}"`)
      lifecycle[event].add(fn)
      return () => lifecycle[event].delete(fn)
    },

    async fetchSchema() {
      ensureSocketOrThrow()
      // Schema as an RPC call with a sentinel service.
      try {
        const value = await this.call('__schema__', 'fetch', {})
        return value // { version, schema }
      } catch (e) {
        console.warn('[junction] fetchSchema not supported by server:', e.message)
        return null
      }
    },

    async getServerSchemaVersion() {
      ensureSocketOrThrow()
      try {
        const value = await this.call('__schema__', 'version', {})
        return value?.version ?? null
      } catch {
        return null
      }
    },
  }
}
