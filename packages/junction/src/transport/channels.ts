// transport/channels.ts
// Real-time channels — Feathers model, Bun WebSocket underneath.
//
// A Channel is a named group of WebSocket connections.
// After every service mutation, the publish() hook sends the result
// to every connection in the target channels.
//
// ─── Minimal wiring ───────────────────────────────────────────────────────
//
//   import { channels, publish } from '@frontierjs/junction'
//
//   // 1. Configure which channels a connection joins on connect
//   app.configure(channels(app => {
//     app.channels.on('connection', (session, conn) => {
//       app.channel('all').join(conn)
//       if (session?.workspaceId)
//         app.channel(`workspace:${session.workspaceId}`).join(conn)
//     })
//   }))
//
//   // 2. Publish service results to channels after mutations
//   service.hooks({
//     after: {
//       create: [publish((result, ctx) =>
//         ctx.auth.user?.workspaceId
//           ? app.channel(`workspace:${ctx.auth.user.workspaceId}`)
//           : null
//       )],
//     }
//   })
//
//   // 3. Client receives:
//   //   { type: 'event', event: 'deployments created', data: { id: '...', ... } }

import { createPresenceTracker } from './presence.ts'
import { AUTO_EVENT_MAP }       from '../core/service.ts'
import { unwrapResult }         from '../core/envelope.ts'
import { wsSend }               from './send-queue.ts'
import type { ServiceContext } from './bridge.ts'
import type { IAuth }          from '../auth/types.ts'
import type { App, Plugin }    from '../core/app.ts'
import type { WsContext }      from './types.ts'

// ─── Types ────────────────────────────────────────────────────────────────

export interface Connection {
  id:       string
  socket:   BunWS
  data:     Record<string, unknown>
  user?:    import('../auth/types.ts').SessionContext | null

  // Written by Channel.join(), read by the presence manager. Declared rather
  // than stashed through a cast so both ends are checked against one name — a
  // misspelling on either side is a member that joins with no metadata and
  // nothing that says so.
  __joinMeta?: Record<string, unknown>
}

// Minimal interface used by Channel.send() broadcast loop.
// Connection.socket is the raw WS — obtained from ctx.$ws in the handler.
// `send` returns a number and that number is load-bearing: 0 means the frame
// was DROPPED under backpressure. Typing it `void` is how five call sites came
// to ignore it — every send here goes through wsSend (send-queue.ts) instead.
type BunWS = {
  send:       (data: string) => number
  close:      (code?: number, reason?: string) => void
  readyState: number
}

export type PublishFn<T = unknown> = (
  data: T,
  ctx:  ServiceContext
) => Channel | Channel[] | null | false

export interface WSMessage {
  type:     string
  event?:   string
  data?:    unknown
  id?:      string
  channel?: string
  meta?:    Record<string, unknown>
  // The browser client has sent call parameters under both names; the WS
  // dispatcher reads `meta` first and falls back. See the id-in-params note in
  // the dispatcher.
  params?:  Record<string, unknown>

  // A `service_call` frame: which service, which method. Read by the dispatcher
  // and by the telemetry line beside it, and previously reached through a cast,
  // so the frame's own shape did not say that a call travels this way.
  service?: string
  method?:  string
}

// ─── Presence ─────────────────────────────────────────────────────────────

export interface PresenceMember {
  connectionId: string
  userId:       string | number
  channelId:    string
  joinedAt:     Date
  meta:         Record<string, unknown>  // always an object, never null/undefined
}

// ─── Wire format ─────────────────────────────────────────────────────────
// The single event-frame encoder for every broadcast path (Channel.send,
// broadcastToChannel, sendToConn, publish). One implementation → one wire
// format that can't drift, and JSON.stringify correctly omits undefined
// data instead of emitting invalid JSON.

export function encodeEventFrame(event: string, data: unknown): string {
  return JSON.stringify({ type: 'event', event, data })
}

// ─── Channel ──────────────────────────────────────────────────────────────

export class Channel {

  readonly name:        string
  readonly connections: Set<Connection>

  // Set by the presence plugin the first time it wraps this channel's
  // join/leave. `channel(name)` is called on every publish, so without the
  // guard the wrappers stack and one join counts N times.
  __presenceWrapped?: boolean

