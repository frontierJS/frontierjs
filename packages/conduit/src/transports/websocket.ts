// ============================================================
// Conduit — WebSocket Transport
// Persistent connection to server agents.
// Handles reconnection, request/response framing, streaming.
// ============================================================

import { BaseTransport } from './base.ts'
import { ConduitStreamError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  TargetDescriptor
} from '../types.ts'

const RECONNECT_ATTEMPTS = 5
const RECONNECT_BACKOFF  = [1000, 2000, 4000, 8000, 16000]
const PING_INTERVAL_MS   = 30_000
const REQUEST_TIMEOUT_MS = 15_000

// Wire protocol — every message over the WebSocket has this shape
interface WireMessage {
  id:      string
  type:    'request' | 'response' | 'stream_chunk' | 'stream_end' | 'error' | 'ping' | 'pong'
  method?: string
  path?:   string
  body?:   unknown
  // Set on a request that expects a stream of chunks rather than a single
  // response. This lives on the envelope, not inside `body`: injecting a
  // marker into the caller's payload collides with their key namespace and
  // destroys any body that is not a plain object.
  stream?: boolean
  error?:  string
  seq?:    number
}

type PendingRequest = {
  resolve: (msg: WireMessage) => void
  reject:  (err: Error) => void
  timer:   ReturnType<typeof setTimeout>
}

// Internal stream event — keeps the end signal out of ConduitChunk
type StreamEvent =
  | { done: false; chunk: ConduitChunk }
  | { done: true }

export class WebSocketTransport extends BaseTransport {
  readonly protocol = 'websocket' as const

  private ws:             WebSocket | null = null
  private pending         = new Map<string, PendingRequest>()
  private streamListeners = new Map<string, (event: StreamEvent) => void>()
  private pingTimer:      ReturnType<typeof setInterval> | null = null
  private reconnecting    = false
  private destroyed       = false
  private reconnectCount  = 0

  onReconnect?: (target: string) => void

  // NOTE(§1.1): this transport still applies no authentication — neither on
  // the upgrade nor per frame. The resolver is threaded through so the fix
  // has somewhere to read from, but the mechanism is an open design question
  // (the standard WebSocket constructor cannot set headers, and signing a
  // frame does not fit a headers-shaped helper). Tracked as Tier 2.
  constructor(descriptor: TargetDescriptor, credentials: CredentialResolver) {
    super(descriptor, credentials)
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const elapsed = this.timer()

    const ws = await this.getConnection()
    if (!ws) {
      return this.fail('connection_failed', `Cannot connect to ${this.descriptor.id}`, {
        retryable: true
      })
    }

    const id = crypto.randomUUID()

    return new Promise<ConduitResult<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(this.fail('timeout', 'WS request timed out', { retryable: true }))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          this.pending.delete(id)
          if (msg.error) {
            resolve(this.fail('server_error', msg.error, { retryable: false }))
          } else {
            resolve(this.ok<T>(msg.body as T, undefined, elapsed()))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          this.pending.delete(id)
          resolve(this.fail('connection_failed', err.message, { retryable: true }))
        },
        timer
      })

      this.sendWire(ws, {
        id,
        type:   'request',
        method: req.method,
        path:   req.path,
        body:   req.body
      })
    })
  }

  async *stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    const ws = await this.getConnection()

    // Throw rather than return: an unreachable agent and an agent with no
    // output are otherwise indistinguishable to the consumer, and the
    // documented contract is that stream() throws when it cannot be
    // established (§2.3).
    if (!ws) {
      throw new ConduitStreamError({
        kind:      'connection_failed',
        target:    this.descriptor.id,
        protocol:  this.protocol,
        message:   `Cannot connect to ${this.descriptor.id}`,
        retryable: true,
      })
    }

    const id = crypto.randomUUID()

    // Buffer incoming events while the consumer is busy
    const buf:    StreamEvent[] = []
    let   notify: (() => void) | null = null
    let   done    = false

    this.streamListeners.set(id, (event) => {
      buf.push(event)
      notify?.()
    })

    this.sendWire(ws, {
      id,
      type:   'request',
      method: req.method,
      path:   req.path,
      body:   req.body,      // passed through untouched
      stream: true
    })

    try {
      while (!done) {
        if (buf.length === 0) {
          await new Promise<void>((res) => { notify = res })
          notify = null
        }

        while (buf.length > 0) {
          const event = buf.shift()!
          if (event.done) {
            done = true
            break
          }
          yield event.chunk
        }
      }
    } finally {
      this.streamListeners.delete(id)
    }
  }

  destroy() {
    this.destroyed = true
    this.clearPing()
    this.ws?.close()
    this.ws = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Transport destroyed'))
    }
    this.pending.clear()
  }

  // ─── Connection Management ────────────────────────────────

  private async getConnection(): Promise<WebSocket | null> {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws
    return this.connect()
  }

  private async connect(): Promise<WebSocket | null> {
    if (this.destroyed) return null

    return new Promise((resolve) => {
      const ws = new WebSocket(this.descriptor.address)

      ws.addEventListener('open', () => {
        this.ws             = ws
        this.reconnecting   = false
        this.reconnectCount = 0
        this.startPing(ws)
        resolve(ws)
      })

      ws.addEventListener('error', () => {
        resolve(null)
      })

      ws.addEventListener('close', () => {
        this.clearPing()
        this.ws = null
        for (const pending of this.pending.values()) {
          pending.reject(new Error('WebSocket closed'))
        }
        this.pending.clear()
        if (!this.destroyed) void this.scheduleReconnect()
      })

      ws.addEventListener('message', (e) => this.onMessage(e))
    })
  }

  private async scheduleReconnect() {
    if (this.reconnecting || this.destroyed)             return
    if (this.reconnectCount >= RECONNECT_ATTEMPTS) return

    this.reconnecting   = true
    const delay         = RECONNECT_BACKOFF[this.reconnectCount] ?? 16000
    this.reconnectCount++

    await sleep(delay)

    this.onReconnect?.(this.descriptor.id)
    this.reconnecting = false
    await this.connect()
  }

  private onMessage(e: MessageEvent) {
    let msg: WireMessage

    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'pong') return

    if (msg.type === 'stream_chunk') {
      this.streamListeners.get(msg.id)?.({
        done:  false,
        chunk: {
          data:      msg.body,
          sequence:  msg.seq ?? 0,
          timestamp: Date.now()
        }
      })
      return
    }

    if (msg.type === 'stream_end') {
      this.streamListeners.get(msg.id)?.({ done: true })
      return
    }

    this.pending.get(msg.id)?.resolve(msg)
  }

  // ─── Ping / Keepalive ────────────────────────────────────

  private startPing(ws: WebSocket) {
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendWire(ws, { id: crypto.randomUUID(), type: 'ping' })
      }
    }, PING_INTERVAL_MS)
  }

  private clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private sendWire(ws: WebSocket, msg: WireMessage) {
    ws.send(JSON.stringify(msg))
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
