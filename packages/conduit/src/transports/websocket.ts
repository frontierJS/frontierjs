// ============================================================
// Conduit — WebSocket Transport
// Persistent connection to server outposts.
// Handles reconnection, request/response framing, streaming.
// ============================================================

import { BaseTransport } from './base.ts'
import { ConduitStreamError, CredentialError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
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

// Internal stream event — keeps the end signal out of ConduitChunk.
// `error` distinguishes a clean stream_end from a socket that dropped
// mid-stream; without it a consumer cannot tell "the log ended" from
// "the connection died" (§2.2).
type StreamEvent =
  | { done: false; chunk: ConduitChunk }
  | { done: true; error?: ConduitError }

export class WebSocketTransport extends BaseTransport {
  readonly protocol = 'websocket' as const

  private ws:             WebSocket | null = null
  private connecting:     Promise<WebSocket | null> | null = null
  private pending         = new Map<string, PendingRequest>()
  private streamListeners = new Map<string, (event: StreamEvent) => void>()
  private pingTimer:      ReturnType<typeof setInterval> | null = null
  private reconnecting    = false
  private destroyed       = false
  private reconnectCount  = 0

  onReconnect?: (target: string) => void

  constructor(descriptor: TargetDescriptor, credentials: CredentialResolver) {
    super(descriptor, credentials)
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {

    let ws: WebSocket | null
    try {
      ws = await this.getConnection()
    } catch (err) {
      if (err instanceof CredentialError) {
        return this.fail('auth_failed', err.message, { retryable: false })
      }
      throw err
    }

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
            resolve(this.ok<T>(msg.body as T))
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
    let ws: WebSocket | null
    try {
      ws = await this.getConnection()
    } catch (err) {
      if (err instanceof CredentialError) {
        throw new ConduitStreamError({
          kind:      'auth_failed',
          target:    this.descriptor.id,
          protocol:  this.protocol,
          message:   err.message,
          retryable: false,
        })
      }
      throw err
    }

    // Throw rather than return: an unreachable outpost and an outpost with no
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
            // A socket that dropped mid-stream terminates the consumer with
            // an error. Previously the close handler touched only `pending`,
            // so a live `for await` simply never woke again — any network
            // blip during a log tail wedged the caller forever (§2.2).
            if (event.error) throw new ConduitStreamError(event.error)
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

    // Terminate live stream consumers too — otherwise a `for await` blocks
    // forever on a transport that has been torn down.
    for (const listener of this.streamListeners.values()) {
      listener({
        done:  true,
        error: {
          kind:      'stream_error',
          target:    this.descriptor.id,
          protocol:  this.protocol,
          message:   'Transport destroyed',
          retryable: false,
        }
      })
    }
    this.streamListeners.clear()
  }

  // ─── Connection Management ────────────────────────────────

  private async getConnection(): Promise<WebSocket | null> {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws

    // Memoise the in-flight connect. Without this, N concurrent sends made
    // before the socket is up each opened their own socket; every `open`
    // handler overwrote this.ws and this.pingTimer, so all but the last
    // became untracked — still open on both ends, each with an orphaned
    // ping interval that nothing could ever clear (§2.1).
    if (this.connecting) return this.connecting

    this.connecting = this.connect().finally(() => { this.connecting = null })
    return this.connecting
  }

  private async connect(): Promise<WebSocket | null> {
    if (this.destroyed) return null

    // Credentials are applied to the upgrade request. Resolved before the
    // socket is constructed so an unresolvable ref throws CredentialError
    // and no unauthenticated connection is ever opened (§1.1).
    //
    // The signature covers method CONNECT and the address path, so a
    // captured upgrade signature cannot be replayed against a different
    // endpoint. There is no per-frame signature: this authenticates the
    // connection, and anything able to write to an established socket can
    // issue any command on it.
    const headers = await this.buildAuthHeaders({
      method: 'CONNECT',
      path:   safePath(this.descriptor.address),
      // The upgrade URL's query is signed too, or a verifier recomputing from
      // the raw request URL builds a different canonical string than this side
      // did and refuses every connection to an address carrying one
      // (`FJS-678`).
      query:  safeQuery(this.descriptor.address),
    })

    return new Promise((resolve) => {
      // `headers` is a Bun extension to the WebSocket constructor — the
      // standard signature takes only protocols. Conduit is Bun-only
      // (see engines.bun), so this is a supported path, not a hack.
      const ws = new WebSocket(this.descriptor.address, { headers } as unknown as string[])

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
        // Only surrender the slot if this socket is still the live one —
        // a late close from a superseded socket must not null out a
        // healthy connection.
        if (this.ws === ws) this.ws = null

        for (const pending of this.pending.values()) {
          pending.reject(new Error('WebSocket closed'))
        }
        this.pending.clear()

        // Wake every live stream consumer with a terminal error rather than
        // leaving them blocked on a notify that will never fire.
        const err: ConduitError = {
          kind:      'stream_error',
          target:    this.descriptor.id,
          protocol:  this.protocol,
          message:   'WebSocket closed before the stream ended',
          retryable: true,
        }
        for (const listener of this.streamListeners.values()) {
          listener({ done: true, error: err })
        }
        this.streamListeners.clear()

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
    // Clear any prior timer first — otherwise a reconnect leaks the old
    // interval, which pings a dead socket forever and keeps the event loop
    // alive at shutdown.
    this.clearPing()
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

// The path component of a ws:// address, for signature binding.
// Falls back to '/' for anything unparseable rather than throwing —
// a malformed address should fail at connect, not at signing.
function safePath(address: string): string {
  try {
    return new URL(address).pathname || '/'
  } catch {
    return '/'
  }
}

function safeQuery(address: string): string {
  try {
    return new URL(address).search
  } catch {
    return ''
  }
}