  constructor(name: string) {
    this.name        = name
    this.connections = new Set()
  }

  join(connection: Connection, opts?: { meta?: Record<string, unknown> }): this {
    this.connections.add(connection)
    // Store join opts on connection for presence manager to read
    if (opts?.meta) connection.__joinMeta = opts.meta
    return this
  }

  leave(connection: Connection): this {
    this.connections.delete(connection)
    return this
  }

  filter(fn: (connection: Connection) => boolean): Channel {
    const filtered = new Channel(`${this.name}:filtered`)
    for (const conn of this.connections) {
      if (fn(conn)) filtered.join(conn)
    }
    return filtered
  }

  get length(): number { return this.connections.size }

  // Send an event to all live connections in this channel.
  // Serialization goes through encodeEventFrame — ONE wire format for all
  // broadcast paths. (The old template-string variant here produced invalid
  // JSON when data was undefined: `"data":undefined`.)
  send(event: string, data: unknown): void {
    this.sendRaw(encodeEventFrame(event, data))
  }

  // Send an already-serialized frame — lets multi-channel publishes
  // serialize the payload once instead of once per channel.
  sendRaw(msg: string): void {
    for (const conn of this.connections) {
      if (conn.socket.readyState === 1) wsSend(conn.socket, msg)
    }
  }

  gc(): void {
    for (const conn of this.connections) {
      if (conn.socket.readyState !== 1) this.connections.delete(conn)
    }
  }
}

// ─── Channel manager ──────────────────────────────────────────────────────

