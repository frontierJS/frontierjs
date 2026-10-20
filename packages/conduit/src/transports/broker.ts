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
  BrokerFraming,
  BrokerGap,
  BrokerLink,
} from '../types.ts'
import { ConduitStreamError } from '../types.ts'
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './http.ts'

const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000]
// A framing's keepalive, unless it says otherwise: khat's numbers.
const PING_EVERY_MS = 30_000
const DEAD_AFTER_MS = 60_000

// Conduit's own frames, for a broker whose connector supplies none.
export const CONDUIT_FRAMING: BrokerFraming<void> = {
  decode(frame) {
    let f: { id?: unknown; type?: unknown; body?: unknown }
    try { f = JSON.parse(frame) } catch { return null }
    if (f?.type !== 'message' || typeof f.id !== 'string' || f.id === '') return null
    return { id: f.id, body: f.body }
  },
  ack: (m) => JSON.stringify({ id: m.id, type: 'ack' }),
}

export class BrokerTransport extends BaseTransport {
  readonly protocol = 'websocket' as const

  private ws:        WebSocket | null = null
  // Open and not yet believed: `destroy()` must close it too.
  private dialing:   WebSocket | null = null
  private handler:   BrokerHandler | null = null
  private timer:     ReturnType<typeof setTimeout> | null = null
  private attempts   = 0
  private destroyed  = false
  private lastReceivedAt: number | null = null
  private received   = 0
  private dropped    = 0
  private framing:   BrokerFraming<any> = CONDUIT_FRAMING
  private opened:    ((state: unknown) => void | Promise<void>) | null = null
  private gap:       ((g: BrokerGap) => void | Promise<void>) | null = null
  // Ends the current connection's timers, which a close may never come to end.
  private hangUp:    (() => void) | null = null

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

