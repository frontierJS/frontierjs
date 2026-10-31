// transport/channels.ts
// Real-time channels — Feathers model, Bun WebSocket underneath.
//
// A Channel is a named group of WebSocket connections.
// After every service mutation, the announce() hook sends the result
// to every connection in the target channels.
//
// ─── Minimal wiring ───────────────────────────────────────────────────────
//
//   import { channels, announce } from '@frontierjs/junction'
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
//   // 2. Announce service results to channels after mutations
//   service.hooks({
//     after: {
//       create: [announce((result, ctx) =>
//         ctx.user?.workspaceId
//           ? app.channel(`workspace:${ctx.user.workspaceId}`)
//           : null
//       )],
//     }
//   })
//
//   // 3. Client receives:
//   //   { type: 'event', event: 'deployments created', data: { id: '...', ... } }

import { DEV_ENV }            from '@frontierjs/toolbelt/devline'
import { createPresenceTracker } from './presence.ts'
import { AUTO_EVENT_MAP, REMOVAL_EVENTS, markAnnounceHook } from '../core/events.ts'
import { unwrapResult }         from '../core/envelope.ts'
import { resolveAccessor, toDataPrincipal, readGateLevel, principalGateLevel, declaredCallHeaders } from '../core/litestone.ts'
import { PROTOCOL_CALL_HEADERS, acceptedRequestId, callDb } from '../core/context.ts'
import { serviceAccessor }      from '../core/service.ts'
import { columnsUnmoved }       from '../core/write-narrowing.ts'
import { wsSend }               from './send-queue.ts'
import { firstUnsafeInteger, UnsafeIntegerError } from './body.ts'
import { logSocketCall }        from './middleware.ts'
import type { ServiceContext } from '../core/context.ts'
import type { App, Plugin }    from '../core/app.ts'
import { SESSION_SOCKET }       from './types.ts'
import type { WsContext }      from './types.ts'

// A committed write as the litestone tap hands it over: what a bound room needs
// to tell a write that moved a grade from one that did not.
type RoomWrite = { model: string; event?: string; scope?: string; before?: unknown; result?: unknown }

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

  // Every call this socket makes carries its signal as `ctx.signal`; it aborts
  // when the connection goes, however it went.
  __gone?: AbortController

  // The tab's latest `visibility` frame. Absent until one arrives, and absent
  // reads as hidden: a socket that never reports (a script, a server-side
  // client) must not silence a push (`FJS-D1627`).
  visible?: boolean
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

/**
 * Where a frame goes: a channel, or a channel's NAME. A name lets a service
 * definition — which holds no app — answer for a write with `ctx` null; a name
 * nobody has joined reaches nobody and is skipped.
 */
export type ChannelTarget = Channel | string

export type AnnounceFn<T = unknown> = (
  data: T,
  ctx:  ServiceContext
) => ChannelTarget | ChannelTarget[] | null | false

/**
 * A service's `channel:` function, or the app's `announceDefault`. Also called
 * for a write outside any service call -- a job, a webhook, `asSystem()` --
 * with `ctx` null, so the target is read off the row (`FJS-1741`).
 */
