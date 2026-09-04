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
import { resolveAccessor, toDataPrincipal, readGateLevel, sessionGateLevel } from '../core/litestone.ts'
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

  // Presence-update accounting for this connection (`FJS-704`). Token bucket,
  // same shape and same reason as the socket's frame bucket: a per-window
  // counter lets twice the allowance through across a boundary.
  __presenceRate?: { tokens: number; refilled: number }
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

// ─── Grading a broadcast ──────────────────────────────────────────────────
//
// `FJS-631`. A channel is a named set of connections and joining one was an
// ungraded GRANT: every row published there reached every member, whatever the
// schema said about who may read it.
//
// **Cohorts, not connections.** Phoenix names the cost of the naive version out
// loud — intercepting a broadcast means "the broadcast will be encoded N times
// instead of a single shared encoding across all subscribers" — and measured
// here the encoding (288 ns) is dearer than the verdict (684 ns) precisely
// because it is the term that multiplies. Hasura's answer is a cohort: group
// subscribers by their authorization context and do the work once per group.
// Two tabs of one person, and every member of staff whose policy is row-free,
// collapse into one verdict and one frame.
//
// **The principal is the cohort key** and it is an object identity rather than
// a serialization: `Connection.user` is the session built once at upgrade, so
// two connections of one person share it, and two DIFFERENT people can never
// collide the way a hashed key can. A connection with no session is its own
// cohort, keyed by a sentinel, because every anonymous connection grades
// identically and there is exactly one right answer for all of them.
//
// **A model that can only ever say yes is skipped entirely.** `$readGrading`
// answers `open` for a model whose read gate is 0 and which declares no read
// policy and no field policy — a catalogue, which is also the busiest channel
// an app has. Asked of the SCHEMA rather than declared by the app, so a policy
// added later turns its channel from open to graded with nothing to remember.
//
// **Undecidable is refused.** No model resolved, no client on the context, a
// payload that is not a row: the fan-out falls back to ungraded delivery ONLY
// where grading was never applicable, and refuses the recipient wherever it was
// applicable and could not be answered. Those are different, and conflating
// them is how a fail-closed check becomes fail-open at the first odd shape.
const ANON = Symbol('anonymous')

interface Cohort { conns: Connection[]; frame: string }

/** One principal, one claim set, and every connection that shares both. */
interface ClaimGroup { claims: Record<string, unknown> | null; conns: Connection[] }

/**
 * What a recipient holds IN THIS CHANNEL — the one fact grading cannot derive.
 *
 * A claim is resolved per REQUEST (junction's `principal:` resolver, off a
 * header), and a broadcast has no request: the principal on a connection was
 * built at the upgrade, where there is no workspace, no tenant and no header to
 * read one from. Under `strategy row` the tenancy rule desugars into an
 * `@@deny`, and an `@@deny` fires on UNKNOWN as well as on TRUE — so a claim
 * that is merely ABSENT refuses every subscriber on every tenanted model, which
 * is an application's entire live layer, silently (`FJS-749`).
 *
 * The app answers because the app named the channel: `workspace:<id>` encodes a
 * tenant and nothing here can know that. What it returns is a CLAIM, in the
 * `membershipClaim` sense — a statement the app has already verified, not a
 * request to trust the channel. Where a channel's membership is itself the
 * proof (basecamp joins a connection to `workspace:<id>` only after reading the
 * `WorkspaceMember` row), returning the id is exactly that statement.
 *
 * An empty object is not a claim and is treated as none, or a resolver that
 * answers `{}` for an anonymous connection turns a `null` principal into an
 * object and grades it a rung ABOVE a stranger.
 */
export type ChannelClaimsFn = (
  channelName: string,
  conn:        Connection,
) => Record<string, unknown> | null | undefined

/** What the rule is asked of, and what it is asked about. */
export interface GradingSource {
  /** The client the rule lives on. Any flavor answers identically. */
  db:       unknown
  /** The Litestone accessor for the model the payload is a row of. */
  accessor: string
  /** For the refuse-all warning. The service name, where there is one. */
  label?:   string
}

// A channel that grades to nobody is either a correct refusal or a wiring
// mistake, and the two look identical from the send side. Warned once per
// label so a misresolved accessor is visible without a line per broadcast.
const _refusedAll = new Set<string>()