  // biome-ignore lint/correctness/useYield: a stub that refuses before it would yield
  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    throw new ConduitStreamError({
      kind:      'invalid_request',
      target:    this.descriptor.id,
      protocol:  this.protocol,
      message:   `Target ${this.descriptor.id} is a broker: it is subscribed to, not streamed from`,
      retryable: false,
    })
  }

  get gatesReadiness(): boolean {
    return this.descriptor.readiness === true
  }

  // The reading `app.registerReadiness` is handed. A subscription that has
  // stopped consuming looks exactly like a quiet broker, so `connected` is the
  // half that cannot be mistaken for quiet, and `last_received_at` the half an
  // operator compares against what the broker says it sent.
  health(): BrokerHealth {
    return {
      connected:        this.ws?.readyState === WebSocket.OPEN,
      last_received_at: this.lastReceivedAt,
      received:         this.received,
      dropped:          this.dropped,
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
    framing: BrokerFraming<any> = CONDUIT_FRAMING,
    opened: ((state: unknown) => void | Promise<void>) | null = null,
    gap: ((g: BrokerGap) => void | Promise<void>) | null = null,
  ): Promise<void> {
    if (this.handler) throw new Error(`[conduit] ${this.descriptor.id} already has a subscriber`)
    this.handler      = handler
    this.traceHeaders = traceHeaders
    this.framing      = framing
    this.opened       = opened
    this.gap          = gap
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
    this.dialing?.close()
    this.hangUp?.()
    this.ws = null
    this.dialing = null
  }

  private async connect(): Promise<void> {
    if (this.destroyed) return

    // Resolved before the socket exists, so an unresolvable ref opens no
    // unauthenticated connection — the websocket transport's rule. The secret
    // the dial spent is the one a handshake presents, so the two cannot name
    // different credentials.
    const address = this.descriptor.address
    const spent: { value?: string } = {}
    // Trace sits under auth, so nothing can displace a credential.
    const headers = this.mergeHeaders(this.traceHeaders?.(), await this.buildAuthHeaders({
      method: 'CONNECT',
      path:   pathOf(address),
      query:  queryOf(address),
      spent,
    }))
    const framing = this.framing

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(address, { headers } as unknown as string[])
      this.dialing = ws

      // A broker that accepts the connection and never completes the upgrade
      // neither opens nor errors, which would hold `subscribe()` for good. The
      // same clock covers the handshake: a Provider that never answers the
      // challenge is the same silence one step later.
      const dialTimer = setTimeout(() => lost(true), this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS)

      // Until the handshake answers, frames are the handshake's; after, they
      // are handed over one at a time in the order they arrived, since a
      // Provider's edit overtaking its create is a row the sync writes wrong.
      const link = handshakeLink(ws)
      let believed = false
      let state: unknown
      let order = Promise.resolve()
      // The highest number the framing's `sequence` read on this connection.
      const seq = { last: null as number | null }

      const keepalive = framing.keepalive
      let heard = Date.now()
      let beat: ReturnType<typeof setInterval> | null = null
      let deadline: ReturnType<typeof setTimeout> | null = null

      // Once per connection, by whichever comes first: its close, the dial
      // timer, a refused handshake, or the silence that says it died without
      // a close. A socket given up for silence may close much later or never,
      // and that late close must not dial a second connection beside the
      // first one's replacement. `drop` cuts it rather than closing, since a
      // close waits on an answer a dead peer never sends.
      let gone = false
      const lost = (drop = false) => {
        if (gone) return
        gone = true
        clearTimeout(dialTimer)
        if (beat) clearInterval(beat)
        if (deadline) clearTimeout(deadline)
        if (this.hangUp === lost) this.hangUp = null
        link.closed()
        if (this.ws === ws) this.ws = null
        if (this.dialing === ws) this.dialing = null
        if (drop) terminate(ws)
        resolve()
        if (!this.destroyed) this.scheduleReconnect()
      }
      this.hangUp = lost

      ws.addEventListener('open', async () => {
        try {
          state = framing.handshake ? await framing.handshake(link, spent.value ?? null) : undefined
        } catch (err) {
          console.error(`[conduit] broker ${this.descriptor.id} handshake failed:`, (err as Error)?.message ?? err)
          ws.close()
          lost()
          return
        }
        if (gone || ws.readyState !== WebSocket.OPEN) return
        clearTimeout(dialTimer)
        believed      = true
        this.dialing  = null
        this.ws       = ws
        this.attempts = 0
        if (keepalive) {
          let n = 0
          heard = Date.now()
          beat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(keepalive.ping(++n, state))
          }, keepalive.every_ms ?? PING_EVERY_MS)
          // Checked when it would have expired rather than reset on every
          // frame, so a busy connection costs no timer per frame.
          const dead = keepalive.dead_ms ?? DEAD_AFTER_MS
          const watch = () => {
            const left = heard + dead - Date.now()
            if (left > 0) { deadline = setTimeout(watch, left); return }
            console.error(`[conduit] broker ${this.descriptor.id} sent nothing for ${dead}ms; redialing`)
            lost(true)
          }
          deadline = setTimeout(watch, dead)
        }
        // Ahead of the connection's first frame in the same chain, so a
        // backfill it starts is never overtaken by what it is filling behind.
        const opened = this.opened
        if (opened) order = order.then(async () => {
          try { await opened(state) } catch (err) {
            console.error(`[conduit] broker ${this.descriptor.id} opened() threw:`, (err as Error)?.message ?? err)
          }
        })
        resolve()
      })
      ws.addEventListener('error', () => { clearTimeout(dialTimer); resolve() })
      ws.addEventListener('close', () => lost())
      ws.addEventListener('message', (e) => {
        if (gone) return
        // Any frame is proof of life, an oversize one and the ping's reply too.
        heard = Date.now()
        const frame = this.admit(e)
        if (frame === null) return
        if (!believed) { link.push(frame); return }
        try { if (keepalive?.pong?.(frame, state)) return } catch {}
        order = order.then(() => this.onFrame(ws, framing, frame, state, seq))
      })
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

  // Dropped unhandled and unacked, so the broker redelivers it and an operator
  // sees it, rather than the process buffering what it was told not to.
  private admit(e: MessageEvent): string | null {
    const size = typeof e.data === 'string' ? Buffer.byteLength(e.data) : (e.data as ArrayBuffer).byteLength
    if (size > (this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES)) {
      this.dropped++
      console.error(`[conduit] broker ${this.descriptor.id} sent a ${size}-byte frame over max_response_bytes; dropped`)
      return null
    }
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
  }

  // The ack follows the handler and never precedes it: an ack before the
  // handoff is a lost message, and an ack after an idempotent handoff that then
  // fails to go out is a redelivery that costs nothing (FJS-D235). A handler
  // that throws leaves the message unacknowledged for the broker to redeliver.
  private async onFrame(ws: WebSocket, framing: BrokerFraming<any>, frame: string, state: unknown, seq: { last: number | null }) {
    let message: BrokerMessage | null
    try { message = framing.decode(frame, state) } catch { message = null }
    if (!message) { this.dropped++; return }

    // Ahead of the frame that showed it, as `opened` is ahead of a
    // connection's first: a backfill it starts is not overtaken by the frame.
    let n: number | null = null
    try { n = framing.sequence?.(message, state) ?? null } catch {}
    if (typeof n === 'number' && Number.isFinite(n)) {
      const after = seq.last
      if (after === null || n > after) seq.last = n
      if (after !== null && n > after + 1 && this.gap) {
        try { await this.gap({ connection: state, after, at: n }) } catch (err) {
          console.error(`[conduit] broker ${this.descriptor.id} gap() threw:`, (err as Error)?.message ?? err)
        }
      }
    }

    this.lastReceivedAt = Date.now()
    this.received++

    try {
      await this.handler!(message)
    } catch (err) {
      console.error(`[conduit] broker handler for ${this.descriptor.id} threw on ${message.id}:`, err)
      return
    }
    if (framing.ack && ws.readyState === WebSocket.OPEN) ws.send(framing.ack(message))
  }
}

// The frames a handshake reads. Buffered only until the handshake answers —
// a bounded wait the dial timer ends — and never after.
function handshakeLink(ws: WebSocket): BrokerLink & { push(frame: string): void; closed(): void } {
  const queue: string[] = []
  let waiting: { match: (f: string) => boolean; resolve: (f: string) => void; reject: (e: Error) => void } | null = null
  let shut = false
  const take = () => {
    if (!waiting) return
    while (queue.length) {
      const f = queue.shift()!
      if (waiting.match(f)) { const w = waiting; waiting = null; w.resolve(f); return }
    }
    if (shut) { const w = waiting; waiting = null; w.reject(new Error('the socket closed during the handshake')) }
  }
  return {
    send: (frame) => ws.send(frame),
    next: (match) => new Promise((resolve, reject) => { waiting = { match, resolve, reject }; take() }),
    push: (frame) => { queue.push(frame); take() },
    closed: () => { shut = true; take() },
  }
}

// Bun's `terminate()` ends the socket now; elsewhere `close()` is the most
// there is.
function terminate(ws: WebSocket) {
  const w = ws as WebSocket & { terminate?: () => void }
  if (ws.readyState === WebSocket.CLOSED) return
  if (typeof w.terminate === 'function') w.terminate()
  else ws.close()
}

function pathOf(address: string): string {
  try { return new URL(address).pathname || '/' } catch { return '/' }
}
function queryOf(address: string): string {
  try { return new URL(address).search } catch { return '' }
}
