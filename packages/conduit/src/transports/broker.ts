// ============================================================
// Conduit — Broker Transport
// A broker somebody else runs (FJS-D235): dial out, then receive.
// Nothing is sent over it — nobody is on the other end to answer.
// ============================================================

import { BaseTransport } from './base.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  TargetDescriptor,
  BrokerMessage,
  BrokerHandler,
  BrokerHealth,
} from '../types.ts'
import { ConduitStreamError } from '../types.ts'
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './http.ts'

const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000]

// Frames: `{ id, type: 'message', body }` in, `{ id, type: 'ack' }` out.
export class BrokerTransport extends BaseTransport {
  readonly protocol = 'websocket' as const

  private ws:        WebSocket | null = null
  private handler:   BrokerHandler | null = null
  private timer:     ReturnType<typeof setTimeout> | null = null
  private attempts   = 0
  private destroyed  = false
  private lastReceivedAt: number | null = null
  private received   = 0

  private traceHeaders: (() => Record<string, string> | undefined) | null = null

  // `timeout_ms` bounds one dial and `max_response_bytes` one frame. The other
  // two request-shaped numbers have nothing to bound: a reconnect is unbounded
  // on purpose (below), so `retry_limit` and `deadline_ms` would end the
  // subscription they exist to keep.
  constructor(
    descriptor: TargetDescriptor,
    credentials: CredentialResolver,
    private opts: { timeout_ms?: number; max_response_bytes?: number } = {},
  ) {
    super(descriptor, credentials)
  }

  async send<T>(_req: ConduitRequest): Promise<ConduitResult<T>> {
    return this.fail(
      'invalid_request',
      `Target ${this.descriptor.id} is a broker: it is subscribed to, not sent to`,
      { retryable: false }
    )
  }

  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    throw new ConduitStreamError({
      kind:      'invalid_request',
      target:    this.descriptor.id,
      protocol:  this.protocol,
      message:   `Target ${this.descriptor.id} is a broker: it is subscribed to, not streamed from`,
      retryable: false,
    })
  }

  // The reading `app.registerHealthCheck` is handed. A subscription that has
  // stopped consuming looks exactly like a quiet broker, so `connected` is the
  // half that cannot be mistaken for quiet, and `last_received_at` the half an
  // operator compares against what the broker says it sent.
  health(): BrokerHealth {
    return {
      connected:        this.ws?.readyState === WebSocket.OPEN,
      last_received_at: this.lastReceivedAt,
      received:         this.received,
    }
  }

  // Resolves once the first dial has been attempted, so a refused credential
  // reaches the caller; an unreachable broker does not — it is retried, and
  // `health().connected` says so.
  // `traceHeaders` is asked afresh on every dial, so a reconnect is a new span
  // rather than a replay of the first.
  async subscribe(
    handler: BrokerHandler,
    traceHeaders: (() => Record<string, string> | undefined) | null = null,
  ): Promise<void> {
    if (this.handler) throw new Error(`[conduit] ${this.descriptor.id} already has a subscriber`)
    this.handler      = handler
    this.traceHeaders = traceHeaders
    try {
      await this.connect()
    } catch (err) {
      this.handler = null
      throw err
    }
  }

  destroy() {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ws?.close()
    this.ws = null
  }

  private async connect(): Promise<void> {
    if (this.destroyed) return

    // Resolved before the socket exists, so an unresolvable ref opens no
    // unauthenticated connection — the websocket transport's rule.
    const address = this.descriptor.address
    // Trace sits under auth, so nothing can displace a credential.
    const headers = this.mergeHeaders(this.traceHeaders?.(), await this.buildAuthHeaders({
      method: 'CONNECT',
      path:   pathOf(address),
      query:  queryOf(address),
    }))

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(address, { headers } as unknown as string[])

      // A broker that accepts the connection and never completes the upgrade
      // neither opens nor errors, which would hold `subscribe()` for good.
      const dialTimer = setTimeout(() => {
        ws.close()
        resolve()
        this.scheduleReconnect()
      }, this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS)

      ws.addEventListener('open', () => {
        clearTimeout(dialTimer)
        this.ws       = ws
        this.attempts = 0
        resolve()
      })
      ws.addEventListener('error', () => { clearTimeout(dialTimer); resolve() })
      ws.addEventListener('close', () => {
        clearTimeout(dialTimer)
        if (this.ws === ws) this.ws = null
        resolve()
        if (!this.destroyed) this.scheduleReconnect()
      })
      ws.addEventListener('message', (e) => { void this.onMessage(ws, e) })
    })
  }

  // Unbounded, unlike a request transport: a consumer that gives up is a
  // subscription that has silently stopped, which is the failure this exists
  // to prevent. The backoff caps; `health().connected` reports the gap.
  private scheduleReconnect() {
    if (this.timer || this.destroyed) return
    const delay = RECONNECT_BACKOFF[Math.min(this.attempts, RECONNECT_BACKOFF.length - 1)]
    this.attempts++
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  // The ack follows the handler and never precedes it: an ack before the
  // handoff is a lost message, and an ack after an idempotent handoff that then
  // fails to go out is a redelivery that costs nothing (FJS-D235). A handler
  // that throws leaves the message unacknowledged for the broker to redeliver.
  private async onMessage(ws: WebSocket, e: MessageEvent) {
    // Dropped unhandled and unacked, so the broker redelivers it and an
    // operator sees it, rather than the process buffering what it was told not to.
    const size = typeof e.data === 'string' ? Buffer.byteLength(e.data) : (e.data as ArrayBuffer).byteLength
    if (size > (this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES)) {
      console.error(`[conduit] broker ${this.descriptor.id} sent a ${size}-byte frame over max_response_bytes; dropped`)
      return
    }

    let frame: { id?: unknown; type?: unknown; body?: unknown }
    try {
      frame = JSON.parse(e.data as string)
    } catch {
      return
    }
    if (frame.type !== 'message' || typeof frame.id !== 'string' || frame.id === '') return

    const message: BrokerMessage = { id: frame.id, body: frame.body }
    this.lastReceivedAt = Date.now()
    this.received++

    try {
      await this.handler!(message)
    } catch (err) {
      console.error(`[conduit] broker handler for ${this.descriptor.id} threw on ${message.id}:`, err)
      return
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, type: 'ack' }))
  }
}

function pathOf(address: string): string {
  try { return new URL(address).pathname || '/' } catch { return '/' }
}
function queryOf(address: string): string {
  try { return new URL(address).search } catch { return '' }
}
