// ============================================================
// Conduit — WebSocket Transport
// Persistent connection to server outposts.
// Handles reconnection, request/response framing, streaming.
// ============================================================

import { BaseTransport } from './base.ts'
import {
  DEFAULT_DEADLINE_MS, DEFAULT_MAX_BYTES, DEFAULT_RETRY_LIMIT, DEFAULT_TIMEOUT_MS, IDEMPOTENT_METHODS,
  backoffWithJitter, declineReplay, sleep,
} from './http.ts'
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

// Wire protocol — every message over the WebSocket has this shape
interface WireMessage {
  id:      string
  type:    'request' | 'response' | 'stream_chunk' | 'stream_end' | 'error' | 'ping' | 'pong'
  method?: string
  path?:   string
  // Lowercased names, the target's constant headers under the caller's, and the
  // idempotency key under the target's header name. Credentials are not here:
  // they authenticate the upgrade, not the frame.
  headers?: Record<string, string>
  query?:   Record<string, string | string[]>
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
  resolve:  (msg: WireMessage) => void
  reject:   (err: Error) => void
  oversize: () => void
  timer:    ReturnType<typeof setTimeout>
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
  private lastSeq         = new Map<string, number>()
  private pingTimer:      ReturnType<typeof setInterval> | null = null
  private heard           = true
  private reconnecting   = false
  private destroyed       = false
  private reconnectCount  = 0

  onReconnect?: (target: string) => void