export type ChannelFn<T = unknown> = (
  data: T,
  ctx:  ServiceContext | null
) => ChannelTarget | ChannelTarget[] | null | false

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

  // A `visibility` frame: the tab's `document.visibilityState === 'visible'`.
  visible?: boolean
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
// broadcastToChannel, sendToConn, announce). One implementation → one wire
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
  // join/leave. `channel(name)` is called on every broadcast, so without the
  // guard the wrappers stack and one join counts N times.
  __presenceWrapped?: boolean

  // Set by the manager on a channel `channels({ rooms })` binds to a row: the
  // join that skips the grading, for the manager to call once it has graded.
  __admit?: (connection: Connection, opts?: { meta?: Record<string, unknown> }) => unknown

  constructor(name: string) {
    this.name        = name
    this.connections = new Set()
  }

  /**
   * On a channel bound to a row (`channels({ rooms })`) the join is graded at
   * the Data boundary first and answers a Promise of whether it was admitted;
   * every other channel joins at once and answers itself.
   */
  join(connection: Connection, opts?: { meta?: Record<string, unknown> }): this | Promise<boolean> {
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
// policy and no field policy — a catalog, which is also the busiest channel
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
 *
 * It may answer a Promise, and is asked on EVERY frame, once per principal per
 * channel, with nothing cached (`FJS-D472`). A claim that is a membership row
 * read once when the socket opened is a snapshot: a person removed from a
 * private team kept receiving its rows on the socket they already had while
 * the same row over HTTP answered 404 (`FJS-1316`). The request path reads its
 * claims per call, and this is that rule carried over to a broadcast.
 *
 * A channel that names no tenant is answered `null`, and its row is then graded
 * under each claim this resolver answers for the recipient on their OTHER
 * channels (`FJS-1772`) — so a package's fixed channel needs nothing here.
 */
export type ChannelClaimsFn = (
  channelName: string,
  conn:        Connection,
) => ChannelClaims | Promise<ChannelClaims>

type ChannelClaims = Record<string, unknown> | null | undefined

/** What the rule is asked of, and what it is asked about. */
export interface GradingSource {
  /** The client the rule lives on. Any flavor answers identically. */
  db:       unknown
  /** The Litestone accessor for the model the payload is a row of. */
  accessor: string
  /** For the refuse-all warning. The service name, where there is one. */
  label?:   string
  /**
   * An update's row as it stood BEFORE the write. A reader the new row refuses
   * is told `removed` only if they could read this one, because that is the
   * reader whose store holds the row (`FJS-1742`). Absent means unknown, and
   * unknown sends no removal: a refusal to someone who never held the row is an
   * id and a moment handed to a stranger.
   */
  before?:  object | null
  /** Send the removals the before-image owes and nothing else; the admitted frames go out elsewhere. */
  removalsOnly?: boolean
  /**
   * The tenants a count-only write touched. A count names no row and so no
   * tenant, and the gate alone admits a signed-in tab in every workspace; given
   * these, `gate` mode admits a recipient only at a level held under a claim
   * naming one of them (`FJS-D1038`). Read only under `strategy row` with a
   * claims resolver — otherwise the app is single-tenant on the wire.
   */
  tenants?: readonly unknown[] | null
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

async function resolveClaims(
  claimsFor:   ChannelClaimsFn,
  channelName: string,
  conn:        Connection,
): Promise<Record<string, unknown> | null> {
  let answer
  try { answer = await claimsFor(channelName, conn) }
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

/** The claim name the tenancy deny reads, under `strategy row` only. */
function rowTenancyClaim(db: unknown): string | null {
  if (!db || typeof db !== 'object' || !('$tenancy' in db)) return null
  const t = (db as { $tenancy?: { strategy?: string; claim?: string } }).$tenancy
  return t?.strategy === 'row' && t.claim ? t.claim : null
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
 * The cohort a principal belongs to.
 *
 * `FJS-D175` says two tabs of one person are one verdict and one frame, and the
 * key that expressed it was `conn.user` — an OBJECT. Nothing upstream shares
 * one: `_wsOpen` calls `verifySession` per socket and `@frontierjs/auth`
 * answers `{ ...toContext(user), sessionId }`, a fresh object each time. So no
 * two sockets ever collapsed, and the cohort was a per-connection loop wearing
 * the word cohort — measured, 100 sockets of ONE user asked the Data boundary
 * 100 times where one shared object asks once, which puts every real
 * application on `FJS-D175`'s 445.6 µs number rather than its 49.8 µs one.
 *
 * Keyed on the principal's VALUE instead, because that is what decides the
 * answer: `$readAs` grades the gate, the row policy and the field policies out
 * of the principal's own fields, and the app's own `getLevel` reads whatever
 * else it grades a standing by. Two principals that serialize identically cannot be graded
 * differently — which is the property a hash would only approximate, and is why
 * this is a full canonical string rather than a digest.
 *
 * Serialization is REFUSED rather than approximated where the value is not
 * plainly data: anything with a prototype of its own — a function, a symbol, a
 * Map, a class instance — plus a cycle or anything past a small depth, answers
 * null and the caller falls back to the object itself, which is the behavior
 * this replaces. Collapsing two principals that
 * are not the same is the one mistake here that delivers a row to somebody who
 * may not read it, so every uncertainty resolves the other way.
 */
function stableKey(v: unknown, depth = 0): string | null {
  if (depth > 6) return null
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string')  return JSON.stringify(v)
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'undefined') return 'undefined'
  if (t === 'bigint') return `${v}n`
  if (v instanceof Date) return `d:${v.getTime()}`
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const item of v) {
      const k = stableKey(item, depth + 1)
      if (k === null) return null
      parts.push(k)
    }
    return `[${parts.join(',')}]`
  }
  // The one refusal, and it covers everything that is not plainly data: a
  // function, a symbol, a Map, a class instance — each has a prototype of its
  // own, and each can carry behavior two structurally equal copies do not
  // share. Stated once here rather than as a list of types, because a list is
  // a thing to keep up to date and this is a property.
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return null
  const keys = Object.keys(v as object).sort()
  const parts: string[] = []
  for (const key of keys) {
    const k = stableKey((v as Record<string, unknown>)[key], depth + 1)
    if (k === null) return null
    parts.push(`${JSON.stringify(key)}:${k}`)
  }
  return `{${parts.join(',')}}`
}

// Memoized on the session OBJECT, which is the one thing identity is good for
// here: `verifySession` runs once per socket and the object it answers does not
// change while that socket is open, so the serialization is paid once per
// connection instead of once per connection per broadcast. Weak, so it is
// collected with the socket and holds nothing open.
const _cohortKeys = new WeakMap<object, unknown>()

function principalKey(user: unknown): unknown {
  if (user === null || user === undefined) return ANON
  if (typeof user !== 'object') return `p:${stableKey(user) ?? String(user)}`
  const memo = _cohortKeys.get(user)
  if (memo !== undefined) return memo
  const k   = stableKey(user)
  const key = k === null ? user : `p:${k}`
  _cohortKeys.set(user, key)
  return key
}

// The `removed` frame a refused reader of an update is owed, or null when the
// event is not an update or the row carries no key to name it by. The event
// keeps its service prefix (`orders updated` → `orders removed`).
const UPDATE_SUFFIX = new RegExp(`\\b(${AUTO_EVENT_MAP.update}|${AUTO_EVENT_MAP.patch})$`)
function removalFrameFor(db: object, accessor: string, event: string, payload: object): string | null {
  if (!UPDATE_SUFFIX.test(event)) return null
  let keys: string[] = ['id']
  if ('$primaryKey' in db && typeof (db as { $primaryKey?: unknown }).$primaryKey === 'function') {
    const pk = (db as { $primaryKey: (a: string) => string[] }).$primaryKey(accessor)
    if (Array.isArray(pk) && pk.length) keys = pk
  }
  const row = payload as Record<string, unknown>
  if (keys.some(k => row[k] == null)) return null
  const id = Object.fromEntries(keys.map(k => [k, row[k]]))
  return encodeEventFrame(event.replace(UPDATE_SUFFIX, AUTO_EVENT_MAP.remove), id)
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
  channelsOf?: (conn: Connection) => Iterable<string>,
): Promise<Cohort[] | null> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const db = src.db as { $readAs?: Function; $readGrading?: Function; $inWindow?: Function } | undefined
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

  // ── the window ────────────────────────────────────────────────────────────
  //
  // Asked BEFORE `$readGrading`, and that placement is the whole of it. A model
  // with a window and no gate grades `open` and takes the early return below,
  // which is exactly the shape a catalog is — so a window asked after it is a
  // window asked for nobody.
  //
  // It is a separate question from `$readAs` because it is a separate KIND of
  // question: `$readAs` answers *may this principal see this row*, per cohort;
  // the window answers *does this row still count*, once, for everybody. What
  // it closes is the frame emitted after an `@@expires` row fell out — a
  // write to an already-dead row, or a `withExpired` read that then wrote. It
  // does not close silent expiry, where no write happens at all and so no frame
  // is ever built; that needs a store that re-grades on a tick.
  //
  // **A removal is sent anyway.** Suppressing it strands the row in every store
  // that already holds it, with nothing that could ever correct it — worse than
  // never having graded. `gate` mode names no row, so there is nothing to ask.
  const removalsOnly = mode === 'row' && !!src.removalsOnly
  if (mode === 'row' && !removalsOnly && !REMOVAL_EVENTS.has(event) && '$inWindow' in db &&
      typeof db.$inWindow === 'function' && !db.$inWindow(accessor, payload)) return []

  if (mode === 'row' && db.$readGrading(accessor) === 'open') return removalsOnly ? [] : null

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
  // The principal is carried beside its key, because the key is now a string
  // and the grading needs the value: both modes build a Data-realm principal
  // out of it. Any member of a cohort will do — they serialized identically.
  // The resolver is asked once per (principal, channel), not per connection:
  // three tabs are one person, and a resolver that reads the database would
  // otherwise read it three times for one answer (`FJS-D472`).
  const byPrincipal = new Map<unknown, { user: unknown; byClaims: Map<string, ClaimGroup> }>()
  const byChannel   = new Map<unknown, Map<string, Connection[]>>()
  const seen = new Set<Connection>()
  let live = 0
  for (const ch of targets) {
    for (const conn of ch.connections) {
      if (conn.socket.readyState !== 1 || seen.has(conn)) continue
      seen.add(conn)
      live++
      // Two strangers are not one principal. A connection with no session is
      // its own cohort wherever a resolver answers claims, because what it
      // holds is on IT — a link's cookie, a widget's token on the upgrade —
      // and the claims asked of the first stranger were handed to every other:
      // one portal contact's message reached another contact's socket
      // (`FJS-2528`). Without a resolver every stranger grades identically.
      const key = conn.user == null && claimsFor ? conn : principalKey(conn.user)
      if (!byPrincipal.has(key)) byPrincipal.set(key, { user: conn.user ?? null, byClaims: new Map() })
      let chans = byChannel.get(key)
      if (!chans) byChannel.set(key, chans = new Map())
      const conns = chans.get(ch.name)
      if (conns) conns.push(conn)
      else chans.set(ch.name, [conn])
    }
  }
  const asked = [...byChannel].flatMap(([key, chans]) => [...chans].map(([name, conns]) => ({ key, name, conns })))
  const answers = claimsFor
    ? await Promise.all(asked.map(({ name, conns }) => resolveClaims(claimsFor, name, conns[0])))
    : null
  asked.forEach(({ key, conns }, i) => {
    const claims = answers ? answers[i] : null
    const sig    = claims ? JSON.stringify(claims) : ''
    const group  = byPrincipal.get(key)!
    const entry  = group.byClaims.get(sig)
    if (entry) entry.conns.push(...conns)
    else group.byClaims.set(sig, { claims, conns: [...conns] })
  })

  // ── a channel that names no tenant ────────────────────────────────────────
  //
  // A fixed channel — a package's `flows`, an app's `authenticated` — carries
  // rows of every tenant, so its resolver has no claim to answer, and under
  // `strategy row` a recipient graded with none is refused by the tenancy deny
  // whoever they are. Such a recipient is graded again under each claim the
  // SAME resolver verifies for them on the other channels they are in, and
  // admitted by the first that reads the row: the Data boundary decides which
  // tenant the row is, through a parent where it has no column of its own. The
  // row's own tenant is never copied onto the recipient — that claim nobody
  // verified would pass the deny for everybody.
  //
  // `gate` mode asks the same pass only for the tenants the write touched
  // (`wantedTenants`): a claim from any OTHER workspace would admit a count of
  // another's writes.
  const tenantClaim = mode === 'gate' && claimsFor && src.tenants?.length ? rowTenancyClaim(db) : null
  const wantedTenants = new Set((src.tenants ?? []).map(String))
  const elsewhere = new Map<unknown, Record<string, unknown>[]>()
  if ((mode === 'row' || tenantClaim) && claimsFor && channelsOf) {
    for (const [key, group] of byPrincipal) {
      const bare = group.byClaims.get('')
      if (!bare) continue
      const graded = new Set(byChannel.get(key)!.keys())
      const names  = new Map<string, Connection>()
      for (const conn of bare.conns) for (const name of channelsOf(conn))
        if (!graded.has(name) && !names.has(name)) names.set(name, conn)
      const held = await Promise.all([...names].map(([name, conn]) => resolveClaims(claimsFor, name, conn)))
      const bySig = new Map<string, Record<string, unknown>>()
      for (const c of held) if (c) bySig.set(JSON.stringify(c), c)
      if (bySig.size) elsewhere.set(key, [...bySig.values()])
    }
  }

  // An update that narrows who may read a row is refused to the reader it took
  // the row from, and a refusal alone strands the row in their tether —
  // share arrived live and revoke never did (`FJS-1425`). So a reader the new
  // row refuses is told `removed` with the id alone, if the row's before-image
  // admitted them. One who could read neither image is told nothing, and so is
  // everyone when no before-image was read (`FJS-1742`).
  const before  = mode === 'row' ? src.before ?? null : null
  const removal = before ? removalFrameFor(db, accessor, event, payload) : null
  const readAsOf = async (row: unknown, who: unknown, key: unknown, claims: unknown): Promise<unknown> => {
    let seen: unknown = await db.$readAs!(accessor, row, who)
    if (!seen && !claims) for (const held of elsewhere.get(key) ?? []) {
      try { seen = await db.$readAs!(accessor, row, { ...(who as object ?? {}), ...held }) }
      catch { seen = null }
      if (seen) break
    }
    return seen
  }
  let admitted = 0

  const out: Cohort[] = []
  for (const [key, group] of byPrincipal) for (const { claims, conns } of group.byClaims.values()) {
    // `toDataPrincipal` is the one translation between a session and the
    // Data boundary's principal; the grade here and the grade on the service
    // path must go through the same one.
    // Claims are merged OVER the principal: the resolver is answering about this
    // channel, and the principal was built where the channel was not known.
    const base = key === ANON ? null : toDataPrincipal(group.user as never)
    const who  = claims ? { ...(base as object ?? {}), ...claims } : base

    if (mode === 'gate') {
      // The gate alone. Nothing here is a row, so there is no policy to ask and
      // no field to shape — the question is whether this caller may read the
      // model at all. Graded by the APP's own mapping through the Data boundary
      // (`FJS-1161`), off the same principal the row path grades with: a
      // standing that is not a column on the session — a membership row, a
      // workspace role — is invisible to `sessionGateLevel` and is most of what
      // decides a level in a tenanted app.
      //
      // Under row tenancy the standing is read under a claim naming a tenant the
      // write touched, from this channel or, for a fixed one, from the others the
      // recipient holds. None, and the recipient's tenant is not established:
      // refused.
      const standings = tenantClaim
        ? [...(claims ? [claims] : elsewhere.get(key) ?? [])]
            .filter(held => wantedTenants.has(String(held[tenantClaim])))
            .map(held => ({ ...(base as object ?? {}), ...held }))
        : [who]
      if (!standings.some(s => principalGateLevel(db, accessor, s, group.user) >= (readLevel as number))) continue
      admitted++
      out.push({ conns, frame: encodeEventFrame(event, payload) })
      continue
    }
    let visible: unknown
    try { visible = await readAsOf(payload, who, key, claims) }
    catch { continue }                      // undecidable: refuse, never widen
    if (!visible) {                         // the gate or a policy said no
      if (removal) {
        let held: unknown = null
        try { held = await readAsOf(before, who, key, claims) } catch { /* undecidable: owed nothing */ }
        if (held) out.push({ conns, frame: removal })
      }
      continue
    }
    if (removalsOnly) continue
    admitted++
    out.push({ conns, frame: encodeEventFrame(event, visible) })
  }

  if (live > 0 && admitted === 0 && !removalsOnly && src.label)
    warnRefusedAll(src.label, accessor, live, tenancyHint(db, claimsFor))
  return out
}

