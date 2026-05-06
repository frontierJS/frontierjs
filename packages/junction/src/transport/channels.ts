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
//         ctx.params.user?.workspaceId
//           ? app.channel(`workspace:${ctx.params.user.workspaceId}`)
//           : null
//       )],
//     }
//   })
//
//   // 3. Client receives:
//   //   { type: 'event', event: 'deployments created', data: { id: '...', ... } }

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
}

// Minimal interface used by Channel.send() broadcast loop.
// Connection.socket is the raw WS — obtained from ctx.$ws in the handler.
type BunWS = {
  send:       (data: string | Buffer) => void
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
}

// ─── Presence ─────────────────────────────────────────────────────────────

export interface PresenceMember {
  connectionId: string
  userId:       string | number
  channelId:    string
  joinedAt:     Date
  meta:         Record<string, unknown>  // always an object, never null/undefined
}

// ─── Channel ──────────────────────────────────────────────────────────────

export class Channel {

  readonly name:        string
  readonly connections: Set<Connection>

  constructor(name: string) {
    this.name        = name
    this.connections = new Set()
  }

  join(connection: Connection, opts?: { meta?: Record<string, unknown> }): this {
    this.connections.add(connection)
    // Store join opts on connection for presence manager to read
    if (opts?.meta) (connection as Record<string, unknown>).__joinMeta = opts.meta
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
  // Using a template string instead of JSON.stringify({ type, event, data })
  // avoids allocating an intermediate wrapper object on every broadcast.
  send(event: string, data: unknown): void {
    const msg = `{"type":"event","event":${JSON.stringify(event)},"data":${JSON.stringify(data)}}`
    for (const conn of this.connections) {
      if (conn.socket.readyState === 1) {
        try { conn.socket.send(msg) } catch {}
      }
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

  // ── Presence — per-channel member map ─────────────────────────────────
  // Outer key: channelId. Inner key: connectionId.
  // Only authenticated connections are tracked (conn.user != null).
  const presence = new Map<string, Map<string, PresenceMember>>()

  function presenceFor(channelId: string): Map<string, PresenceMember> {
    let map = presence.get(channelId)
    if (!map) { map = new Map(); presence.set(channelId, map) }
    return map
  }

  function presenceMembers(channelId: string): PresenceMember[] {
    return Array.from(presenceFor(channelId).values())
  }

  function broadcastToChannel(channelId: string, excludeConnId: string | null, event: string, data: unknown): void {
    const ch = channels.get(channelId)
    if (!ch) return
    const msg = JSON.stringify({ type: 'event', event, data })
    for (const conn of ch.connections) {
      if (conn.id === excludeConnId) continue
      if (conn.socket.readyState === 1) {
        try { conn.socket.send(msg) } catch {}
      }
    }
  }

  function sendToConn(conn: Connection, event: string, data: unknown): void {
    if (conn.socket.readyState === 1) {
      try { conn.socket.send(JSON.stringify({ type: 'event', event, data })) } catch {}
    }
  }

  function presenceJoin(conn: Connection, channelId: string): void {
    const session = conn.user
    if (!session?.userId) return   // anonymous — not tracked

    const meta = (conn as Record<string, unknown>).__joinMeta as Record<string, unknown> ?? {}
    const member: PresenceMember = {
      connectionId: conn.id,
      userId:       session.userId,
      channelId,
      joinedAt:     new Date(),
      meta,
    }

    presenceFor(channelId).set(conn.id, member)

    // Send presence:sync to the new member — full list including themselves
    sendToConn(conn, 'presence:sync', {
      channelId,
      members: presenceMembers(channelId),
    })

    // Broadcast presence:join to all other members
    broadcastToChannel(channelId, conn.id, 'presence:join', { channelId, member })
  }

  function presenceLeave(conn: Connection, channelId: string): void {
    const map    = presence.get(channelId)
    const member = map?.get(conn.id)
    if (!member) return

    map!.delete(conn.id)
    if (map!.size === 0) presence.delete(channelId)

    // Broadcast presence:leave to remaining members
    broadcastToChannel(channelId, null, 'presence:leave', { channelId, member })
  }

  const onConnectHandlers:    Array<(session: unknown, conn: Connection) => void | Promise<void>> = []
  const onDisconnectHandlers: Array<(conn: Connection) => void | Promise<void>> = []

  const gcTimer = setInterval(() => {
    for (const channel of channels.values()) channel.gc()
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
      if (!(ch as Record<string, unknown>).__presenceWrapped) {
        (ch as Record<string, unknown>).__presenceWrapped = true

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
      session: unknown,
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
      socket.send(JSON.stringify({ type: 'connection', id: conn.id }))

      for (const handler of onConnectHandlers) {
        try { await handler(session, conn) } catch {}
      }

      return conn
    },

    // Called by _wsClose
    async handleDisconnect(connId: string): Promise<void> {
      const conn = connections.get(connId)
      if (!conn) return

      connections.delete(connId)
      // channel.leave is wrapped — triggers presenceLeave per channel automatically
      for (const channel of channels.values()) channel.leave(conn)
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
      // Mirror HTTP bridge: unwrap single-record envelopes, keep list envelopes whole
      const raw = data as Record<string, unknown> | null
      const payload = raw?.object === 'list' ? raw : (raw?.data ?? raw)
      for (const ch of targets) ch.send(event, payload)

      // ── Telemetry ──────────────────────────────────────────────
      const telemetry = (ctx.app as Record<string, unknown>)?.telemetry as
        { emit: (e: string, d: unknown) => void } | undefined
      if (telemetry) {
        const recipientCount = targets.reduce((n, ch) => n + ch.length, 0)
        const payloadStr = JSON.stringify(payload) ?? ''
        telemetry.emit('junction.channel.publish', {
          channel:        targets.map(ch => (ch as Record<string, unknown>).name ?? '?').join(','),
          event,
          recipientCount,
          payloadSize:    payloadStr.length,
        })
      }
    },

    on(
      event:   'connection' | 'disconnect',
      handler: (ctx: unknown, conn: Connection) => void | Promise<void>
    ): void {
      if (event === 'connection')  onConnectHandlers.push(handler)
      if (event === 'disconnect') onDisconnectHandlers.push(handler as (conn: Connection) => void)
    },

    // ── Presence queries — server-side ──────────────────────────────────
    presence(channelId: string): PresenceMember[] {
      return presenceMembers(channelId)
    },

    presenceOf(userId: string | number): Array<Omit<PresenceMember, 'channelId'> & { channelId: string }> {
      const results: PresenceMember[] = []
      for (const [, memberMap] of presence) {
        for (const member of memberMap.values()) {
          if (member.userId === userId) results.push(member)
        }
      }
      return results
    },

    // ── Internal — used by the subscribe message handler in the plugin ────
    // Not part of the public API — prefixed with _ to signal intent.
    _presenceGet(channelId: string, connId: string): PresenceMember | undefined {
      return presence.get(channelId)?.get(connId)
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
//   2. Stamps ctx.params.__channels on every service call so the
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

      async function ensureDeps() {
        if (!_bridge)   _bridge   = await import('./bridge.ts')
        if (!_callSvc)  _callSvc  = await import('../core/service.ts')
        if (!_errUtils) _errUtils = await import('../core/errors.ts')
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
            const { id: callId, service: serviceName, method, data, params: extraParams } = parsed

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
              const { query: _q, ...restExtra } = extra

              const svcCtx = _bridge2.internal(
                serviceName as string,
                method as 'create',
                (data as Record<string, unknown> | null) ?? null,
                {
                  query:   wsQuery,
                  user:    (conn?.user ?? null) as import('../auth/types.ts').SessionContext | null,
                  headers: ctx.headers,
                  ip:      ctx.ip,
                  ...restExtra,
                  __channels: manager,
                },
                app
              )
              svcCtx.method    = method as string
              svcCtx.transport = 'websocket'

              const paramId = extra?.id ?? (data as Record<string, unknown>)?.id
              if (paramId) svcCtx.id = paramId as string

              try {
                await _call(svc, svcCtx, app._appHooks, app.events, app.telemetry)
                // Mirror the HTTP bridge: lists stay as the full envelope,
                // single records are unwrapped to just the data value.
                const raw = svcCtx.result as Record<string, unknown> | null
                const wsResult = raw?.object === 'list' ? raw : (raw?.data ?? raw)
                ctx.send({ type: 'service_result', id: callId, result: wsResult })
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
            ctx.params.__channels = manager
            await next()
          }]
        }
      })

      // ── WS stats route ───────────────────────────────────────────
      const apiPrefix = (app.config as import('../config/index.ts').AppConfig).apiPrefix ?? ''
      app.get(`${apiPrefix}/channels/stats`, (ctx) => {
        if (!ctx.user) return ctx.json({ error: 'Unauthorized' }, 401)
        return ctx.json(manager.stats())
      })

      // ── Run user setup ───────────────────────────────────────────
      if (setup) {
        setup(app as App & { channels: ReturnType<typeof createChannelManager> })
      }
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
//         app.channel(`workspace:${ctx.params.workspace_id}`)
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

export function publish<T = unknown>(
  fn:     PublishFn<T>,
  event?: string
): import('../core/hooks.ts').Hook {

  return async (ctx: ServiceContext): Promise<void> => {

    const manager = ctx.params.__channels as
      ReturnType<typeof createChannelManager> | undefined

    // Channels plugin not loaded — silent no-op
    if (!manager) return

    // ctx.dispatch === false → caller explicitly suppressed broadcast
    if (ctx.dispatch === false) return

    const eventName = event ?? `${ctx.service} ${ctx.method}`

    // Use ctx.dispatch if explicitly set, otherwise fall back to ctx.result
    const payload = ctx.dispatch !== undefined
      ? ctx.dispatch as T
      : ctx.result as T

    await manager.publish(eventName, payload, ctx, fn)
  }
}
