/**
 * Sierra devtools toolbar bootstrap.
 * Appended to <body> in dev mode via transformIndexHtml.
 * Plain DOM only — must work even if Mesa/Sierra app is broken.
 */

import { createBuffer    } from './buffer.js'
import { createToolbarUI } from './ui.js'

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]
const MAX_ATTEMPTS = 10

export function initToolbar(config = {}) {
  const { port = 4000 } = config
  const buffer = createBuffer()

  let _paused       = false
  let _pendingCount = 0
  let _ws           = null
  let _attempts     = 0
  let _retryTimer   = null
  let _destroyed    = false

  const ui = createToolbarUI(
    buffer,
    config,
    () => { _paused = true },
    () => {
      _paused = false
      ui.clearNewCount()
      _pendingCount = 0
      ui.render()
    },
    () => { ui.render() },
  )

  document.body.appendChild(ui.root)

  // ── WS connection ─────────────────────────────────────────────────────────

  function connect() {
    if (_destroyed) return

    try {
      _ws = new WebSocket(`ws://localhost:${port}`)
    } catch (_) {
      scheduleReconnect()
      return
    }

    _ws.onopen = () => {
      _attempts = 0
      ui.setStatus('')
    }

    _ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      handleMessage(msg)
    }

    _ws.onclose = () => {
      if (!_destroyed) scheduleReconnect()
    }

    _ws.onerror = () => {
      // onclose fires after onerror — no action needed here
    }
  }

  function scheduleReconnect() {
    _ws = null
    _attempts++

    if (_attempts > MAX_ATTEMPTS) {
      ui.setStatus('devtools offline — click to retry')
      // Clicking pill will call connect() via retry button
      return
    }

    const delay = BACKOFF[Math.min(_attempts - 1, BACKOFF.length - 1)]
    ui.setStatus(`devtools offline (retry ${_attempts}/${MAX_ATTEMPTS})`)

    _retryTimer = setTimeout(connect, delay)
  }

  // ── Message handler ───────────────────────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        buffer.initFromState(msg.data ?? {})
        if ((msg.data?.connections ?? []).length) {
          ui.setConnections(msg.data.connections)
        }
        flushUI()
        break

      case 'request':
        buffer.addRequest(msg.data)
        flushOrCount()
        break

      case 'call_start':
        // Track start; we'll use durationMs from the rolled-up `request` event
        break

      case 'hook':
        buffer.addHook(msg.data)
        if (!_paused) ui.render()
        break

      case 'query':
        buffer.addQuery(msg.data)
        if (!_paused) ui.render()
        break

      case 'event':
        buffer.events.push(msg.data)
        flushOrCount()
        break

      case 'log':
        buffer.logs.push(msg.data)
        flushOrCount()
        break

      case 'connection':
        // No buffer for connections — handled live
        break

      case 'disconnect':
        break
    }
  }

  function flushUI() {
    if (_paused) return
    ui.clearNewCount()
    ui.render()
  }

  function flushOrCount() {
    if (_paused) {
      _pendingCount++
      ui.addNewCount(1)
    } else {
      ui.render()
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  ui.setStatus('devtools offline')
  connect()

  return {
    destroy() {
      _destroyed = true
      clearTimeout(_retryTimer)
      _ws?.close()
      ui.root.remove()
    }
  }
}