// ─── Channel manager ──────────────────────────────────────────────────────

// ─── Rooms: a channel bound to a row ──────────────────────────────────────
//
// `FJS-1743`, ruled by `FJS-D596`. Admission was the app's call, asked once at
// the join, and a reader whose grant was revoked stayed in the room: presence
// and `channel.send` are not graded per recipient, so both reached them in
// both directions until they closed the tab. Grading every presence frame
// would put the busiest frame an app sends through the Data boundary, so the
// membership is kept true instead — graded at the join, and asked again after
// every committed write to a model the row's read policy reaches.

/** The row a channel name stands for. */
interface RoomRow { model: string; id: string; tenant?: string }

/** What the manager needs to bind a room. Resolved by `channels()`. */
export interface RoomPolicy {
  match: (channelName: string) => RoomRow | null
  /**
   * The client the room's row is read through and graded on, and the lease on
   * it. A tenanted app has one client per tenant, so the room's tenant picks
   * it; `null` says no client can be had, which admits nobody.
   */
  open:  (tenant: string | undefined) => Promise<{ db: unknown; release: () => void } | null>
}

/**
 * `{ 'page:{id}': 'Page' }` → the matcher. `{id}` is one segment with no `:`,
 * so `page:{id}` never claims `page:1:comments`. Under `createApp({ tenants })`
 * a pattern also names the tenant, `{ '{tenant}:page:{id}': 'Page' }`, since a
 * channel name is the only thing a room has to find its tenant's client by.
 */
export function roomMatcher(rooms: Record<string, string>, tenanted = false): (name: string) => RoomRow | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const compiled = Object.entries(rooms).map(([pattern, model]) => {
    const parts = pattern.split(/(\{id\}|\{tenant\})/)
    const slots = parts.filter(p => p === '{id}' || p === '{tenant}')
    if (slots.filter(s => s === '{id}').length !== 1)
      throw new Error(`[Junction] channels({ rooms }): '${pattern}' must name the row's id exactly once, as {id}`)
    const tenants = slots.length - 1
    if (tenanted && tenants !== 1)
      throw new Error(`[Junction] channels({ rooms }): '${pattern}' must name the tenant exactly once, as {tenant} — ` +
        `this app is createApp({ tenants }) and a room's row lives in its tenant's client`)
    if (!tenanted && tenants !== 0)
      throw new Error(`[Junction] channels({ rooms }): '${pattern}' names {tenant} and this app has no createApp({ tenants })`)
    const re = new RegExp('^' + parts.map(p => p === '{id}' || p === '{tenant}' ? '([^:]+)' : esc(p)).join('') + '$')
    return { re, model, slots }
  })
  return (name) => {
    for (const { re, model, slots } of compiled) {
      const m = re.exec(name)
      if (!m) continue
      return { model, id: m[1 + slots.indexOf('{id}')], ...(tenanted ? { tenant: m[1 + slots.indexOf('{tenant}')] } : {}) }
    }
    return null
  }
}