export function createChannelManager() {

  const channels    = new Map<string, Channel>()
  const connections = new Map<string, Connection>()

  // The app-level fallback publisher — see publishDefault() below. Null until
  // an app registers one, which is what keeps broadcasting opt-in.
  let _default: PublishFn | null = null

  // ── Send primitives ─────────────────────────────────────────────────
  function broadcastToChannel(channelId: string, excludeConnId: string | null, event: string, data: unknown): void {
    const ch = channels.get(channelId)
    if (!ch) return
    const msg = encodeEventFrame(event, data)
    for (const conn of ch.connections) {
      if (conn.id === excludeConnId) continue
      if (conn.socket.readyState === 1) wsSend(conn.socket, msg)
    }
  }

  function sendToConn(conn: Connection, event: string, data: unknown): void {
    if (conn.socket.readyState === 1) wsSend(conn.socket, encodeEventFrame(event, data))
  }

  // ── Presence tracking — extracted to presence.ts ────────────────────
  // The tracker owns the presence maps and the join/sync/leave broadcast
  // protocol; the manager supplies the send primitives.
  const _presence = createPresenceTracker({
    broadcast:  broadcastToChannel,
    sendToConn,
  })
  const presenceFor     = _presence.presenceFor
  const presenceMembers = _presence.members
  const presenceGet     = _presence.get
  const presenceByUser  = _presence.byUser
  const presenceJoin    = _presence.join
  const presenceLeave   = _presence.leave

  const onConnectHandlers:    Array<(session: unknown, conn: Connection) => void | Promise<void>> = []
  const onDisconnectHandlers: Array<(conn: Connection) => void | Promise<void>> = []

  const gcTimer = setInterval(() => {
    for (const channel of channels.values()) {
      channel.gc()
      // Drop channels with no live connections — the map otherwise grows
      // by one entry per channel name ever used, forever. NOTE: callers
      // should re-fetch channels via manager.channel(name) rather than
      // holding long-lived Channel references; a pruned instance is
      // replaced by a fresh one on next access.
      if (channel.length === 0) channels.delete(channel.name)
    }
  }, 30_000)
  if (gcTimer.unref) gcTimer.unref()

  function getOrCreate(name: string): Channel {
    let ch = channels.get(name)
    if (!ch) { ch = new Channel(name); channels.set(name, ch) }
    return ch
  }

  return {

    channel(name: string): Channel {
      const ch = getOrCreate(name)

      // Wrap join/leave exactly once to automatically update presence.
      // __presenceWrapped guards against re-wrapping on repeated channel() calls.
      if (!ch.__presenceWrapped) {
        ch.__presenceWrapped = true

        const originalJoin  = ch.join.bind(ch)
        const originalLeave = ch.leave.bind(ch)

        ch.join = (conn: Connection, opts?: { meta?: Record<string, unknown> }) => {
          originalJoin(conn, opts)
          presenceJoin(conn, name)
          return ch
        }

        ch.leave = (conn: Connection) => {
          originalLeave(conn)
          presenceLeave(conn, name)
          return ch
        }
      }

      return ch
    },

    // Exposed for the WS service dispatcher — read-only access to live connections
    get connections(): ReadonlyMap<string, Connection> {
      return connections
    },

    // Called by the WS handler in _wsOpen (after auth resolves)
    async handleConnection(
      socket:  BunWS,
      session: import('../auth/types.ts').SessionContext | null,
      data:    Record<string, unknown> = {}
    ): Promise<Connection> {

      const conn: Connection = {
        id:     crypto.randomUUID(),
        socket,
        data,
        user:   session,
      }

      connections.set(conn.id, conn)
      // Send ack with connection id so the client can correlate responses
      wsSend(socket, JSON.stringify({ type: 'connection', id: conn.id }))

      for (const handler of onConnectHandlers) {
        try { await handler(session, conn) } catch {}
      }

      return conn
    },

    // Called by _wsClose AND by heartbeat eviction
    async handleDisconnect(connId: string): Promise<void> {
      const conn = connections.get(connId)
      if (!conn) return

      connections.delete(connId)

      // Close the socket if it's still open. On a normal close event this
      // is a no-op; on HEARTBEAT EVICTION it's essential — previously the
      // server dropped all its state but left the client connected as a
      // zombie whose subsequent calls ran with conn = null (silently losing
      // the authenticated user).
      try {
        if (conn.socket.readyState === 1) conn.socket.close(1001, 'connection evicted')
      } catch {}

      // channel.leave is wrapped — triggers presenceLeave per channel automatically
      for (const channel of channels.values()) {
        channel.leave(conn)
        // Prune empty channels — high-cardinality names (workspace:{id},
        // user:{id}) otherwise accumulate Channel objects forever.
        if (channel.length === 0) channels.delete(channel.name)
      }
      for (const handler of onDisconnectHandlers) {
        try { await handler(conn) } catch {}
      }
    },

    // Called by _wsMessage — returns parsed message or null on bad JSON
    handleMessage(_connId: string, raw: string | Buffer): WSMessage | null {
      try {
        return JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as WSMessage
      } catch {
        return null
      }
    },

    // ── The app-level fallback publisher ────────────────────────────────
    //
    // Feathers' `app.publish(fn)` is one catch-all deciding where EVERY
    // service event goes, which is how a tenant-shaped app writes *everything
    // a caller may hear goes to their own account channel* once instead of
    // once per service. Junction had no equal: `channel:` is per service, and
    // the natural workaround — an app-level `after: { all: [publish(fn)] }` —
    // is refused at startup by refuseDoubleBroadcast for every service that
    // also declares `channel:`, which is most of them (FJS-334).
    //
    // **A default, not a second broadcaster.** It is consulted only where a
    // service declares nothing, so it composes with `channel:` instead of
    // racing it and cannot put a record on the wire twice. The three states a
    // service already had are what make that work:
    //
    //   channel: 'posts'   this service says where — the default is not asked
    //   channel: false     declared opt-out — not even the default
    //   (absent)           ask the app
    //
    // **Function only, no string form.** A string would name one channel for
    // every service in the app, which is the shape that hands a subscriber
    // rows no @@allow would have let them read — the reason broadcasting is
    // opt-in at all (DECISIONS.md § API design, 2026-08-02). A function is
    // handed the record and the ctx, so the app decides per record.
    //
    // Returns an unsubscribe, like on() — a test that registers one must be
    // able to take it back.
    publishDefault<T = unknown>(fn: PublishFn<T>): () => void {
      _default = fn as PublishFn
      return () => { if (_default === (fn as PublishFn)) _default = null }
    },

    // Read by publishToChannels (core/service.ts) for a service that declares
    // no channel:. A getter rather than a field so the manager stays the one
    // owner of when it is null.
    get defaultPublisher(): PublishFn | null {
      return _default
    },

    // Core send — called by the publish() hook
    async publish<T = unknown>(
      event:     string,
      data:      T,
      ctx:       ServiceContext,
      fn:        PublishFn<T>
    ): Promise<void> {
      const result = fn(data, ctx)
      if (!result) return
      const targets = Array.isArray(result) ? result : [result]
      // Same rule as every other boundary — and now literally the same
      // function. The comment here used to say "mirror HTTP bridge" above a
      // hand-copy of the bridge's logic, which is exactly how two copies drift.
      const payload = unwrapResult(data)

      // Serialize ONCE for all target channels — multi-channel publishes
      // previously re-stringified the payload per channel, and telemetry
      // stringified it a second time just to measure its size.
      const frame = encodeEventFrame(event, payload)
      for (const ch of targets) ch.sendRaw(frame)

      // ── Telemetry ──────────────────────────────────────────────
      const telemetry = ctx.app?.telemetry
      if (telemetry && (typeof telemetry.hasListeners !== 'function' || telemetry.hasListeners())) {
        const recipientCount = targets.reduce((n, ch) => n + ch.length, 0)
        telemetry.emit('junction.channel.publish', {
          channel:        targets.map(ch => ch.name ?? '?').join(','),
          event,
          recipientCount,
          payloadSize:    frame.length,   // frame ≈ payload size; no re-serialization
        })
      }
    },

    // Returns an unsubscribe function so observers (e.g. devtools) can
    // detach on shutdown instead of leaking handlers into the manager.
    on(
      event:   'connection' | 'disconnect',
      handler: (ctx: unknown, conn: Connection) => void | Promise<void>
    ): () => void {
      if (event === 'connection') {
        onConnectHandlers.push(handler)
        return () => {
          const i = onConnectHandlers.indexOf(handler)
          if (i !== -1) onConnectHandlers.splice(i, 1)
        }
      }
      if (event === 'disconnect') {
        const h = handler as (conn: Connection) => void
        onDisconnectHandlers.push(h)
        return () => {
          const i = onDisconnectHandlers.indexOf(h)
          if (i !== -1) onDisconnectHandlers.splice(i, 1)
        }
      }
      return () => {}
    },

    // ── Presence queries — server-side ──────────────────────────────────
    presence(channelId: string): PresenceMember[] {
      return presenceMembers(channelId)
    },

    presenceOf(userId: string | number): Array<Omit<PresenceMember, 'channelId'> & { channelId: string }> {
      return presenceByUser(userId)
    },

    // ── Internal — used by the subscribe message handler in the plugin ────
    // Not part of the public API — prefixed with _ to signal intent.
    _presenceGet(channelId: string, connId: string): PresenceMember | undefined {
      return presenceGet(channelId, connId)
    },
    _presenceMembers:      presenceMembers,
    _broadcastToChannel:   broadcastToChannel,
    _sendToConn:           sendToConn,

    stats() {
      return {
        connections: connections.size,
        channels:    channels.size,
        channelList: Array.from(channels.entries()).map(([name, ch]) => ({
          name, size: ch.length
        }))
      }
    },

    destroy(): void {
      clearInterval(gcTimer)
      channels.clear()
      connections.clear()
    }
  }
}