/**
 * Why a whole channel was refused, where the answer is knowable.
 *
 * Under `strategy row` the tenancy rule desugars into an `@@deny` over a claim,
 * and a claim is per REQUEST — a connection's principal was built at the
 * upgrade and carries none, so the deny fires on UNKNOWN and refuses everybody
 * on every tenanted model. That is one sentence away from *the model is
 * genuinely private*, and telling the two apart took a signed heartbeat, a real
 * socket and an instrumented `$readAs` (`FJS-749`). Probed with `in` because a
 * Litestone client THROWS on an unknown property.
 */
function tenancyHint(db: unknown, claimsFor?: ChannelClaimsFn): string {
  if (claimsFor) return ''
  if (!db || typeof db !== 'object' || !('$tenancy' in db)) return ''
  const t = (db as { $tenancy?: { strategy?: string; claim?: string } }).$tenancy
  if (t?.strategy !== 'row') return ''
  return ` This schema is \`strategy row\` and no channels({ claims }) resolver is installed, so ` +
         `no recipient carries \`${t.claim ?? 'the tenant claim'}\` and the tenancy deny refuses all of them.`
}

// A resolver is application code on the fan-out path, so a throw in one would
// otherwise take down the announcement for every recipient of every channel.
// Refused rather than widened, the same answer `$readAs` throwing gets — and
// said out loud, because refusing in silence is the defect this whole seam
// exists to close.
const _claimsThrew = new Set<string>()

function resolveClaims(
  claimsFor:   ChannelClaimsFn,
  channelName: string,
  conn:        Connection,
): Record<string, unknown> | null {
  let answer
  try { answer = claimsFor(channelName, conn) }
  catch (err) {
    if (!_claimsThrew.has(channelName)) {
      _claimsThrew.add(channelName)
      console.warn(
        `[Junction] the channels({ claims }) resolver threw for '${channelName}', so its ` +
        `recipients are graded carrying no claim at all: ${(err as Error)?.message ?? err}`
      )
    }
    return null
  }
  return answer && typeof answer === 'object' && Object.keys(answer).length > 0 ? answer : null
}

function warnRefusedAll(label: string, accessor: string, size: number, hint = ''): void {
  if (_refusedAll.has(label)) return
  _refusedAll.add(label)
  console.warn(
    `[Junction] every one of ${size} subscribers was refused a '${label}' broadcast graded as ` +
    `'${accessor}'. That is correct where the model is genuinely private, and is what a ` +
    `misresolved accessor also looks like — check that '${accessor}' is the model this service ` +
    `writes, declaring model: on the service if it is not.` + hint
  )
}

/**
 * Who, of everyone subscribed, may see this — in cohorts.
 *
 * `null` means grading was never APPLICABLE (no Data boundary, no model, a
 * model that can only say yes) and the caller sends ungraded; an empty array
 * means it was applicable and refused everybody. Conflating the two is how a
 * fail-closed check becomes fail-open at the first odd shape.
 *
 * `mode` is stated by the caller because the payload cannot say it: a
 * count-only `changed` announcement is an object like a row is, and handing one
 * to `$readAs` refuses everybody for a reason that has nothing to do with who
 * may read. A row is graded by the whole rule; a count by the gate alone.
 */