/** What the manager needs to know about presence. Resolved by `channels()`. */
export interface PresenceOptions {
  /** Is presence tracked for this channel at all? */
  enabled: (channelId: string) => boolean
  /** How long join/leave events are batched before one diff goes out. */
  flushMs: number
}

export function createChannelManager(presenceOptions?: PresenceOptions, claimsFor?: ChannelClaimsFn, rooms?: RoomPolicy) {

  const _presenceOptions: PresenceOptions = presenceOptions ?? { enabled: () => false, flushMs: 50 }

  const channels    = new Map<string, Channel>()
  const connections = new Map<string, Connection>()

  // The app-level fallback publisher — see announceDefault() below. Null until
  // an app registers one, which is what keeps broadcasting opt-in.
  let _default: ChannelFn | null = null

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

  /**
   * A presence frame goes to the channel's ROSTER, not to its connections.
   *
   * The two are not the same set: the tracker records nobody with no `userId`,
   * so an anonymous connection the app joined to a channel is deliberately
   * invisible in every roster — and then received `presence:join` and
   * `presence:update` for everyone else through the plain channel fan-out,
   * naming their user id and whatever meta the app publishes (`FJS-811`, found
   * by test/client-presence.test.ts). It could never assemble a roster from
   * them, since a sync it is not sent, so this was disclosure with no feature
   * on the other side of it.
   *
   * One owner, because the leak was in two places and the second — the meta
   * update — looks nothing like the first.
   */
  function broadcastToPresence(channelId: string, excludeConnId: string | null, event: string, data: unknown): void {
    const ch = channels.get(channelId)
    if (!ch) return
    const roster = _presence.presenceFor(channelId)
    const msg = encodeEventFrame(event, data)
    for (const conn of ch.connections) {
      if (conn.id === excludeConnId) continue
      if (!roster.has(conn.id)) continue
      if (conn.socket.readyState === 1) wsSend(conn.socket, msg)
    }
  }

  const _presence = createPresenceTracker({
    broadcast:  (channelId, excludeConnId, event, data) =>
      broadcastToPresence(channelId, excludeConnId, event, data),
    sendToConn,
    flushMs:    _presenceOptions.flushMs,
  })
  const _presenceFor     = _presence.presenceFor
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

  // Which channels a connection is in — what a fixed channel's recipient is
  // graded by when its own resolver answers no claim (`gradeRecipients`).
  function channelsOf(conn: Connection): string[] {
    const names: string[] = []
    for (const ch of channels.values()) if (ch.connections.has(conn)) names.push(ch.name)
    return names
  }

  function getOrCreate(name: string): Channel {
    let ch = channels.get(name)
    if (!ch) { ch = new Channel(name); channels.set(name, ch) }
    return ch
  }

  // ── Rooms ───────────────────────────────────────────────────────────
  // The row is read as the system and graded per cohort by the same
  // `gradeRecipients` a broadcast takes, so a join and a broadcast cannot
  // disagree about who may read it. A row that is gone, or a client that
  // cannot be asked, admits nobody.
  async function roomAdmits(room: RoomRow, name: string, conns: Connection[]): Promise<Set<Connection>> {
    let lease: { db: unknown; release: () => void } | null = null
    try {
      lease = await rooms?.open(room.tenant) ?? null
      const db = lease?.db as Record<string, any> | undefined
      if (!db || typeof db !== 'object' || !('$readAs' in db) || !('$primaryKey' in db)) return new Set()
      tapRoomClient(db, room.tenant)
      primeReach(room.model, db)
      const accessor = resolveAccessor(db, room.model)
      const pk = db.$primaryKey(accessor) as string[]
      if (pk.length !== 1) return new Set()
      const row = await db.asSystem()[accessor].findFirst({ where: { [pk[0]]: room.id } })
      if (!row) return new Set()
      const probe = new Channel(name)
      for (const conn of conns) probe.connections.add(conn)
      const graded = await gradeRecipients([probe], 'room', row, { db, accessor: room.model }, 'row', claimsFor, channelsOf)
      // Null once the row was read means the model can only ever say yes.
      if (graded === null) return new Set(conns.filter(c => c.socket.readyState === 1))
      return new Set(graded.flatMap(c => c.conns))
    } catch { return new Set() }
    finally { lease?.release() }
  }

  // Under `createApp({ tenants })` there is no one client to tap at boot: a
  // tenant's client is tapped the first time a room reads through it, and a
  // client evicted from the pool and reopened is a new object, tapped again.
  const tappedRoomClients = new WeakSet<object>()
  const untapRoomClients  = new Set<() => void>()
  function tapRoomClient(db: Record<string, any>, tenant: string | undefined): void {
    if (tenant === undefined || tappedRoomClients.has(db)) return
    tappedRoomClients.add(db)
    if (typeof db.$tapEvents !== 'function') return
    untapRoomClients.add(db.$tapEvents((e: Partial<RoomWrite>) => { if (e?.model) noteWrite(e as RoomWrite, tenant) }))
  }

  // The models whose writes can take a room's row from a reader. Null where
  // the client cannot say, and then every write asks again. The policy is the
  // schema's, so one tenant's client answers for all of them. A claims resolver
  // is app code whose reads are not on the policy AST (a Member row behind
  // auth().memberRole), so with one installed the reach is unknowable and every
  // write asks again (`FJS-2521`).
  //
  // Beside the reach, the columns of each reached model the verdict reads: an
  // update of a reached row that leaves them all as they were moves nobody's
  // grade, so a stamp written every few seconds asks nobody (`FJS-3303`).
  const reachCache   = new Map<string, Set<string> | null>()
  const columnsCache = new Map<string, Map<string, Set<string>>>()
  function primeReach(model: string, db: Record<string, any>): void {
    if (reachCache.has(model)) return
    let reach: Set<string> | null = null
    try {
      if (!claimsFor && '$readReach' in db) {
        const accessor = resolveAccessor(db, model)
        reach = new Set(db.$readReach(accessor) as string[])
        if (typeof db.$readColumns === 'function') {
          const answer = db.$readColumns(accessor) as Record<string, string[]>
          columnsCache.set(model, new Map(Object.entries(answer).map(([m, c]) => [m, new Set(c)])))
        }
      }
    } catch { reach = null }
    reachCache.set(model, reach)
  }
  const reachOf = (model: string): Set<string> | null => reachCache.get(model) ?? null

  // The writes of a model that could move a room model's grade: every write
  // counted under the model, less those counted quiet under `room\0model`. A
  // room model not primed yet has no quiet count, so it asks on every write.
  const quietKey = (roomModel: string, model: string) => `${roomModel}\0${model}`
  const movedBy  = (counts: Map<string, number>, roomModel: string, model: string): number =>
    (counts.get(model) ?? 0) - (counts.get(quietKey(roomModel, model)) ?? 0)

  function tally(counts: Map<string, number>, w: RoomWrite): void {
    counts.set(w.model, (counts.get(w.model) ?? 0) + 1)
    if (w.event !== 'update' || w.scope !== 'row') return
    for (const [roomModel, byModel] of columnsCache) {
      const read = byModel.get(w.model)
      if (read && columnsUnmoved(read, w.before, w.result)) {
        const key = quietKey(roomModel, w.model)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }

  // Writes are counted per tenant: a write in one shop asks nobody in another.
  const writeCount = new Map<string, Map<string, number>>()
  const written    = new Map<string, Map<string, number>>()
  let roomTimer: ReturnType<typeof setTimeout> | null = null

  const snapshotWrites = (room: RoomRow) => new Map(writeCount.get(room.tenant ?? '') ?? [])

  function writesSince(room: RoomRow, before: Map<string, number>): boolean {
    const now   = writeCount.get(room.tenant ?? '')
    const reach = reachOf(room.model)
    for (const m of now?.keys() ?? []) {
      if (m.includes('\0') || (reach && !reach.has(m))) continue
      if (movedBy(now!, room.model, m) !== movedBy(before, room.model, m)) return true
    }
    return false
  }

  // A join graded while a write it depends on landed is graded again: the pass
  // that followed the write ran before this member was in the room to ask.
  async function admitToRoom(
    ch: Channel, room: RoomRow, conn: Connection, opts?: { meta?: Record<string, unknown> },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = snapshotWrites(room)
      const ok = (await roomAdmits(room, ch.name, [conn])).has(conn)
      if (!ok || !connections.has(conn.id)) return false
      if (writesSince(room, before)) continue
      // The gc prunes an empty channel, and this one was empty while it graded.
      let live = channels.get(ch.name)
      if (!live) { channels.set(ch.name, ch); live = ch }
      live.__admit!(conn, opts)
      return true
    }
    return false
  }

  // Out of the room, and told: a leave sends the leaver nothing, so without the
  // empty sync their own screen keeps the roster of a room they are no longer in
  // and their own presence updates are dropped in silence.
  function evict(ch: Channel, conn: Connection): void {
    ch.leave(conn)
    sendToConn(conn, 'presence:sync', { channelId: ch.name, you: conn.id, members: [] })
  }

  async function reaskRooms(): Promise<void> {
    roomTimer = null
    const pending = new Map(written)
    written.clear()
    for (const ch of [...channels.values()]) {
      const room = rooms?.match(ch.name)
      if (!room || ch.length === 0) continue
      const models = pending.get(room.tenant ?? '')
      if (!models) continue
      const reach = reachOf(room.model)
      if (![...models.keys()].some(m => !m.includes('\0') && (!reach || reach.has(m)) && movedBy(models, room.model, m) > 0)) continue
      const members = [...ch.connections]
      const keep = await roomAdmits(room, ch.name, members)
      for (const conn of members) if (!keep.has(conn) && ch.connections.has(conn)) evict(ch, conn)
    }
  }

  // Called with the model of every committed write, and the tenant whose
  // client made it where the app has tenants. Coalesced to one pass, which
  // asks each bound room the write reaches once per cohort.
  function noteWrite(w: RoomWrite, tenant?: string): void {
    if (!rooms) return
    const key = tenant ?? ''
    let counts = writeCount.get(key)
    if (!counts) writeCount.set(key, counts = new Map())
    tally(counts, w)
    let models = written.get(key)
    if (!models) written.set(key, models = new Map())
    tally(models, w)
    if (!roomTimer) roomTimer = setTimeout(() => { reaskRooms().catch(() => {}) }, 0)
  }

  return {

    // Graded send for a write that went through NO service call — the
    // litestone tap (`announceDataWrites`). The announce() path grades off a
    // ServiceContext and there is none here, so the two facts grading needs are
    // handed over instead: the client the rule lives on and the model the
    // payload is a row of. Without it every write outside its own service — a
    // job, a webhook, a cron, a bulk write — put whole rows on every subscribed
    // socket, whatever the schema said (`FJS-672`). Measured: 100 anonymous
    // sockets, `asSystem().create` on a policied model, 100 of 100 received it.
    //
    // A target is a channel's NAME (a string `channel:`) or the channel a
    // function `channel:` answered with (`FJS-1741`). A name nobody has joined
    // is skipped rather than created.
    async sendGraded(
      target:    string | Channel | ReadonlyArray<string | Channel>,
      event:     string,
      payload:   unknown,
      src:       GradingSource,
      mode:      'row' | 'gate' = 'row',
    ): Promise<void> {
      const targets: Channel[] = []
      for (const t of (Array.isArray(target) ? target : [target]) as Array<string | Channel>) {
        const ch = typeof t === 'string' ? channels.get(t) : t
        if (ch && !targets.includes(ch)) targets.push(ch)
      }
      if (!targets.length) return
      const graded = await gradeRecipients(targets, event, payload, src, mode, claimsFor, channelsOf)
      if (!graded) {
        // Ungraded means "no boundary to ask", which is a reason to send a row
        // and none to send a removal nobody was shown to be owed.
        if (!src.removalsOnly) for (const ch of targets) ch.send(event, payload)
        return
      }
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
      if (!ch.__presenceWrapped && _presenceOptions.enabled(name)) {
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

      // After the presence wrap, so an admitted join is a presence join.
      const room = rooms?.match(name)
      if (room && !ch.__admit) {
        ch.__admit = ch.join.bind(ch)
        ch.join = (conn: Connection, opts?: { meta?: Record<string, unknown> }) => admitToRoom(ch, room, conn, opts)
      }

      return ch
    },

    // Called by `channels({ rooms })` with the model of every committed write
    // on the app's one client; a tenant's client is tapped by the manager.
    roomWritten(w: RoomWrite): void { noteWrite(w) },

    // Exposed for the WS service dispatcher — read-only access to live connections
    get connections(): ReadonlyMap<string, Connection> {
      return connections
    },

    /**
     * Does this user have a tab on screen? This process's sockets only: a
     * user connected to another instance reads as not visible.
     */
    hasVisibleConnection(userId: string | number): boolean {
      const id = String(userId)
      for (const conn of connections.values()) {
        if (conn.visible && conn.user?.id != null && String(conn.user.id) === id) return true
      }
      return false
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
        __gone: new AbortController(),
      }

      connections.set(conn.id, conn)
      // Send ack with connection id so the client can correlate responses
      wsSend(socket, JSON.stringify({ type: 'connection', id: conn.id }))

      for (const handler of onConnectHandlers) {
        try { await handler(session, conn) } catch {}
      }

      return conn
    },

    // ── disconnectSession ───────────────────────────────────────────
    //
    // Close every socket a given session holds.
    //
    // The transport asks a socket's bearer again on each frame and on
    // `http.ws.reverifySeconds` (`FJS-D1201`), so a change to what a session
    // means reaches a quiet socket only on that interval. Support mode cannot
    // wait for it: an operator who ends an episode stops acting as the subject
    // at once.
    //
    // Blunt rather than careful, deliberately. Re-resolving a live connection
    // in place would mean rebuilding a principal underneath frames that are
    // already in flight; closing it costs a reconnect the client already knows
    // how to do, and the reconnect resolves the session afresh.
    //
    // Answers how many it closed, because *nothing to close* and *nothing
    // happened* are the same silence otherwise.
    disconnectSession(sessionId: string, reason = 'session changed'): number {
      let closed = 0
      for (const conn of connections.values()) {
        if (conn.user?.sessionId !== sessionId) continue
        closed++
        // Through the ordinary path: it deletes the connection, leaves its
        // channels, and closes the socket. A raw close would leave the manager
        // holding a connection whose socket is gone.
        void this.handleDisconnect(conn.id, reason)
      }
      return closed
    },

    // Called by _wsClose AND by heartbeat eviction
    async handleDisconnect(connId: string, reason = 'connection evicted'): Promise<void> {
      const conn = connections.get(connId)
      if (!conn) return

      connections.delete(connId)
      conn.__gone?.abort()

      // Close the socket if it's still open. On a normal close event this
      // is a no-op; on HEARTBEAT EVICTION it's essential — previously the
      // server dropped all its state but left the client connected as a
      // zombie whose subsequent calls ran with conn = null (silently losing
      // the authenticated user).
      try {
        if (conn.socket.readyState === 1) conn.socket.close(1001, reason)
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
    // the natural workaround — an app-level `after: { all: [announce(fn)] }` —
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
    announceDefault<T = unknown>(fn: ChannelFn<T>): () => void {
      _default = fn as ChannelFn
      return () => { if (_default === (fn as ChannelFn)) _default = null }
    },

    // Read by announceToChannels (core/service.ts) for a service that declares
    // no channel:. A getter rather than a field so the manager stays the one
    // owner of when it is null.
    get defaultAnnouncer(): ChannelFn | null {
      return _default
    },

    // Core send — called by the announce() hook
    async announce<T = unknown>(
      event:     string,
      data:      T,
      ctx:       ServiceContext,
      fn:        AnnounceFn<T>,
      accessor?: string
    ): Promise<void> {
      const result = fn(data, ctx)
      if (!result) return
      const targets: Channel[] = []
      for (const t of (Array.isArray(result) ? result : [result]) as ChannelTarget[]) {
        const ch = typeof t === 'string' ? channels.get(t) : t
        if (ch && !targets.includes(ch)) targets.push(ch)
      }
      if (!targets.length) return
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
      const svc = ctx.app?.services?.get?.(ctx.service ?? '') as { model?: string | null } | undefined
      const graded = await gradeRecipients(targets, event, payload, {
        db:       callDb(ctx),
        // A method that declared `answers:` states the accessor itself: the
        // row it answers belongs to another model (`FJS-D914`).
        accessor: accessor ?? serviceAccessor({ name: (ctx as { service?: string }).service ?? '', model: svc?.model }) ?? '',
        label:    (ctx as { service?: string }).service,
      }, 'row', claimsFor, channelsOf)
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
        // a broadcast is the one thing here whose two numbers differ, and the gap
        // between them is the whole point of it.
        const inChannel = targets.reduce((n, ch) => n + ch.length, 0)
        const recipientCount = graded
          ? graded.reduce((n, g) => n + g.conns.length, 0)
          : inChannel
        telemetry.emit('junction.channel.announce', {
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

    // ── Presence queries — server-side, on this node ─────────────────────
    // Each reads this process's Maps (FJS-D686). Behind a balancer a person
    // whose socket landed on another instance is absent from all three, so
    // "assign only agents who are online" quietly skips them. An app running
    // more than one instance fans the question out itself.
    localPresence(channelId: string): PresenceMember[] {
      return presenceMembers(channelId)
    },

    localPresenceOf(userId: string | number): Array<Omit<PresenceMember, 'channelId'> & { channelId: string }> {
      return presenceByUser(userId)
    },

    // Who holds a live socket right now. Presence answers a different
    // question -- who announced themselves on a channel -- so a signed-in user
    // with an open socket and no subscribe is `localPresenceOf() === []` but
    // connected.
    localConnectionsOf(userId: string | number): Connection[] {
      const out: Connection[] = []
      for (const conn of connections.values()) {
        if (conn.user?.id === userId && conn.socket.readyState === 1) out.push(conn)
      }
      return out
    },

    // ── Internal — used by the subscribe message handler in the plugin ────
    // Not part of the public API — prefixed with _ to signal intent.
    _presenceGet(channelId: string, connId: string): PresenceMember | undefined {
      return presenceGet(channelId, connId)
    },
    _presenceMembers:      presenceMembers,
    _broadcastToPresence:  broadcastToPresence,
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
      if (roomTimer) clearTimeout(roomTimer)
      for (const untap of untapRoomClients) untap()
      untapRoomClients.clear()
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
//      announce() hook can find the manager without a global variable.
//
//   3. Calls the optional setup function so the app can declare which
//      channels a connection joins at connect time.
//
// Auth flow:
//   The browser client offers subprotocols ['fjs', 'fjs.bearer.<session_or_api_key>'];
//   any other client may send Authorization, x-api-key or the cookie instead.
//   A URL never carries it (FJS-D486).
//   _wsOpen resolves the token asynchronously before joining channels.
//   A token that is present and does not verify — thrown or answered null —
//   closes the socket with 4001 ('auth_failed') before any channel is joined,
//   and the client does not reconnect. A raw app.ws route is not refused.
//   No token → joins only the 'anonymous' channel.

export type ChannelSetupFn = (app: App & { channels: ReturnType<typeof createChannelManager> }) => void

export interface ChannelsOptions {
  /** How often the server pings an otherwise silent connection. Default 15s. */
  heartbeatInterval?: number
  /** How long a connection may say nothing before it is evicted. Default 40s. */
  heartbeatTimeout?:  number

  /**
   * The largest presence meta one connection may set, in bytes of JSON.
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
   * an app without one delivers nothing on any tenanted model. It may be async,
   * and is asked on every frame.
   */
  claims?: ChannelClaimsFn

  /**
   * Presence updates one connection may send per second. Default 5.
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
   *
   * The second argument says where the update lands: the channel, the
   * connection, and `was`, the meta it replaces (`{}` before the first). A
   * meta that is a position is a move only against where the member stood,
   * and an app that remembers moves can know that nowhere else.
   */
  presenceMeta?: (
    meta: Record<string, unknown>,
    at: { channel: string, conn: Connection, was: Record<string, unknown> },
  ) => Record<string, unknown>

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

  /**
   * Channels that stand for one row: `{ 'page:{id}': 'Page' }`, the pattern
   * naming the row's id once as `{id}` (one segment, no `:`) and the value its
   * model (`FJS-D596`).
   *
   * A join on a bound name is graded at the Data boundary — the row read as
   * the system, then the joiner's read verdict on it — and answers a Promise
   * of whether it was admitted. After every committed write to a model the
   * row's read policy reaches, each member is asked again and one who lost
   * the row is taken out and sent an empty `presence:sync`. So presence and
   * `channel(name).send` need no grading of their own: everyone in the room
   * may read its row. Needs `createApp({ db })`, or `createApp({ tenants })`
   * with the tenant named in the pattern, `{ '{tenant}:page:{id}': 'Page' }`.
   */
  rooms?: Record<string, string>
}

// The client a room's row is read through: the app's one, or the tenant's the
// room name encodes. `registry.get` refuses a tenant that does not exist, and a
// room of a tenant nobody has admits nobody.
function openRoomClient(app: App): RoomPolicy['open'] {
  return async (tenant) => {
    const registry = app.tenants
    if (!registry) return { db: (app as { db?: unknown }).db, release: () => {} }
    if (tenant === undefined) return null
    try {
      const db = await registry.get(tenant)
      return { db, release: registry.retain?.(tenant) ?? (() => {}) }
    } catch { return null }
  }
}

export function channels(setup?: ChannelSetupFn, opts: ChannelsOptions = {}): Plugin {
  let _manager:        ReturnType<typeof createChannelManager> | null = null
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let _untapRooms:     (() => void) | null = null

  return {
    name: 'channels',

    register(app: App): void {
      // Create and attach the channel manager
      // Resolved once, here, rather than read per channel: `channel()` runs on
      // every broadcast and a pattern match per call is a cost with no reason.
      const declared = opts.presence ?? false
      const enabled =
        declared === false ? () => false
        : declared === true ? () => true
        : (() => {
            const exact    = new Set(declared.filter(p => !p.endsWith('*')))
            const prefixes = declared.filter(p => p.endsWith('*')).map(p => p.slice(0, -1))
            return (name: string) => exact.has(name) || prefixes.some(p => name.startsWith(p))
          })()

      const rooms: RoomPolicy | undefined = opts.rooms
        ? { match: roomMatcher(opts.rooms, !!app.tenants), open: openRoomClient(app) }
        : undefined
      const manager = createChannelManager({ enabled, flushMs: opts.presenceFlushMs ?? 50 }, opts.claims, rooms)
      if (typeof app.own === 'function') app.own('channels', manager)
      else (app as unknown as Record<string, unknown>).channels = manager
      _manager = manager

      // Convenience shortcuts
      ;(app as unknown as Record<string, unknown>).channel     = (name: string) => manager.channel(name)
      ;(app as unknown as Record<string, unknown>).localPresence   = (channelId: string) => manager.localPresence(channelId)
      ;(app as unknown as Record<string, unknown>).localPresenceOf = (userId: string | number) => manager.localPresenceOf(userId)

      const _auth = 'auth' in app ? app.auth : undefined

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
        [SESSION_SOCKET]: true,

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
            userId:       session?.id ?? null,
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

          // A frame the server cannot act on is refused BY NAME, where it was
          // dropped in silence: the sender's call then waited out its whole
          // timeout and read 408, which names nothing. One small fixed frame
          // per refused frame, and the transport's frame rate already bounds
          // how many of those there can be (`FJS-2147`).
          const refuse = (code: string, message: string, id?: string | number): void => {
            ctx.send({ type: 'protocol_error', ...(id !== undefined ? { id } : {}), error: { code, message } })
          }

          const parsed = manager.handleMessage(connId, msg)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            refuse('malformed_frame', 'Frame is not a JSON object')
            return
          }

          // The parse above has already rounded a digit-only literal past 2^53,
          // so the text is the only place the digits sent still exist.
          const unsafe = firstUnsafeInteger(typeof msg === 'string' ? msg : msg.toString())
          if (unsafe) {
            const id = (parsed as { id?: unknown }).id
            refuse(
              'unsafe_integer',
              new UnsafeIntegerError(unsafe, 'Frame').message,
              typeof id === 'string' || typeof id === 'number' ? id : undefined,
            )
            return
          }

          // ── Ping/pong keepalive ──────────────────────────────────
          // Either side may ping; the other answers. lastSeen is already
          // stamped above, so neither branch has anything else to do.
          if (parsed.type === 'ping') {
            ctx.send({ type: 'pong' })
            return
          }
          if (parsed.type === 'pong') return

          if (parsed.type === 'visibility') {
            const conn = manager.connections.get(connId)
            if (conn) conn.visible = parsed.visible === true
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
            // The call is answered by its id, so a call without one has no
            // answer the client could match — and ran anyway.
            if (typeof callId !== 'string' && typeof callId !== 'number') {
              refuse('missing_id', 'A service_call frame needs an id, a string or a number')
              return
            }
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

            // `String({})` is `[object Object]`, which reached the service as a
            // row id and came back as "id=[object Object] not found".
            const metaId = (extraParams as Record<string, unknown>).id
            if (metaId != null && typeof metaId !== 'string' && typeof metaId !== 'number') {
              refuse('invalid_id', 'meta.id must be a string or a number', callId)
              return
            }

            app.telemetry?.emit('junction.ws.message', {
              connectionId: connId,
              service:      serviceName as string,
              method:       method as string,
            })

            // RETURNED, not started and dropped: the transport counts a frame
            // as in flight until this settles, and a handler that returned
            // first let maxInFlight read 0 under any number of running calls.
            return (async () => {
              await ensureDeps()
              const { bridge: _bridge2, readTransportFlags: _readFlags, errorBody: _errorBody } = _bridge!
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
              // workspaceId is lifted onto ctx.caller.headers below, so it does
              // not also belong in locals — one owner per translation.
              // correlationId becomes request metadata, which is an ALS store
              // rather than a context field.
              // `base` is the row a held write was made against (`FJS-D334`).
              // It needs no envelope here — a frame already carries its caller
              // extras under `meta`, which is the slot HTTP does not have
              // (`FJS-D338`) — but it is a CONTEXT field rather than scratch,
              // so it is lifted out of the spread into `locals` below.
              const {
                query: _q, workspaceId: _ws, headers: _hdrs,
                correlationId: _cid, base: _base,
                ...restExtra
              } = extra


              // Request metadata is an AsyncLocalStorage store, and this path
              // wrapped nothing for its whole life — so requestMeta() was
              // undefined for every socket call and anything reading it (a
              // correlation id in a log, the Idempotency-Key that decides
              // whether a create runs twice) silently applied to half the
              // transports. enterRequest() is the one owner now, and reads the
              // Idempotency-Key and a replayed write's two instants from the
              // headers it is handed, as it does over HTTP. It is handed the
              // FRAME's, not the merged map: the upgrade's are one set for
              // every call on the connection, and one key there would make
              // every later write a replay of the first.
              const started = Date.now()
              let status = 200
              // A client wrote it, so it meets the same shape check a header does.
              const correlationId = acceptedRequestId(extra.correlationId)
              // Built inside the try: a refused directive thrown before it
              // rejected into the frame's catch-all, and the caller waited on a
              // reply that never came.
              let svcCtx: import('../core/context.ts').ServiceContext | undefined
              try {
                // WS-origin caller facts (headers/ip) belong on ctx.caller.
                //
                // `ctx.headers` are the UPGRADE request's headers — one set for
                // the life of the connection. Anything a caller varies per call
                // therefore cannot arrive that way: a workspace changes when a
                // person switches workspace, a guest basket's token comes into
                // existence after the socket is already up. The browser client
                // sends those on the frame (`meta.headers`) and they are merged
                // in here, so a hook reading ctx.caller.headers sees the same
                // value it would have seen over HTTP.
                //
                // An ALLOW-LIST, not a merge. A frame that could name its own
                // header could name Authorization and override the identity
                // established at upgrade, so a name reaches the context only if
                // the app declared it in `http.callHeaders` — or if it is one of
                // junction's own, which the client sends unasked.
                const headers = _mergeCallHeaders(
                  ctx.headers,
                  extra.headers as Record<string, unknown> | undefined,
                  extra.workspaceId,
                  app,
                )
                svcCtx = _bridge2.fromFrame({
                  // The CANONICAL name — a frame naming an older spelling of it
                  // resolves, and then announces and resolves its model under the
                  // one name the service has (`FJS-570`).
                  service: svc.name,
                  model:   (svc as unknown as { model?: string }).model ?? svc.name,
                  method:  method as string,
                  data:    (data as Record<string, unknown> | null) ?? null,
                  query:   wsQuery,
                  id:      extra.id,
                  base:    (_base && typeof _base === 'object' && !Array.isArray(_base)
                    ? _base as Record<string, unknown>
                    : null),
                  user:    (conn?.user ?? null) as import('../auth/types.ts').SessionContext | null,
                  caller:  { ip: ctx.ip, userAgent: headers['user-agent'], headers },
                  locals:  { __channels: manager, ...restExtra } as Record<string, unknown>,
                  signal:  conn?.__gone?.signal,
                }, app)
                const { wrap } = _readFlags(wsQuery)
                const call = svcCtx
                await _enterRequest!({
                  origin:         'websocket',
                  correlationId,
                  headers:        _frameProtocolHeaders(extra.headers),
                  // Same as the HTTP path — the principal is request-wide, and
                  // it is what an internal call inherits when it names none.
                  user:           call.user,
                  caller:         call.caller,
                }, () =>
                  _call(svc, call, app._appHooks, app.events, app.telemetry))
                ctx.send({ type: 'service_result', id: callId, result: _bridge2.toFrame(call, wrap) })
              } catch (err: unknown) {
                const fe = _toErr(err, app)
                status = fe.code
                ctx.send({ type: 'service_error', id: callId, error: _errorBody(fe, svcCtx) })
              } finally {
                logSocketCall(app, {
                  service: svc.name, method: method as string, id: svcCtx?.id == null ? null : String(svcCtx.id),
                  status, ms: Date.now() - started, ip: ctx.ip,
                  correlationId,
                })
              }
            })().catch(() => {})
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
                try { meta = opts.presenceMeta(raw, { channel: channelId, conn, was: member.meta }) } catch (err) {
                  manager._sendToConn(conn, 'error', {
                    code:    'presence_meta_refused',
                    message: (err as Error).message,
                  })
                  return
                }
              }

              member.meta = meta
              // To the ROSTER — see broadcastToPresence. A connection presence
              // does not track is not a member and is told nothing about one.
              manager._broadcastToPresence(channelId, connId, 'presence:update', {
                channelId,
                connectionId: connId,
                meta:         member.meta,
              })
            }

            // Always send presence:sync back to sender with full current list
            // (including sender's own — possibly updated — entry)
            manager._sendToConn(conn, 'presence:sync', {
              channelId,
              you:     connId,
              members: manager._presenceMembers(channelId),
            })
            return
          }

          if (parsed.type === 'unsubscribe') {
            // Apps handle explicit unsubscribe via channels.on() if needed
            return
          }

          refuse('unknown_frame', `Unknown frame type '${String(parsed.type).slice(0, 64)}'`)
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
      // Added as an app-level around hook so announce() can find the
      // manager without importing it or closing over a variable.
      app.hooks({
        around: {
          all: [async (ctx, next) => {
            ctx.locals.__channels = manager
            await next()
          }]
        }
      })

      // ── WS counts, as a /metrics section ─────────────────────────
      // Not a route: a `GET /channels/stats` takes the name `channels` from
      // the app, and refuseShadowedServices then refuses its service by that
      // name (`FJS-2897`). Counts only — a channel name carries a row id
      // (`user:42`) and /metrics may be public.
      if (typeof app.registerMetricsSource === 'function') {
        app.registerMetricsSource('channels', () => {
          const { connections, channels } = manager.stats()
          return { connections, channels }
        })
      }

      // ── Run user setup ───────────────────────────────────────────
      if (setup) {
        setup(app as App & { channels: ReturnType<typeof createChannelManager> })
      }
    },

    // ── The fall-through report ──────────────────────────────────────────
    //
    // Runs only when an app registered a default publisher, and lists the
    // services that will therefore broadcast without ever having said so.
    // That is the failure `announceDefault` introduces and the only one it
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
      reportAnnounceReach(app)

      // The root client's tap hears every write once its transaction commits,
      // whichever flavor made it.
      if (opts.rooms && !app.tenants) {
        let tap: unknown
        try { tap = ((app as { db?: unknown }).db as { $tapEvents?: unknown } | undefined)?.$tapEvents } catch {}
        if (typeof tap !== 'function') throw new Error(
          `[Junction] channels({ rooms }) binds a channel to a row, which needs the app's Litestone client ` +
          `— createApp({ db }) or createApp({ tenants }). This app has neither, so no join could be graded.`)
        _untapRooms = (tap as (fn: (e: Partial<RoomWrite>) => void) => () => void)
          .call((app as { db?: unknown }).db, (e) => { if (e?.model) _manager?.roomWritten(e as RoomWrite) })
      }

      if (!_manager?.defaultAnnouncer) return

      const undeclared = app.services.values()
        .filter(svc => (svc as { channel?: unknown }).channel === undefined)
        .map(svc => svc.name)

      if (undeclared.length === 0) return

      console.warn(
        `[Junction] ${undeclared.length} service(s) declare no channel: and will ` +
        `broadcast on the app-level announceDefault(): ${undeclared.join(', ')}. ` +
        `Declare channel: to name a target, or channel: false to opt out.`
      )
    },

    shutdown(): void {
      _untapRooms?.()
      _untapRooms = null
      _manager?.destroy()
      _manager = null
      if (_heartbeatTimer) {
        clearInterval(_heartbeatTimer)
        _heartbeatTimer = null
      }
    }
  }
}

// ─── Announce reach ───────────────────────────────────────────────────────

/**
 * A database announces a write to ITS OWN process unless it declares
 * `announce crossProcess` (`FJS-D173`), so a second replica on the same file
 * puts nothing on the first replica's sockets and its live screens go stale
 * with nothing marking it (`FJS-2146`). Junction cannot see how many processes
 * the deploy runs, so this says what the default reaches, once, at the layer
 * that fans events out to sockets. A database that WROTE `announce`, either
 * value, has said how many it runs and is not reported (`FJS-D851`).
 */
function reportAnnounceReach(app: App): void {
  const databases = (app.db as { $schema?: { databases?: Array<{ name: string; driver?: string; announceStated?: boolean }> } } | undefined)
    ?.$schema?.databases
  const inProcess = (databases ?? [])
    .filter(d => (!d.driver || d.driver === 'sqlite') && !d.announceStated)
    .map(d => d.name)
  if (inProcess.length === 0) return
  // `fli dev` starts one API process, which inProcess reaches whole.
  if (process.env[DEV_ENV]) return

  console.warn(
    `[Junction] channels: ${inProcess.join(', ')} announce inProcess, so another process's writes ` +
    `reach no socket here — a replica or worker needs \`announce crossProcess\`, ` +
    `and one process meant states \`announce inProcess\``
  )
}

// ─── Per-call headers ─────────────────────────────────────────────────────

/** Junction's own protocol headers, lower-cased — always mergeable off a frame.
 *  The declaration is `PROTOCOL_CALL_HEADERS` in core/context.ts, shared with CORS. */
const PROTOCOL_CALL_LOWER = PROTOCOL_CALL_HEADERS.map(h => h.toLowerCase())

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
  const declared = declaredCallHeaders(app)
  const allowed  = new Set([...PROTOCOL_CALL_LOWER, ...declared.map(h => h.toLowerCase())])

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

/** The protocol headers THIS frame states, lower-cased — what enterRequest()
 *  reads per call, and nothing the upgrade said for the whole connection. */
function _frameProtocolHeaders(frame: unknown): Record<string, string> | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  let out: Record<string, string> | undefined
  for (const [name, value] of Object.entries(frame)) {
    const lower = name.toLowerCase()
    if (value == null || !PROTOCOL_CALL_LOWER.includes(lower)) continue
    ;(out ??= {})[lower] = String(value)
  }
  return out
}

// ─── announce() hook factory ───────────────────────────────────────────────
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
//       create: [announce((result, ctx) =>
//         app.channel(`workspace:${ctx.user?.workspace_id}`)
//       )],
//     }
//   })
//
// Strip sensitive fields before broadcast:
//   after: {
//     create: [
//       async (ctx) => { ctx.dispatch = { ...(ctx.result as User), password_hash: undefined } },
//       announce(fn),
//     ]
//   }
//
// Suppress broadcast entirely for this call:
//   ctx.dispatch = false
//
// Event name defaults to '<service> <method>' e.g. 'notes created'.
// Override: announce(fn, 'note:published')

export function announce<T = unknown>(
  fn:     AnnounceFn<T>,
  event?: string
): import('../core/hooks.ts').Hook {

  // Named so the dev-mode "anonymous hook" warning stays about USER hooks, and
  // so the telemetry waterfall reads 'announce' rather than 'anonymous'.
  const hook = async function announce(ctx: ServiceContext): Promise<void> {

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

    await manager.announce(eventName, payload, ctx, fn)
  }

  return markAnnounceHook(hook)
}
