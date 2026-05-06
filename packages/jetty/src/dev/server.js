// server.js — Jetty dev WebSocket server.
//
// One server per running `fli dev:ext` invocation. Listens on the FJS-scheme
// port from jetty.config.js → dev.port. Broadcasts dev events to all
// connected clients; expects clients to re-open on disconnect (lazy, on
// next message attempt — pages don't ping just to keep a socket alive).
//
// Wire format — JSON messages:
//   server → client
//     { kind: 'hello',              port }
//     { kind: 'extension:reload',   reason, file }
//     { kind: 'page:reload',        target, file }
//     { kind: 'island:reload-tabs', islandId, file }
//     { kind: 'ping' }
//   client → server  (rare; mostly for diagnostics)
//     { kind: 'pong', clientId }
//     { kind: 'identify', clientType: 'harbor'|'dock'|'options'|`pier:${id}`|`island:${id}` }
//
// Only Harbor handles 'island:reload-tabs' — it has chrome.tabs access.
// All clients ignore events not addressed to them via clientType matching.

import { WebSocketServer } from 'ws'

export class DevServer {
  /**
   * @param {Object} opts
   * @param {number} opts.port  — FJS-scheme port from jetty.config.js
   * @param {Object} [opts.logger=console]
   */
  constructor({ port, logger = console }) {
    this.port    = port
    this.logger  = logger
    this.server  = null
    this.clients = new Set() // ws → { id, type? }
    this._idSeq  = 0
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = new WebSocketServer({ port: this.port, host: '127.0.0.1' })
      } catch (e) {
        reject(e); return
      }

      this.server.on('listening', () => {
        this.logger.log(`[jetty:dev] WS listening on ws://127.0.0.1:${this.port}`)
        resolve()
      })

      this.server.on('error', (err) => {
        this.logger.error('[jetty:dev] WS error:', err.message)
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            `Port ${this.port} already in use. Either another jetty dev server is running, ` +
            `or change dev.port in jetty.config.js.`
          ))
        } else {
          reject(err)
        }
      })

      this.server.on('connection', (ws) => this._onConnect(ws))
    })
  }

  _onConnect(ws) {
    const id = ++this._idSeq
    const meta = { id, type: null }
    this.clients.add(ws)
    ws._jettyMeta = meta

    this.logger.log(`[jetty:dev] client connected (#${id}); total=${this.clients.size}`)

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) }
      catch { return }
      if (msg?.kind === 'identify' && typeof msg.clientType === 'string') {
        meta.type = msg.clientType
        this.logger.log(`[jetty:dev] client #${id} identified as "${meta.type}"`)
      }
    })

    ws.on('close', () => {
      this.clients.delete(ws)
      this.logger.log(`[jetty:dev] client #${id} disconnected; total=${this.clients.size}`)
    })

    ws.on('error', () => {/* swallow — close follows */})

    // Hello on connect
    this._sendTo(ws, { kind: 'hello', port: this.port })
  }

  /**
   * Broadcast a dev event to all connected clients. Clients filter by
   * relevance themselves — keeps the server stateless w.r.t. routing.
   */
  broadcast(event) {
    if (!event || event.kind === 'noop') return
    if (this.clients.size === 0) return

    const payload = JSON.stringify(event)
    let delivered = 0
    for (const ws of this.clients) {
      if (ws.readyState !== 1 /* OPEN */) continue
      try { ws.send(payload); delivered++ }
      catch {/* client closed mid-iteration */}
    }
    this.logger.log(`[jetty:dev] broadcast ${event.kind} → ${delivered} client(s)`)
  }

  _sendTo(ws, msg) {
    try { ws.send(JSON.stringify(msg)) } catch {}
  }

  async stop() {
    if (!this.server) return
    return new Promise((resolve) => {
      for (const ws of this.clients) {
        try { ws.close() } catch {}
      }
      this.clients.clear()
      this.server.close(() => resolve())
      this.server = null
    })
  }
}