export async function gradeRecipients(
  targets: Channel[],
  event:   string,
  payload: unknown,
  src:     GradingSource,
  mode:    'row' | 'gate' = 'row',
  claimsFor?: ChannelClaimsFn,
): Promise<Cohort[] | null> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const db = src.db as { $readAs?: Function; $readGrading?: Function } | undefined
  // No Data boundary here — an app broadcasting from a raw route, or a test
  // harness. Nothing to grade against, so nothing is claimed.
  //
  // Probed with `in` rather than with `typeof db.$readAs`: a Litestone client
  // THROWS on an unknown property, so the probe is itself a throwing expression
  // (`FJS-673` is the same trap one seam over).
  if (!db || typeof db !== 'object') return null
  if (!('$readAs' in db) || !('$readGrading' in db)) return null
  if (typeof db.$readAs !== 'function' || typeof db.$readGrading !== 'function') return null

  const accessor = resolveAccessor(db, src.accessor)
  if (mode === 'row' && db.$readGrading(accessor) === 'open') return null

  const readLevel = mode === 'gate' ? readGateLevel(db, accessor) : null
  if (mode === 'gate' && (readLevel == null || readLevel <= 0)) return null

  // One entry per distinct principal across every target channel. A connection
  // in two of them is graded once and sent once — Feathers' documented hazard
  // is the opposite ("it will get the data from the FIRST channel that it is
  // in"), and a set keyed by connection is what removes the ordering question
  // rather than answering it.
  // Two levels, because a claim is per CHANNEL and a principal is not: one
  // person in two workspaces is one principal on one socket and holds a
  // different tenant in each. Without a resolver the inner map has exactly one
  // entry and this is the flat map it used to be.
  const byPrincipal = new Map<unknown, Map<string, ClaimGroup>>()
  const seen = new Set<Connection>()
  let live = 0
  for (const ch of targets) {
    for (const conn of ch.connections) {
      if (conn.socket.readyState !== 1 || seen.has(conn)) continue
      seen.add(conn)
      live++
      const key    = conn.user ?? ANON
      const claims = claimsFor ? resolveClaims(claimsFor, ch.name, conn) : null
      const sig    = claims ? JSON.stringify(claims) : ''
      let byClaims = byPrincipal.get(key)
      if (!byClaims) byPrincipal.set(key, byClaims = new Map())
      const entry = byClaims.get(sig)
      if (entry) entry.conns.push(conn)
      else byClaims.set(sig, { claims, conns: [conn] })
    }
  }

  const out: Cohort[] = []
  for (const [key, byClaims] of byPrincipal) for (const { claims, conns } of byClaims.values()) {
    if (mode === 'gate') {
      // The gate alone. Nothing here is a row, so there is no policy to ask and
      // no field to shape — the question is whether this caller may read the
      // model at all.
      if (sessionGateLevel(key === ANON ? null : (key as never)) < (readLevel as number)) continue
      out.push({ conns, frame: encodeEventFrame(event, payload) })
      continue
    }
    let visible: unknown
    // `toDataPrincipal` for the reason the Bridge index gives it: a
    // `SessionContext` puts the id at `userId` and litestone's `auth()` reads
    // `.id`, so handing the session straight over compares every row policy
    // against `undefined`. It does not merely refuse — measured on `example`,
    // `userId == auth().id` was FALSE for the buyer's own order and TRUE for a
    // guest order whose `userId` is null, so the fix delivered the one row the
    // recipient may not read and withheld the one they own. The two functions
    // are one boundary: change either and ask whether the other needs it.
    // Claims are merged OVER the principal: the resolver is answering about this
    // channel, and the principal was built where the channel was not known.
    const base = key === ANON ? null : toDataPrincipal(key)
    const who  = claims ? { ...(base as object ?? {}), ...claims } : base
    try { visible = await db.$readAs(accessor, payload, who) }
    catch { continue }                      // undecidable: refuse, never widen
    if (!visible) continue                  // the gate or a policy said no
    out.push({ conns, frame: encodeEventFrame(event, visible) })
  }

  if (live > 0 && out.length === 0 && src.label)
    warnRefusedAll(src.label, accessor, live, tenancyHint(db, claimsFor))
  return out
}

// ─── Channel manager ──────────────────────────────────────────────────────

/** What the manager needs to know about presence. Resolved by `channels()`. */
export interface PresencePolicy {
  /** Is presence tracked for this channel at all? */
  enabled: (channelId: string) => boolean
  /** How long join/leave events are batched before one diff goes out. */
  flushMs: number
}