// ─── channels() plugin factory ────────────────────────────────────────────
// This is the missing wire. Calling app.configure(channels(setup)) does
// three things that previously had to be done manually by every app:
//
//   1. Mounts a /ws WebSocket endpoint that handles auth, connection
//      lifecycle, and routing through the channel manager.
//
//   2. Stamps ctx.locals.__channels on every service call so the
//      publish() hook can find the manager without a global variable.
//
//   3. Calls the optional setup function so the app can declare which
//      channels a connection joins at connect time.
//
// Auth flow:
//   Client connects to ws://host/ws?token=<session_or_api_key>
//   _wsOpen resolves the token asynchronously before joining channels.
//   Invalid tokens get an 'auth_failed' message and are closed.
//   No token → joins only the 'anonymous' channel.

export type ChannelSetupFn = (app: App & { channels: ReturnType<typeof createChannelManager> }) => void

export function channels(setup?: ChannelSetupFn): Plugin {
  let _manager:        ReturnType<typeof createChannelManager> | null = null
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

  return {
    name: 'channels',

    register(app: App): void {
      // Create and attach the channel manager
      const manager = createChannelManager()
      _manager = manager
      ;(app as unknown as Record<string, unknown>).channels = manager

      // Convenience shortcuts
      ;(app as unknown as Record<string, unknown>).channel     = (name: string) => manager.channel(name)
      ;(app as unknown as Record<string, unknown>).presence    = (channelId: string) => manager.presence(channelId)
      ;(app as unknown as Record<string, unknown>).presenceOf  = (userId: string | number) => manager.presenceOf(userId)

      const auth = app.auth

      // Pre-import service dispatch dependencies — resolved once at register,
      // not on every incoming WebSocket message.
      let _bridge:    typeof import('./bridge.ts')      | null = null
      let _callSvc:   typeof import('../core/service.ts') | null = null
      let _errUtils:  typeof import('../core/errors.ts')  | null = null
      let _runWithMeta: typeof import('../core/context.ts').runWithMeta | null = null

      async function ensureDeps() {
        if (!_bridge)   _bridge   = await import('./bridge.ts')
        if (!_callSvc)  _callSvc  = await import('../core/service.ts')
        if (!_errUtils) _errUtils = await import('../core/errors.ts')
        if (!_runWithMeta) _runWithMeta = (await import('../core/context.ts')).runWithMeta
      }

      // Pre-warm on next tick so the first WS message isn't slow
      Promise.resolve().then(ensureDeps).catch(() => {})

      // ── WS handler ──────────────────────────────────────────────
      // Now uses WsContext — no raw Bun WS types leak into this layer.
      // Auth is already resolved by http.ts _wsOpen before open() is called.
      // socketToConnId maps the raw $ws object → connId for lifecycle tracking.
      const socketToConnId = new WeakMap<object, { connId: string; connectedAt: number }>()
      const lastPing        = new Map<string, number>()   // connId → last ping epoch ms

      // ── Heartbeat timeout ─────────────────────────────────────────────
      // Evict connections that haven't pinged within heartbeatTimeout.
      // Default: 30s. Handles silent drops (TCP close, browser crash) that
      // don't fire the WS close event.
      const heartbeatTimeout = 30_000
      _heartbeatTimer = setInterval(() => {
        const staleAt = Date.now() - heartbeatTimeout
        for (const [connId, last] of lastPing) {
          if (last < staleAt) {
            lastPing.delete(connId)
            manager.handleDisconnect(connId).catch(() => {})
          }
        }
      }, 10_000)
      if ((_heartbeatTimer as unknown as { unref?: () => void }).unref) {
        (_heartbeatTimer as unknown as { unref: () => void }).unref()
      }

      app.http.ws('/ws', {

        open: async (ctx: WsContext) => {
          // Auth was resolved by HttpTransport._wsOpen — ctx.user is set.
          // If a token was present but invalid, the connection was already closed
          // there. If no auth plugin is configured, ctx.user is null (anonymous).
          const session = ctx.user

          const conn = await manager.handleConnection(
            ctx.$ws as BunWS,
            session,
            { query: ctx.query, headers: ctx.headers }
          )

          socketToConnId.set(ctx.$ws as object, { connId: conn.id, connectedAt: Date.now() })
          lastPing.set(conn.id, Date.now())

          app.telemetry?.emit('junction.ws.connect', {
            connectionId: conn.id,
            userId:       session?.userId ?? null,
            ip:           ctx.ip,
          })
        },

        message: (ctx: WsContext, msg) => {
          const entry = socketToConnId.get(ctx.$ws as object)
          if (!entry) return
          const connId = entry.connId

          const parsed = manager.handleMessage(connId, msg)
          if (!parsed) return

          // ── Ping/pong keepalive ──────────────────────────────────
          if (parsed.type === 'ping') {
            lastPing.set(connId, Date.now())
            ctx.send({ type: 'pong' })
            return
          }

          // ── Service call ─────────────────────────────────────────
          // Clients can call any registered service method over the socket.
          //
          // Request:
          //   { type: 'service_call', id: '1', service: 'notes', method: 'create',
          //     data: { title: 'Hi' }, params: { query: {}, ... } }
          //
          // Success response:
          //   { type: 'service_result', id: '1', result: { id: '...', title: 'Hi' } }
          //
          // Error response:
          //   { type: 'service_error', id: '1', error: { code: 401, message: '...' } }
          //
          // The full hook pipeline runs — auth, before, after, error — same as HTTP.
          // ctx.transport = 'websocket' so hooks can distinguish if needed.
          // Auto-events fire after successful mutations exactly as with HTTP.
          if (parsed.type === 'service_call') {
            const { id: callId, service: serviceName, method, data } = parsed
            // WS frame carries caller extras (id, query, …) under `meta` —
            // that is what WSMessage declares.
            //
            // `params` is accepted as an alias because the browser client sent
            // extras under that name while the server only ever read `meta`.
            // Nothing matched, so svcCtx.id stayed null and every id-bearing
            // call looked like a bulk operation:
            //
            //   Bulk patch is disabled on this service (set allowBulk: true)
            //
            // It stayed hidden while the channels() plugin was unregistered,
            // because the client silently fell back to HTTP, where the id
            // travels in the URL.
            const extraParams = parsed.meta ?? parsed.params ?? {}

            app.telemetry?.emit('junction.ws.message', {
              connectionId: connId,
              service:      serviceName as string,
              method:       method as string,
            })

            ;(async () => {
              await ensureDeps()
              const { bridge: _bridge2 }         = _bridge!
              const { callService: _call }        = _callSvc!
              const { toFrameworkError: _toErr }  = _errUtils!

              const connMap = (manager as unknown as { connections: Map<string, Connection> }).connections
              const conn    = connMap?.get(connId) ?? null

              const svc = app.services.get(serviceName as string)
              if (!svc) {
                ctx.send({ type: 'service_error', id: callId,
                           error: { code: 404, message: `Service '${serviceName}' not found` } })
                return
              }

              const extra   = (extraParams as Record<string, unknown> ?? {})
              const wsQuery = (extra.query ?? {}) as Record<string, unknown>
              // workspaceId is lifted onto ctx.client.headers below, so it does
              // not also belong in locals — one owner per translation.
              // correlationId/idempotencyKey become request metadata, which is
              // an ALS store rather than a context field.
              const {
                query: _q, workspaceId: _ws,
                correlationId: _cid, idempotencyKey: _idk,
                ...restExtra
              } = extra

              const svcCtx = _bridge2.internal(
                serviceName as string,
                method as 'create',
                (data as Record<string, unknown> | null) ?? null,
                {
                  query: wsQuery,
                  auth:  { user: (conn?.user ?? null) as import('../auth/types.ts').SessionContext | null },
                  transport: 'websocket',
                  locals: { __channels: manager, ...restExtra } as Record<string, unknown>,
                },
                app
              )
              // WS-origin client facts (headers/ip) belong on ctx.client.
              //
              // `ctx.headers` are the UPGRADE request's headers — one set for
              // the life of the connection. Anything a caller varies per call
              // therefore cannot arrive that way, and the workspace is exactly
              // that: X-Workspace-Id changes when a person switches workspace,
              // without reconnecting. The browser client sends it on the frame
              // (meta.workspaceId) and it is merged in here, so a hook reading
              // ctx.client.headers['x-workspace-id'] sees the same value it
              // would have seen over HTTP.
              //
              // ONE key, deliberately. Merging a client-supplied header map
              // wholesale would let a frame carry its own Authorization and
              // override the identity established at upgrade.
              svcCtx.client.headers = extra.workspaceId
                ? { ...ctx.headers, 'x-workspace-id': String(extra.workspaceId) }
                : ctx.headers
              svcCtx.client.ip      = ctx.ip
              svcCtx.method    = method as string
              svcCtx.transport = 'websocket'

              // A STRING, as over HTTP. There the id is a path segment and can be
              // nothing else; here it is whatever JSON type the client wrote, so
              // `patch(42, …)` handed a service the number and `PATCH /x/42`
              // handed it the string. A handler comparing `ctx.id` to a row's own
              // id, or using it as a Map key, then answered differently depending
              // on whether a socket happened to be connected.
              const paramId = extra?.id ?? (data as Record<string, unknown>)?.id
              if (paramId) svcCtx.id = String(paramId)

              // Request metadata is an AsyncLocalStorage store the HTTP handler
              // wraps its pipeline run in, and this path wrapped nothing — so
              // requestMeta() was undefined for every socket call and anything
              // reading it (a correlation id in a log, the Idempotency-Key that
              // decides whether a create runs twice) silently applied to half
              // the transports. The frame carries them under `meta`, the same
              // place it carries the id and the workspace.
              const meta: import('../core/context.ts').RequestMeta = {
                correlationId:  (extra.correlationId as string) ?? crypto.randomUUID(),
                idempotencyKey: extra.idempotencyKey as string | undefined,
                origin:         'websocket',
                // Same as the HTTP path — the principal is request-wide, and it
                // is what an internal call inherits when it names none.
                user:           svcCtx.auth.user,
                client:         svcCtx.client,
              }

              try {
                await _runWithMeta!(meta, () =>
                  _call(svc, svcCtx, app._appHooks, app.events, app.telemetry))
                // The second hand-copy of the bridge's rule. Both now call it.
                ctx.send({ type: 'service_result', id: callId, result: unwrapResult(svcCtx.result) })
              } catch (err: unknown) {
                const fe = _toErr(err)
                ctx.send({ type: 'service_error', id: callId, error: fe.toJSON() })
              }
            })().catch(() => {})

            return
          }

          // ── Subscribe — meta update + presence sync ─────────────────
          // Server owns channel membership — subscribe does NOT join a channel.
          // What it does:
          //   1. Updates presence meta (if provided) for the connection in that channel
          //   2. Emits presence:update to other members
          //   3. Sends presence:sync back to the sender (full current list)
          // If the connection is not in that channel, silently ignored.
          if (parsed.type === 'subscribe') {
            const channelId = parsed.channel as string | undefined
            if (!channelId) return

            const conn = manager.connections.get(connId)
            if (!conn) return

            const member = manager._presenceGet(channelId, connId)

            // Not in this channel — ignore
            if (!member) return

            // Update meta if provided
            if (parsed.meta && typeof parsed.meta === 'object') {
              member.meta = parsed.meta as Record<string, unknown>
              // Emit presence:update to other members
              manager._broadcastToChannel(channelId, connId, 'presence:update', {
                channelId,
                connectionId: connId,
                meta:         member.meta,
              })
            }

            // Always send presence:sync back to sender with full current list
            // (including sender's own — possibly updated — entry)
            manager._sendToConn(conn, 'presence:sync', {
              channelId,
              members: manager._presenceMembers(channelId),
            })
            return
          }

          if (parsed.type === 'unsubscribe') {
            // Apps handle explicit unsubscribe via channels.on() if needed
            return
          }
        },

        close: async (ctx: WsContext) => {
          const entry = socketToConnId.get(ctx.$ws as object)
          if (!entry) return
          lastPing.delete(entry.connId)
          await manager.handleDisconnect(entry.connId)
          app.telemetry?.emit('junction.ws.disconnect', {
            connectionId: entry.connId,
            durationMs:   Date.now() - entry.connectedAt,
          })
        },
      })

      // ── Stamp __channels on every service context ────────────────
      // Added as an app-level around hook so publish() can find the
      // manager without importing it or closing over a variable.
      app.hooks({
        around: {
          all: [async (ctx, next) => {
            ctx.locals.__channels = manager
            await next()
          }]
        }
      })

      // ── WS stats route ───────────────────────────────────────────
      // app.get applies apiPrefix — see the route shortcuts in core/app.ts.
      app.get('/channels/stats', (ctx) => {
        if (!ctx.user) return ctx.json({ error: 'Unauthorized' }, 401)
        return ctx.json(manager.stats())
      })

      // ── Run user setup ───────────────────────────────────────────
      if (setup) {
        setup(app as App & { channels: ReturnType<typeof createChannelManager> })
      }
    },

    // ── The fall-through report ──────────────────────────────────────────
    //
    // Runs only when an app registered a default publisher, and lists the
    // services that will therefore broadcast without ever having said so.
    // That is the failure `publishDefault` introduces and the only one it
    // introduces: before it, forgetting `channel:` meant a screen that never
    // updates — visible, and yours; after it, the same omission puts records
    // on the wire on a rule written for other services, which nothing on the
    // server can see.
    //
    // It is deliberately NOT a report of every service that declares nothing.
    // With no default that is the ruled, intended state (DECISIONS.md § API
    // design, 2026-08-02) and would fire on nearly every service in every app,
    // which is how a warning gets trained out.
    //
    // The report extinguishes itself: `channel: false` is the declared opt-out
    // and drops a service from the list, so an app that has read it once and
    // meant it never sees it again. A service registered after boot is not in
    // the count — plugins that register services from their own boot()/ready()
    // are the case, and there is no later phase this can be asked from that a
    // test-mounted app also runs (`ready-hooks` is needsHost).
    boot(app: App): void {
      if (!_manager?.defaultPublisher) return

      const undeclared = app.services.values()
        .filter(svc => (svc as { channel?: unknown }).channel === undefined)
        .map(svc => svc.name)

      if (undeclared.length === 0) return

      console.warn(
        `[Junction] ${undeclared.length} service(s) declare no channel: and will ` +
        `broadcast on the app-level publishDefault(): ${undeclared.join(', ')}. ` +
        `Declare channel: to name a target, or channel: false to opt out.`
      )
    },

    shutdown(): void {
      _manager?.destroy()
      _manager = null
      if (_heartbeatTimer) {
        clearInterval(_heartbeatTimer)
        _heartbeatTimer = null
      }
    }
  }
}