  // The numbers an http target declares. `max_response_bytes` bounds one
  // inbound frame; `retry_limit` and `deadline_ms` bound `send()` only, since a
  // stream that died mid-way cannot be resumed from where it stopped.
  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    private opts: {
      timeout_ms?:         number
      retry_limit?:        number
      deadline_ms?:        number
      max_response_bytes?: number
      onRetry?:            (req: ConduitRequest, err: ConduitError, attempt: number) => void
    } = {},
  ) {
    super(descriptor, credentials)
  }

  // Minted per send, never per frame, for the same reason http mints it once:
  // a replay must present the key the first attempt did.
  private keyFor(req: ConduitRequest): string | undefined {
    const auto = this.descriptor.idempotency?.auto === true
    return req.idempotency_key
      ?? (auto && !IDEMPOTENT_METHODS.has(req.method.toUpperCase()) ? crypto.randomUUID() : undefined)
  }

  // The envelope's headers, query and idempotency key, built the same way for
  // a stream and a one-shot request.
  private frameFor(req: ConduitRequest, key: string | undefined): Pick<WireMessage, 'method' | 'path' | 'headers' | 'query' | 'body'> {
    const headers = this.mergeHeaders(
      key ? { [this.idempotencyHeader()]: key } : undefined,
      this.descriptor.headers,
      req.headers,
    )

    const query: Record<string, string | string[]> = { ...this.descriptor.query }
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue
      query[k] = Array.isArray(v) ? v.map(String) : String(v)
    }

    return {
      method:  req.method,
      path:    req.path,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(query).length   ? { query }   : {}),
      body:    req.body,
    }
  }

  // The ladder http runs, minus what a socket has no use for: a remint (the
  // credential authenticates the upgrade) and `Retry-After` (a frame has no
  // headers back). A reply that never came is a `timeout`, and whether it was
  // applied is unknown, so the same `declineReplay` judges it.
  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const retries  = this.opts.retry_limit ?? DEFAULT_RETRY_LIMIT
    const deadline = performance.now() + (this.opts.deadline_ms ?? DEFAULT_DEADLINE_MS)
    const key      = this.keyFor(req)
    const sent: ConduitRequest = key === req.idempotency_key ? req : { ...req, idempotency_key: key }
    const replayable = IDEMPOTENT_METHODS.has(req.method.toUpperCase()) || key !== undefined || req.replayable === true
    let   attempt  = 0

    while (true) {
      if (req.signal?.aborted) {
        return this.fail('aborted', `Canceled by the caller before attempt ${attempt + 1}`, { retryable: true })
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        return this.fail('timeout', 'Total deadline exceeded before the request completed', { retryable: true })
      }

      const result = await this.sendOnce<T>(sent, key, remaining)

      if (result.error === null || !result.error.retryable) return result
      if (result.error.kind === 'auth_failed')              return result
      if (result.error.kind === 'aborted')                  return replayable ? result : declineReplay(result)
      if (!replayable)                                      return declineReplay(result)
      if (attempt === retries)                              return result

      attempt++
      this.opts.onRetry?.(sent, result.error, attempt)

      const wait = backoffWithJitter(attempt)
      if (performance.now() + wait >= deadline) return result
      await sleep(wait, req.signal)
    }
  }

  private async sendOnce<T>(req: ConduitRequest, key: string | undefined, budgetMs: number): Promise<ConduitResult<T>> {

    let ws: WebSocket | null
    try {
      ws = await this.getConnection()
    } catch (err) {
      if (err instanceof CredentialError) {
        return this.fail('auth_failed', err.message, this.credentialFailure(err))
      }
      throw err
    }

    if (!ws) {
      // Nothing was written to a socket that never opened, so a replay is safe.
      return this.fail('connection_failed', `Cannot connect to ${this.descriptor.id}`, {
        retryable: true, raw: { code: 'ConnectionRefused' }
      })
    }

    if (req.signal?.aborted) {
      return this.fail('aborted', 'Canceled by the caller before it was sent', { retryable: true })
    }

    const id = crypto.randomUUID()

    return new Promise<ConduitResult<T>>((resolve) => {
      // The far side may still answer; the frame is dropped as unknown.
      const cancel = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(this.fail('aborted', 'Canceled by the caller', { retryable: true }))
      }
      const timer = setTimeout(() => {
        req.signal?.removeEventListener('abort', cancel)
        this.pending.delete(id)
        resolve(this.fail('timeout', 'WS request timed out', { retryable: true }))
      }, Math.min(req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS, budgetMs))
      req.signal?.addEventListener('abort', cancel, { once: true })

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          req.signal?.removeEventListener('abort', cancel)
          this.pending.delete(id)
          if (msg.error) {
            resolve(this.fail('server_error', msg.error, { retryable: false }))
          } else {
            resolve(this.ok<T>(msg.body as T))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          req.signal?.removeEventListener('abort', cancel)
          this.pending.delete(id)
          resolve(this.fail('connection_failed', err.message, { retryable: true }))
        },
        oversize: () => {
          clearTimeout(timer)
          req.signal?.removeEventListener('abort', cancel)
          this.pending.delete(id)
          resolve(this.fail('invalid_response', `Response exceeded ${this.maxBytes} bytes and was discarded`, { retryable: false }))
        },
        timer
      })

      this.sendWire(ws, { id, type: 'request', ...this.frameFor(req, key) })
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
          ...this.credentialFailure(err),
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

    // The body passes through untouched.
    this.sendWire(ws, { id, type: 'request', ...this.frameFor(req, this.keyFor(req)), stream: true })

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
      this.lastSeq.delete(id)
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

    // Memoize the in-flight connect. Without this, N concurrent sends made
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

    // Any frame proves the peer is there; a pong is only the one sent for it.
    this.heard = true
    if (msg.type === 'pong') return

    // The cap is on the frame, the unit this transport reads. A frame over it
    // ends the request or stream it answers rather than being delivered.
    if (typeof e.data === 'string' && Buffer.byteLength(e.data) > this.maxBytes) {
      const listener = this.streamListeners.get(msg.id)
      if (listener) {
        listener({
          done:  true,
          error: {
            kind:      'invalid_response',
            target:    this.descriptor.id,
            protocol:  this.protocol,
            message:   `A frame exceeded ${this.maxBytes} bytes and was discarded`,
            retryable: false,
          }
        })
      }
      this.pending.get(msg.id)?.oversize()
      return
    }

    if (msg.type === 'stream_chunk') {
      const listener = this.streamListeners.get(msg.id)
      if (!listener) return

      // A stream's seq counts up by one from wherever the far side starts it.
      // A skipped number is a chunk this consumer never sees, and nothing else
      // would say so. A frame with no seq is not checked.
      const last = this.lastSeq.get(msg.id)
      if (typeof msg.seq === 'number') {
        if (last !== undefined && msg.seq !== last + 1) {
          this.streamListeners.delete(msg.id)
          this.lastSeq.delete(msg.id)
          listener({
            done:  true,
            error: {
              kind:      'invalid_response',
              target:    this.descriptor.id,
              protocol:  this.protocol,
              message:   `Stream sequence gap: expected ${last + 1}, received ${msg.seq}`,
              retryable: false,
            }
          })
          return
        }
        this.lastSeq.set(msg.id, msg.seq)
      }

      listener({
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
    this.heard = true
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      // A whole interval with no frame of any kind after a ping: the peer is
      // gone without a FIN, and every pending send would wait out its own
      // timeout against a socket that can never answer. Terminating fires the
      // close handler, which fails them as `connection_failed` at once.
      if (!this.heard) {
        // Bun's client socket has it; the DOM type does not.
        const bunSocket = ws as WebSocket & { terminate(): void }
        bunSocket.terminate()
        return
      }
      this.heard = false
      this.sendWire(ws, { id: crypto.randomUUID(), type: 'ping' })
    }, PING_INTERVAL_MS)
  }

  private clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private get maxBytes() {
    return this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES
  }

  private sendWire(ws: WebSocket, msg: WireMessage) {
    ws.send(JSON.stringify(msg))
  }
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