export function createChannelManager(presencePolicy?: PresencePolicy, claimsFor?: ChannelClaimsFn) {

  const _presencePolicy: PresencePolicy = presencePolicy ?? { enabled: () => false, flushMs: 50 }

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
    flushMs:    _presencePolicy.flushMs,
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

    // Graded send for a write that went through NO service call — the
    // litestone tap (`announceDataWrites`). The publish() path grades off a
    // ServiceContext and there is none here, so the two facts grading needs are
    // handed over instead: the client the rule lives on and the model the
    // payload is a row of. Without it every write outside its own service — a
    // job, a webhook, a cron, a bulk write — put whole rows on every subscribed
    // socket, whatever the schema said (`FJS-672`). Measured: 100 anonymous
    // sockets, `asSystem().create` on a policied model, 100 of 100 received it.
    async sendGraded(
      channelId: string,
      event:     string,
      payload:   unknown,
      src:       GradingSource,
      mode:      'row' | 'gate' = 'row',
    ): Promise<void> {
      const ch = channels.get(channelId)
      if (!ch) return
      const graded = await gradeRecipients([ch], event, payload, src, mode, claimsFor)
      if (!graded) { ch.send(event, payload); return }
      for (const { conns, frame } of graded)
        for (const conn of conns)
          if (conn.socket.readyState === 1) wsSend(conn.socket, frame)
    },

    channel(name: string): Channel {
      const ch = getOrCreate(name)

      // Wrap join/leave exactly once to automatically update presence.
      // __presenceWrapped guards against re-wrapping on repeated channel() calls.
      //
      // Only where presence is DECLARED for this channel. It used to wrap every
      // channel there is, so every application paid for a feature most of them
      // do not use — and paid quadratically: 500 signed-in connections over two
      // channels produced 251 500 frames, 89.5MB of egress and 172MB of heap,
      // which makes an ordinary post-deploy reconnect fatal (`FJS-703`).
      if (!ch.__presenceWrapped && _presencePolicy.enabled(name)) {
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

      // ── Who may see this row ────────────────────────────────────────────
      //
      // `@@allow` compiles into a SELECT's WHERE, and a broadcast is not a
      // SELECT — so a row that reaches a caller through a query is filtered by
      // construction and one that reaches them through a frame was filtered by
      // nothing. Measured on `example`: a socket opened with no token received
      // a whole `Order` row while the same caller was answered 401 on
      // `GET /api/orders` (`FJS-631`).
      //
      // The rule is NOT re-implemented here. `$readAs` answers it at the Data
      // boundary, where the gate, the row policies and the field policies are
      // declared; a second reading of any of them is a second answer to who may
      // read. This owns the fan-out and the cohorts, and nothing else.
      //
      // The accessor is the service's DECLARED model first and its name only as
      // a fallback: grading resolved from the name alone refused everybody, in
      // silence, for every service whose name maps to no model — `orders2` over
      // `Order`, a modelless service, any Invariant-19 irregular (`FJS-700`).
      const svc = ctx.app?.services?.get?.(ctx.service ?? '') as { model?: string } | undefined
      const graded = await gradeRecipients(targets, event, payload, {
        db:       (ctx as { locals?: { db?: unknown } }).locals?.db,
        accessor: svc?.model ?? (ctx as { service?: string }).service ?? '',
        label:    (ctx as { service?: string }).service,
      }, 'row', claimsFor)
      if (graded) {
        for (const { conns, frame } of graded)
          for (const conn of conns)
            if (conn.socket.readyState === 1) wsSend(conn.socket, frame)
      } else {
        // Serialize ONCE for all target channels — multi-channel publishes
        // previously re-stringified the payload per channel, and telemetry
        // stringified it a second time just to measure its size.
        const frame = encodeEventFrame(event, payload)
        for (const ch of targets) ch.sendRaw(frame)
      }

      // ── Telemetry ──────────────────────────────────────────────
      const telemetry = ctx.app?.telemetry
      if (telemetry && (typeof telemetry.hasListeners !== 'function' || telemetry.hasListeners())) {
        // The count is who was SENT to, not who was in the channel — a graded
        // publish is the one thing here whose two numbers differ, and the gap
        // between them is the whole point of it.
        const inChannel = targets.reduce((n, ch) => n + ch.length, 0)
        const recipientCount = graded
          ? graded.reduce((n, g) => n + g.conns.length, 0)
          : inChannel
        telemetry.emit('junction.channel.publish', {
          channel:        targets.map(ch => ch.name ?? '?').join(','),
          event,
          recipientCount,
          refusedCount:   inChannel - recipientCount,
          graded:         !!graded,
          payloadSize:    graded ? (graded[0]?.frame.length ?? 0) : encodeEventFrame(event, payload).length,
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
//   A token that is present and does not verify closes the socket with 4001
//   ('auth_failed') before any channel is joined — the client does not reconnect.
//   No token → joins only the 'anonymous' channel.

export type ChannelSetupFn = (app: App & { channels: ReturnType<typeof createChannelManager> }) => void

export interface ChannelsOptions {
  /** How often the server pings an otherwise silent connection. Default 15s. */
  heartbeatInterval?: number
  /** How long a connection may say nothing before it is evicted. Default 40s. */
  heartbeatTimeout?:  number

  /**
   * The largest presence meta one connection may publish, in bytes of JSON.
   * Default 4096.
   *
   * Whatever a client sent was stored and fanned out to every member with no
   * cap and no shape, so **one connection was a 200x amplifier into any
   * channel it belongs to**: a single 200KB frame produced 39.8MB of egress to
   * 199 members in 114ms, and the factor is the channel's membership, so it
   * grows with the application's success (`FJS-704`). It needs no privilege
   * beyond being in the channel, which for a public channel is nobody's.
   */
  presenceMetaBytes?: number

  /**
   * What a recipient holds in a given channel, merged onto their principal
   * before a broadcast is graded. See `ChannelClaimsFn` — under `strategy row`
   * an app without one delivers nothing on any tenanted model.
   */
  claims?: ChannelClaimsFn

  /**
   * Presence updates one connection may publish per second. Default 5.
   *
   * The size cap bounds one frame and this bounds the stream: 4KB at a
   * thousand a second is the same amplifier with more steps.
   */
  presenceUpdatesPerSecond?: number

  /**
   * What a presence meta is allowed to BE. Given whatever the client sent, it
   * answers the value to store, or throws to refuse.
   *
   * The size and rate bounds are the floor under any app; this is how an app
   * says the thing neither of them can know — that meta is `{ typing: boolean }`
   * and nothing else. Absent, any JSON inside the cap is accepted, which is the
   * behavior that shipped and is a reasonable default for a field whose whole
   * purpose is application-defined.
   */
  presenceMeta?: (meta: Record<string, unknown>) => Record<string, unknown>

  /**
   * Which channels track presence. **Default `false` — none of them.**
   *
   * It used to be every channel there is, unconditionally and with no way off,
   * so every application paid for a feature most do not use — and paid
   * quadratically, since a join sends the roster to the joiner AND a frame to
   * every existing member. Measured at two channels per connection: 200
   * connections produced 40 600 frames and 14.3MB, and 500 produced **251 500
   * frames, 89.5MB out and 172MB of heap**. A post-deploy reconnect of a few
   * thousand users is the ordinary event that makes fatal (`FJS-703`).
   *
   * `true` is every channel, an array is exact names and `prefix:*` patterns.
   * A list is the shape to reach for: presence is usually wanted on the one
   * channel a document or a room is, and never on the ten a data-sync app
   * announces model writes over.
   */
  presence?: boolean | string[]

  /**
   * How long join and leave events are batched before one `presence:diff`
   * frame goes to the channel. Default 50ms; 0 restores a frame per event.
   *
   * This is the half that changes the exponent. Turning presence off fixes the
   * apps that do not use it; an app that DOES use it still had N joins costing
   * N x (N-1) frames, and batching makes a storm cost one frame per member per
   * window instead.
   */
  presenceFlushMs?: number
}

export function channels(setup?: ChannelSetupFn, opts: ChannelsOptions = {}): Plugin {
  let _manager:        ReturnType<typeof createChannelManager> | null = null
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

  return {
    name: 'channels',

    register(app: App): void {
      // Create and attach the channel manager
      // Resolved once, here, rather than read per channel: `channel()` runs on
      // every publish and a pattern match per call is a cost with no reason.
      const declared = opts.presence ?? false
      const enabled =
        declared === false ? () => false
        : declared === true ? () => true
        : (() => {
            const exact    = new Set(declared.filter(p => !p.endsWith('*')))
            const prefixes = declared.filter(p => p.endsWith('*')).map(p => p.slice(0, -1))
            return (name: string) => exact.has(name) || prefixes.some(p => name.startsWith(p))
          })()

      const manager = createChannelManager({ enabled, flushMs: opts.presenceFlushMs ?? 50 }, opts.claims)
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
      let _enterRequest: typeof import('../core/context.ts').enterRequest | null = null

      async function ensureDeps() {
        if (!_bridge)   _bridge   = await import('./bridge.ts')
        if (!_callSvc)  _callSvc  = await import('../core/service.ts')
        if (!_errUtils) _errUtils = await import('../core/errors.ts')
        if (!_enterRequest) _enterRequest = (await import('../core/context.ts')).enterRequest
      }

      // Pre-warm on next tick so the first WS message isn't slow
      Promise.resolve().then(ensureDeps).catch(() => {})

      // ── WS handler ──────────────────────────────────────────────
      // Now uses WsContext — no raw Bun WS types leak into this layer.
      // Auth is already resolved by http.ts _wsOpen before open() is called.
      // socketToConnId maps the raw $ws object → connId for lifecycle tracking.
      const socketToConnId = new WeakMap<object, { connId: string; connectedAt: number }>()
      const lastSeen        = new Map<string, number>()   // connId → last frame epoch ms

      // ── Liveness ──────────────────────────────────────────────────────
      // A connection is evicted once nothing has arrived from it in
      // heartbeatTimeout — the only way to notice a silent drop (TCP reset,
      // machine sleep, browser crash) that fires no close event.
      //
      // **The server drives it.** A client-side timer cannot: browsers
      // throttle timers to ~1/min in a hidden tab, so a backgrounded tab
      // would age out and reconnect on focus forever. An arriving ping runs
      // the client's message handler, which is not throttled, so the pong
      // goes out on time.
      //
      // **Any frame counts**, not just a pong — a client in the middle of a
      // service call is plainly alive. Grading liveness on pings alone
      // evicted every connection whose client did not run a heartbeat, which
      // was all of them: nothing in the framework called startHeartbeat().
      const heartbeatInterval = opts.heartbeatInterval ?? 15_000
      const heartbeatTimeout  = opts.heartbeatTimeout  ?? 40_000
      _heartbeatTimer = setInterval(() => {
        const staleAt = Date.now() - heartbeatTimeout
        for (const [connId, last] of lastSeen) {
          if (last < staleAt) {
            lastSeen.delete(connId)
            manager.handleDisconnect(connId).catch(() => {})
            continue
          }
          const conn = manager.connections.get(connId)
          if (conn && conn.socket.readyState === 1) {
            wsSend(conn.socket, JSON.stringify({ type: 'ping' }))
          }
        }
      }, heartbeatInterval)
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
          lastSeen.set(conn.id, Date.now())

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

          // Anything arriving on this socket is proof of life, malformed
          // frames included — the parse below can refuse a frame the sender
          // was plainly alive to send.
          lastSeen.set(connId, Date.now())

          const parsed = manager.handleMessage(connId, msg)
          if (!parsed) return

          // ── Ping/pong keepalive ──────────────────────────────────
          // Either side may ping; the other answers. lastSeen is already
          // stamped above, so neither branch has anything else to do.
          if (parsed.type === 'ping') {
            ctx.send({ type: 'pong' })
            return
          }
          if (parsed.type === 'pong') return

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
                query: _q, workspaceId: _ws, headers: _hdrs,
                correlationId: _cid, idempotencyKey: _idk,
                ...restExtra
              } = extra

              const svcCtx = _bridge2.internal(
                // The CANONICAL name — a frame naming an older spelling of it
                // resolves, and then announces and resolves its model under the
                // one name the service has (`FJS-570`).
                svc.name,
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
              // therefore cannot arrive that way: a workspace changes when a
              // person switches workspace, a guest basket's token comes into
              // existence after the socket is already up. The browser client
              // sends those on the frame (`meta.headers`) and they are merged
              // in here, so a hook reading ctx.client.headers sees the same
              // value it would have seen over HTTP.
              //
              // An ALLOW-LIST, not a merge. A frame that could name its own
              // header could name Authorization and override the identity
              // established at upgrade, so a name reaches the context only if
              // the app declared it in `http.callHeaders` — or if it is one of
              // junction's own, which the client sends unasked.
              svcCtx.client.headers = _mergeCallHeaders(
                ctx.headers,
                extra.headers as Record<string, unknown> | undefined,
                extra.workspaceId,
                app,
              )
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

              // Request metadata is an AsyncLocalStorage store, and this path
              // wrapped nothing for its whole life — so requestMeta() was
              // undefined for every socket call and anything reading it (a
              // correlation id in a log, the Idempotency-Key that decides
              // whether a create runs twice) silently applied to half the
              // transports. enterRequest() is the one owner now; a socket has
              // no per-call headers, so the frame carries the two values it
              // needs under `meta`, the same place it carries the id and the
              // workspace, and they are stated rather than derived.
              try {
                await _enterRequest!({
                  origin:         'websocket',
                  correlationId:  extra.correlationId as string | undefined,
                  idempotencyKey: extra.idempotencyKey as string | undefined,
                  // Same as the HTTP path — the principal is request-wide, and
                  // it is what an internal call inherits when it names none.
                  user:           svcCtx.auth.user,
                  client:         svcCtx.client,
                }, () =>
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

            // Update meta if provided.
            //
            // Three bounds, and the order is the cheap test first: the rate
            // needs no serialization, the size needs one, and the app's own
            // rule runs last and only on something already known to be small
            // enough to be worth judging.
            if (parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) {
              const rate = opts.presenceUpdatesPerSecond ?? 5
              if (rate > 0) {
                const now = Date.now()
                const b = conn.__presenceRate ??= { tokens: rate, refilled: now }
                b.tokens  = Math.min(rate * 2, b.tokens + ((now - b.refilled) / 1000) * rate)
                b.refilled = now
                // Dropped in silence rather than answered: an error frame per
                // refused update is the same egress the cap exists to stop, and
                // presence is an affordance — a `typing` indicator that misses
                // a beat is not a failure the caller has to hear about.
                if (b.tokens < 1) return
                b.tokens -= 1
              }

              const raw   = parsed.meta as Record<string, unknown>
              const bytes = Buffer.byteLength(JSON.stringify(raw) ?? '')
              const cap   = opts.presenceMetaBytes ?? 4096
              if (bytes > cap) {
                // This one IS answered: it is a fixed property of the client's
                // own code rather than a transient, so it will happen on every
                // send until somebody is told.
                manager._sendToConn(conn, 'error', {
                  code:    'presence_meta_too_large',
                  message: `Presence meta is ${bytes} bytes; this app accepts ${cap}`,
                })
                return
              }

              let meta = raw
              if (opts.presenceMeta) {
                try { meta = opts.presenceMeta(raw) } catch (err) {
                  manager._sendToConn(conn, 'error', {
                    code:    'presence_meta_refused',
                    message: (err as Error).message,
                  })
                  return
                }
              }

              member.meta = meta
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
          lastSeen.delete(entry.connId)
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

// ─── Per-call headers ─────────────────────────────────────────────────────

/** Junction's own protocol headers — the browser client sends these whether or
 *  not an app asked for them, so they are always mergeable. */
const PROTOCOL_CALL_HEADERS = ['x-workspace-id', 'idempotency-key']

/**
 * The upgrade request's headers, plus the ones this frame is allowed to state.
 *
 * The allow-list is `config.http.callHeaders`, the same declaration the CORS
 * middleware reads — one fact, two readers, because a header the app forgot in
 * one place is dropped by the other and the app half-works.
 *
 * `workspaceId` is still accepted as its own meta key: it predates the general
 * channel and an older client sends it that way. It resolves to the identical
 * header, so a client sending both cannot disagree with itself.
 */
function _mergeCallHeaders(
  upgrade:     Record<string, string>,
  frame:       Record<string, unknown> | undefined,
  workspaceId: unknown,
  app:         App,
): Record<string, string> {
  const declared = ((app.config?.http as Record<string, unknown> | undefined)
                     ?.callHeaders as string[] | undefined) ?? []
  const allowed  = new Set([...PROTOCOL_CALL_HEADERS, ...declared.map(h => h.toLowerCase())])

  let merged: Record<string, string> | null = null
  const put = (name: string, value: unknown) => {
    if (value == null) return
    if (!allowed.has(name)) return
    merged ??= { ...upgrade }
    merged[name] = String(value)
  }

  for (const [name, value] of Object.entries(frame ?? {})) put(name.toLowerCase(), value)
  put('x-workspace-id', workspaceId)

  // The upgrade's own map when the frame added nothing, so the common case
  // allocates nothing and a reader still sees one object per connection.
  return merged ?? upgrade
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