// ─── publish() hook factory ───────────────────────────────────────────────
// Creates an after hook that pushes a real-time event to the channels returned
// by publishFn. Silently does nothing if the channels plugin isn't loaded.
//
// What gets broadcast:
//   ctx.dispatch !== undefined → ctx.dispatch   (explicit override)
//   ctx.dispatch === false     → nothing         (suppress broadcast)
//   otherwise                 → ctx.result       (default)
//
// Usage:
//   service.hooks({
//     after: {
//       create: [publish((result, ctx) =>
//         app.channel(`workspace:${ctx.auth.user?.workspace_id}`)
//       )],
//     }
//   })
//
// Strip sensitive fields before broadcast:
//   after: {
//     create: [
//       async (ctx) => { ctx.dispatch = { ...(ctx.result as User), password_hash: undefined } },
//       publish(fn),
//     ]
//   }
//
// Suppress broadcast entirely for this call:
//   ctx.dispatch = false
//
// Event name defaults to '<service> <method>' e.g. 'notes created'.
// Override: publish(fn, 'note:published')

// Every hook `publish()` ever produced. A service that declares `channel:` is
// already announced by callService, so a publish hook on the same service sends
// the frame a second time — and a name check cannot tell the two apart, because
// an app is free to call its own hook `publish`. Marking is what makes the
// conflict detectable (FJS-045).
const _publishHooks = new WeakSet<Function>()

export function isPublishHook(fn: unknown): boolean {
  return typeof fn === 'function' && _publishHooks.has(fn as Function)
}

export function publish<T = unknown>(
  fn:     PublishFn<T>,
  event?: string
): import('../core/hooks.ts').Hook {

  // Named so the dev-mode "anonymous hook" warning stays about USER hooks, and
  // so the telemetry waterfall reads 'publish' rather than 'anonymous'.
  const hook = async function publish(ctx: ServiceContext): Promise<void> {

    const manager = ctx.locals.__channels as
      ReturnType<typeof createChannelManager> | undefined

    // Channels plugin not loaded — silent no-op
    if (!manager) return

    // ctx.dispatch === false → caller explicitly suppressed broadcast
    if (ctx.dispatch === false) return

    // Past tense, matching app.events and the browser client.
    //
    // This used to be `${ctx.service} ${ctx.method}` — present tense — so a
    // create put 'posts create' on the wire while every documented example,
    // every test, and the client's own handlers said 'posts created'. The
    // client's created/patched/removed listeners therefore never fired; its
    // '*' fallback caught the traffic and upserted it, which made create and
    // patch look correct and turned every REMOVE into an upsert. A deleted
    // record was re-added to the store and stayed on screen until reload.
    //
    // Custom methods have no past tense and fall through unchanged
    // ('posts archive'), which is what the client's '*' handler expects.
    const eventName = event
      ?? `${ctx.service} ${AUTO_EVENT_MAP[ctx.method as string] ?? ctx.method}`

    // Use ctx.dispatch if explicitly set, otherwise fall back to ctx.result
    const payload = ctx.dispatch !== undefined
      ? ctx.dispatch as T
      : ctx.result as T

    await manager.publish(eventName, payload, ctx, fn)
  }

  _publishHooks.add(hook)
  return hook
}
